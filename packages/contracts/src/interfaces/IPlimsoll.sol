// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { Coverage } from "../libraries/Coverage.sol";

/**
 * @title ICoverageOracle
 * @notice Read surface for coverage evidence. Every branch fails closed.
 */
interface ICoverageOracle {
    /**
     * @notice Coverage evidence for `noteId` ignoring the load line.
     * @return coverageBps Attested coverage, 10000 = 100%. Zero whenever `reason != None`.
     * @return reason      `None` when the evidence stands on its own; otherwise why it does not.
     */
    function evidenceOf(bytes32 noteId) external view returns (uint64 coverageBps, Coverage.Reason reason);

    /**
     * @notice Coverage evidence for `noteId` judged against the note's load line.
     * @return coverageBps Attested coverage, 10000 = 100%. Zero whenever `verdict != Covered`.
     * @return verdict     `Covered`, `Short` (a finding about the asset), or `Unproven` (a
     *                     statement about our evidence).
     * @return reason      The shared refusal vocabulary, for the UI and the revert alike.
     */
    function coverageOf(
        bytes32 noteId
    ) external view returns (uint64 coverageBps, Coverage.Verdict verdict, Coverage.Reason reason);

    /// @notice True only when a live, in-tolerance, vault-set-matching attestation exists.
    function isFresh(bytes32 noteId) external view returns (bool);

    /// @notice The note's load line in bps, read through to {ILoadLine}.
    function thresholdOf(bytes32 noteId) external view returns (uint64 thresholdBps);
}

/**
 * @title ILoadLine
 * @notice The authority gate. Past the line the market refuses to settle.
 */
interface ILoadLine {
    /**
     * @notice The composite gate every settlement path consults.
     * @return clear       True only when the note may trade and pay.
     * @return verdict     Coverage verdict, or `Unproven` when a human has halted the note.
     * @return reason      Why, in the shared vocabulary.
     * @return coverageBps Attested coverage when known, else zero.
     * @return thresholdBps The configured load line, or `type(uint64).max` when unset.
     */
    function status(
        bytes32 noteId
    )
        external
        view
        returns (
            bool clear,
            Coverage.Verdict verdict,
            Coverage.Reason reason,
            uint64 coverageBps,
            uint64 thresholdBps
        );

    /// @notice Reverts unless {status} is clear. The one call every settlement path must make.
    function requireClear(bytes32 noteId) external view;

    /// @notice The note's load line in bps, and whether one has been configured at all.
    function lineOf(bytes32 noteId) external view returns (uint64 thresholdBps, bool configured);

    /// @notice True when a mandate has stopped this note regardless of coverage.
    function isHalted(bytes32 noteId) external view returns (bool);
}
