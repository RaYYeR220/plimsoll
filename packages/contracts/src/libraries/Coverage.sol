// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/**
 * @title Coverage
 * @notice Shared vocabulary for every coverage decision in the protocol.
 * @dev The split between {Verdict.Short} and {Verdict.Unproven} is the point of this file.
 *      `Short` is a finding about the asset: we have good evidence and the evidence says the
 *      issuer is under-collateralised. `Unproven` is a statement about our own evidence: the
 *      attestation expired, the source data lagged, the backing set moved, nobody ever attested.
 *      Both refuse to settle, but they are not the same claim and a venue that conflates them is
 *      lying to one side or the other. Keeping them apart on-chain lets the UI say "this issuer is
 *      short" versus "we cannot currently see this issuer" without inventing its own vocabulary.
 */
library Coverage {
    enum Verdict {
        Covered,
        Short,
        Unproven
    }

    enum Reason {
        None,
        /// @dev Verdict.Short — a finding about the asset.
        BelowLoadLine,
        /// @dev Everything below is Verdict.Unproven — a statement about our evidence.
        NoteUnknown,
        NoAttestation,
        AttestationExpired,
        SourceDataStale,
        VaultSetChanged,
        LineUnset,
        /// @dev Authority stop. Not an evidence failure and not a coverage finding: a human said no.
        AuthorityHalt
    }

    /**
     * @notice True when the refusal is about the quality of our evidence rather than the asset.
     * @dev Callers use this to phrase the refusal. Never use it to decide whether to settle:
     *      every non-`None` reason blocks settlement.
     */
    function isEvidenceFailure(Reason reason) internal pure returns (bool) {
        return
            reason == Reason.NoteUnknown ||
            reason == Reason.NoAttestation ||
            reason == Reason.AttestationExpired ||
            reason == Reason.SourceDataStale ||
            reason == Reason.VaultSetChanged ||
            reason == Reason.LineUnset;
    }
}
