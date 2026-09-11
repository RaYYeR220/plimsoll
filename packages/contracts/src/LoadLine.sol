// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { Coverage } from "./libraries/Coverage.sol";
import { ICoverageOracle, ILoadLine } from "./interfaces/IPlimsoll.sol";
import { IMandateAuthority } from "./interfaces/IMandateAuthority.sol";
import { Owned } from "./access/Owned.sol";

/**
 * @title LoadLine
 * @notice The mark on the hull. Below the line the ship sails; past it the authorities do not
 *         let it leave port.
 *
 * @dev Two pieces of state per note - the coverage threshold and whether a human has halted it -
 *      and one composite read, {status}, that every settlement path in the protocol consults.
 *
 *      Neither piece of state can be moved by an ordinary key. Both go through
 *      {IMandateAuthority}, which in this deployment is a MandateVerifierAdapter over a verifier
 *      that recovers an EIP-191 signature a person produced on a hardware device. There is no
 *      second door to halt, resume, or move a line.
 *
 *      Two costs, both real, both stated rather than glossed. A mandate authority that becomes
 *      unavailable freezes every threshold at its current value - notes keep trading under the
 *      last approved line rather than falling open, which is the right direction to fail, but it
 *      is a liveness dependency. And the owner can repoint this contract at a different
 *      authority: deployment administration is owner-controlled, so the honest description is
 *      "the device approves load-line changes", not "nobody can bypass the device".
 *
 *      Ordering inside {status} is deliberate. A halt is checked first because it is a human
 *      decision that outranks any number. Evidence quality is checked before the number itself,
 *      because "we cannot see this issuer" must never be reported as "this issuer is short".
 */
