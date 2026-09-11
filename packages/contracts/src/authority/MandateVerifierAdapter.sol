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
 *      **Known limit, stated rather than hidden.** `requireMandate` authorises *that* an action
 *      happens on a subject; it does not see the value being written. For halt and resume there
 *      is no value, so the mapping is exact. For a threshold change the verifier records the
 *      mandated `loadLineBps` itself, and {mandatedThreshold} exposes it - so the honest way to
 *      read a note's load line is from the verifier, and a `LoadLine` threshold that disagrees
 *      with {mandatedThreshold} means somebody wrote a number the human did not approve.
 *      {assertThresholdMatchesMandate} is the check that catches it.
 */
contract MandateVerifierAdapter is IMandateAuthority {
    /// @dev Must match the action constants LoadLine gates on.
    bytes32 public constant ACTION_SET_THRESHOLD = keccak256("PLIMSOLL_LOADLINE_SET_THRESHOLD");
    bytes32 public constant ACTION_HALT = keccak256("PLIMSOLL_LOADLINE_HALT");
    bytes32 public constant ACTION_RESUME = keccak256("PLIMSOLL_LOADLINE_RESUME");

    MandateVerifier public immutable verifier;

    /// @notice noteId (the market-code hash) to the human-readable code the device displays.
    mapping(bytes32 => string) private _marketOf;

    error ZeroAddress();
    error UnsupportedAction(bytes32 action);
    error MarketMismatch(bytes32 subject, bytes32 mandateMarketKey);
    error MarketNotRegistered(bytes32 subject);
    error MarketAlreadyRegistered(bytes32 subject);
    error ThresholdNotMandated(bytes32 subject, uint64 written, uint32 mandated);

    event MarketRegistered(bytes32 indexed noteId, string market);

    constructor(MandateVerifier verifier_) {
        if (address(verifier_) == address(0)) revert ZeroAddress();
        verifier = verifier_;
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
    function requireMandate(bytes32 action, bytes32 subject, bytes calldata proof) external {
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
     * @dev The reconciliation for the one thing {requireMandate} structurally cannot check.
     *      Monitoring should call this after every threshold change; a revert means a number
     *      reached the load line that no human signed for.
     */
    function assertThresholdMatchesMandate(bytes32 noteId, uint64 written) external view {
        (uint32 mandated, bool listed) = mandatedThreshold(noteId);
        if (!listed || uint64(mandated) != written) {
            revert ThresholdNotMandated(noteId, written, mandated);
        }
    }
}
