// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { IMandateAuthority } from "../interfaces/IMandateAuthority.sol";
import { MandateVerifier } from "./MandateVerifier.sol";

/**
 * @title MandateVerifierAdapter
 * @notice Makes {MandateVerifier} answer to {IMandateAuthority}, so {LoadLine} can be gated on a
 *         mandate a human physically approved on a device.
 *
 * @dev This adapter holds no authority of its own. It decodes the mandate and signature out of
 *      `proof`, hands both to the verifier, and lets the verifier decide. Every rejection - a
 *      wrong signer, a used nonce, an expired deadline, a market nobody listed, a load line that
 *      moved underneath the approval - surfaces as the verifier's own named error, unchanged.
 *
 *      **Why the market code travels inside `proof` and not as `subject`.** The point of the
 *      mandate is that a person reads a market *name* on a device screen and presses a button.
 *      A `bytes32` is not readable, so the human-facing string has to be the thing that gets
 *      signed. `subject` is the commitment that lets this side check the two agree: the adapter
 *      requires `keccak256(bytes(mandate.market)) == subject`, so the note that {LoadLine} is
 *      about to act on is provably the market the human saw. Get that backwards - pass the hash
 *      to the device and the string to the chain - and the signature stops meaning anything.
 *
 *      **Market codes are validated, not trusted.** The Ethereum app reflows newlines into
 *      spaces and wraps greedily, so a human never sees the mandate's line structure and a market
 *      code containing `NONCE: 9` would render as a mandate with two nonces. The verifier's
 *      charset rule - uppercase alphanumerics with single interior hyphens, at most 24
 *      characters - is what makes that injection impossible, and {registerMarket} runs a code
 *      through the verifier's own validator before this contract will ever bind it to a note.
 *
 *      **There is one door, and it is LoadLine.** This adapter carries mandates only for the
 *      LoadLine it was built around, and it creates its own verifier, which records this adapter as
 *      its sole caller at birth. A correctly signed mandate submitted straight to the verifier, or
 *      straight to this adapter, is refused before its nonce is touched. That matters because
 *      either door would otherwise let a mandate be spent without LoadLine's state moving with it -
 *      and for a halt, that fails open.
 *
 *      **The value is bound, not just the action.** A threshold mandate carries the load line
 *      the human read on the device. {LoadLine} passes the number it is about to write, and this
 *      adapter reverts with {MandateValueMismatch} unless the two are identical - before the
 *      verifier consumes the mandate and before LoadLine writes anything. A mandate signed for
 *      95.00% therefore cannot be spent writing 90.00%: the transaction fails, the nonce survives,
 *      and the same mandate can still be used for the value it actually approved. Halt and resume
 *      write no number, so their `value` is unused.
 */