contract LoadLine is ILoadLine, Owned {
    struct Line {
        uint64 thresholdBps;
        bool halted;
        bool configured;
    }

    bytes32 public constant ACTION_SET_THRESHOLD = keccak256("PLIMSOLL_LOADLINE_SET_THRESHOLD");
    bytes32 public constant ACTION_HALT = keccak256("PLIMSOLL_LOADLINE_HALT");
    bytes32 public constant ACTION_RESUME = keccak256("PLIMSOLL_LOADLINE_RESUME");

    IMandateAuthority public mandateAuthority;
    ICoverageOracle public oracle;

    mapping(bytes32 => Line) private _lines;

    error ZeroAddress();
    error AuthorityNotAContract(address authority);
    error NoteHalted(bytes32 noteId);
    error BelowLoadLine(bytes32 noteId, uint64 coverageBps, uint64 thresholdBps);
    error CoverageUnproven(bytes32 noteId, Coverage.Reason reason);
    error ThresholdOutOfRange(uint64 thresholdBps);

    event ThresholdSet(bytes32 indexed noteId, uint64 previousBps, uint64 currentBps);
    event Halted(bytes32 indexed noteId, address indexed by);
    event Resumed(bytes32 indexed noteId, address indexed by);
    event OracleChanged(address previous, address current);
    event MandateAuthorityChanged(address previous, address current);

    constructor(IMandateAuthority authority, address owner_) Owned(owner_) {
        if (address(authority) == address(0)) revert ZeroAddress();
        _requireContract(address(authority));
        mandateAuthority = authority;
    }

    // ---------------------------------------------------------------------------------------
    // The gate
    // ---------------------------------------------------------------------------------------

    /// @inheritdoc ILoadLine
    function status(
        bytes32 noteId
    )
        public
        view
        returns (
            bool clear,
            Coverage.Verdict verdict,
            Coverage.Reason reason,
            uint64 coverageBps,
            uint64 thresholdBps
        )
    {
        Line storage line = _lines[noteId];

        if (line.halted) {
            return (false, Coverage.Verdict.Unproven, Coverage.Reason.AuthorityHalt, 0, line.thresholdBps);
        }
        if (!line.configured) {
            return (false, Coverage.Verdict.Unproven, Coverage.Reason.LineUnset, 0, type(uint64).max);
        }

        ICoverageOracle o = oracle;
        if (address(o) == address(0)) {
            return (false, Coverage.Verdict.Unproven, Coverage.Reason.NoAttestation, 0, line.thresholdBps);
        }

        // A reverting or absent oracle must read as "no evidence", never as a clear line.
        try o.coverageOf(noteId) returns (uint64 bps, Coverage.Verdict v, Coverage.Reason r) {
            return (v == Coverage.Verdict.Covered, v, r, bps, line.thresholdBps);
        } catch {
            return (false, Coverage.Verdict.Unproven, Coverage.Reason.NoAttestation, 0, line.thresholdBps);
        }
    }

    /// @inheritdoc ILoadLine
    function requireClear(bytes32 noteId) external view {
        (bool clear, , Coverage.Reason reason, uint64 coverageBps, uint64 thresholdBps) = status(noteId);
        if (clear) return;

        if (reason == Coverage.Reason.AuthorityHalt) revert NoteHalted(noteId);
        if (reason == Coverage.Reason.BelowLoadLine) revert BelowLoadLine(noteId, coverageBps, thresholdBps);
        revert CoverageUnproven(noteId, reason);
    }

    /// @inheritdoc ILoadLine
    function lineOf(bytes32 noteId) external view returns (uint64 thresholdBps, bool configured) {
        Line storage line = _lines[noteId];
        return line.configured ? (line.thresholdBps, true) : (type(uint64).max, false);
    }

    /// @inheritdoc ILoadLine
    function isHalted(bytes32 noteId) external view returns (bool) {
        return _lines[noteId].halted;
    }

    // ---------------------------------------------------------------------------------------
    // Mandate-gated authority actions
    // ---------------------------------------------------------------------------------------

    /**
     * @notice Moves the load line to `thresholdBps`.
     * @dev The number written is bound to the mandate: it is passed to the authority, which must
     *      revert unless the human approved exactly this value. So a mandate signed for one line
     *      cannot be spent writing another - the transaction fails before the write, rather than
     *      succeeding and being caught afterwards.
     */
    function setThreshold(bytes32 noteId, uint64 thresholdBps, bytes calldata proof) external {
        // A zero line is not a load line, it is the absence of one, and would let a note with
        // proven zero coverage settle. Refuse it rather than silently permitting everything.
        if (thresholdBps == 0 || thresholdBps > 1_000_000) revert ThresholdOutOfRange(thresholdBps);
        mandateAuthority.requireMandate(ACTION_SET_THRESHOLD, noteId, thresholdBps, proof);

        Line storage line = _lines[noteId];
        emit ThresholdSet(noteId, line.configured ? line.thresholdBps : 0, thresholdBps);
        line.thresholdBps = thresholdBps;
        line.configured = true;
    }

    function halt(bytes32 noteId, bytes calldata proof) external {
        mandateAuthority.requireMandate(ACTION_HALT, noteId, 0, proof);
        _lines[noteId].halted = true;
        emit Halted(noteId, msg.sender);
    }

    function resume(bytes32 noteId, bytes calldata proof) external {
        mandateAuthority.requireMandate(ACTION_RESUME, noteId, 0, proof);
        _lines[noteId].halted = false;
        emit Resumed(noteId, msg.sender);
    }

    /// @dev Owner-gated, not mandated: an address argument does not belong on a device screen.
    function setOracle(ICoverageOracle newOracle) external onlyOwner {
        emit OracleChanged(address(oracle), address(newOracle));
        oracle = newOracle;
    }

    /// @dev Owner-gated. This is the sharpest edge of the owner/mandate split: an owner who
    ///      repoints the authority governs the load line too. The README says so in those words.
    function setMandateAuthority(IMandateAuthority newAuthority) external onlyOwner {
        if (address(newAuthority) == address(0)) revert ZeroAddress();
        _requireContract(address(newAuthority));
        emit MandateAuthorityChanged(address(mandateAuthority), address(newAuthority));
        mandateAuthority = newAuthority;
    }

    /**
     * @dev Rejects an authority with no code.
     *
     *      `requireMandate` returns nothing, and Solidity only emits an `extcodesize` check for
     *      external calls whose return data it has to decode. A call into an address with no code
     *      therefore *succeeds silently* - so an authority set to an EOA, a wrong address, or a
     *      contract that has since been destroyed would make every mandate check pass. That is
     *      the one configuration mistake in this system that fails open, so it is refused here.
     */
    function _requireContract(address account) private view {
        if (account.code.length == 0) revert AuthorityNotAContract(account);
    }
}