contract MandateVerifierAdapter is IMandateAuthority {
    /// @dev Must match the action constants LoadLine gates on.
    bytes32 public constant ACTION_SET_THRESHOLD = keccak256("PLIMSOLL_LOADLINE_SET_THRESHOLD");
    bytes32 public constant ACTION_HALT = keccak256("PLIMSOLL_LOADLINE_HALT");
    bytes32 public constant ACTION_RESUME = keccak256("PLIMSOLL_LOADLINE_RESUME");

    MandateVerifier public immutable verifier;
    /// @notice The only caller whose mandates this adapter will carry.
    address public immutable loadLine;

    /// @notice noteId (the market-code hash) to the human-readable code the device displays.
    mapping(bytes32 => string) private _marketOf;

    error ZeroAddress();
    error NotLoadLine(address caller);
    error UnsupportedAction(bytes32 action);
    error MarketMismatch(bytes32 subject, bytes32 mandateMarketKey);
    error MarketNotRegistered(bytes32 subject);
    error MarketAlreadyRegistered(bytes32 subject);
    error ThresholdNotMandated(bytes32 subject, uint64 written, uint32 mandated);
    error MandateValueMismatch(bytes32 subject, uint256 written, uint32 mandated);

    event MarketRegistered(bytes32 indexed noteId, string market);

    /**
     * @param authority_ The device key the verifier will trust.
     * @param loadLine_  The LoadLine this adapter serves, and the only caller it accepts.
     * @dev The verifier is created here rather than passed in, so it records this adapter as its
     *      sole caller in the same transaction that creates it. Neither contract ever exists in a
     *      state where it answers to anyone else, and there is no setter to race.
     */
    constructor(address authority_, address loadLine_) {
        if (authority_ == address(0) || loadLine_ == address(0)) revert ZeroAddress();
        loadLine = loadLine_;
        verifier = new MandateVerifier(authority_);
    }

    /**
     * @notice Binds a note id to the market code a human will see on the device.
     * @dev Permissionless and one-way. The binding is `noteId == keccak256(market)`, which the
     *      verifier's `marketKey` both computes and validates, so there is nothing to authorise -
     *      only one string can ever map to a given note id, and a malformed one cannot map at
     *      all. Registering it up front just means the code is recoverable for display later.
     */
    function registerMarket(string calldata market) external returns (bytes32 noteId) {
        // Reverts with BadMarketCode on anything outside the charset, which is what stops a
        // delimiter-injecting code from ever reaching a device screen.
        noteId = verifier.marketKey(market);
        if (bytes(_marketOf[noteId]).length != 0) revert MarketAlreadyRegistered(noteId);

        _marketOf[noteId] = market;
        emit MarketRegistered(noteId, market);
    }

    function marketOf(bytes32 noteId) external view returns (string memory) {
        return _marketOf[noteId];
    }

    /// @inheritdoc IMandateAuthority
    function requireMandate(bytes32 action, bytes32 subject, uint256 value, bytes calldata proof) external {
        if (msg.sender != loadLine) revert NotLoadLine(msg.sender);
        (MandateVerifier.Mandate memory mandate, bytes memory signature) = abi.decode(
            proof,
            (MandateVerifier.Mandate, bytes)
        );

        // The commitment: the market the human approved is the note being acted on.
        bytes32 marketKey = keccak256(bytes(mandate.market));
        if (marketKey != subject) revert MarketMismatch(subject, marketKey);

        if (action == ACTION_HALT) {
            verifier.haltMarket(mandate, signature);
        } else if (action == ACTION_RESUME) {
            verifier.resumeMarket(mandate, signature);
        } else if (action == ACTION_SET_THRESHOLD) {
            // Checked before the verifier runs, so a mismatched write burns nothing and changes
            // nothing: the human's approval is still there to be used for what it approved.
            if (value != mandate.loadLineBps) revert MandateValueMismatch(subject, value, mandate.loadLineBps);
            verifier.setCoverageThreshold(mandate, signature);
        } else {
            // Deployment administration is owner-gated and never reaches here. The mandate format
            // covers exactly three actions about the load line, and widening it to carry an
            // address argument would put raw hex on a device screen nobody reads.
            revert UnsupportedAction(action);
        }
    }

    // -------------------------------------------------------------------------------------
    // Reconciliation
    // -------------------------------------------------------------------------------------

    /// @notice The load line the device actually approved for `noteId`, in bps.
    function mandatedThreshold(bytes32 noteId) public view returns (uint32 loadLineBps, bool listed) {
        string memory market = _marketOf[noteId];
        if (bytes(market).length == 0) revert MarketNotRegistered(noteId);

        MandateVerifier.MarketState memory state = verifier.marketState(market);
        return (state.loadLineBps, state.listed);
    }

    /// @notice True when a human-approved halt is in force for `noteId`.
    function mandatedHalt(bytes32 noteId) external view returns (bool) {
        string memory market = _marketOf[noteId];
        if (bytes(market).length == 0) revert MarketNotRegistered(noteId);
        return verifier.isHalted(market);
    }

    /**
     * @notice Reverts unless `written` is the threshold the device approved for `noteId`.
     * @dev Not the safeguard - {requireMandate} already refuses a mismatched write up front. This
     *      is a monitor for the one path that bypasses it: an owner who repoints LoadLine at a
     *      different authority can write a line the device never saw, and this is how that shows.
     */
    function assertThresholdMatchesMandate(bytes32 noteId, uint64 written) external view {
        (uint32 mandated, bool listed) = mandatedThreshold(noteId);
        if (!listed || uint64(mandated) != written) {
            revert ThresholdNotMandated(noteId, written, mandated);
        }
    }
}
