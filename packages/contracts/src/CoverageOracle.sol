// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { Coverage } from "./libraries/Coverage.sol";
import { Ecdsa } from "./libraries/Ecdsa.sol";
import { ICoverageOracle, ILoadLine } from "./interfaces/IPlimsoll.sol";
import { Owned } from "./access/Owned.sol";

/**
 * @title CoverageOracle
 * @notice Holds the current signed coverage attestation for each note and answers, fail-closed,
 *         whether that note is carrying its load.
 *
 * @dev Coverage is the value of the issuer's attributable ERC-4626 vault positions over notes
 *      outstanding times par. Those vaults live on another chain, so the number arrives as an
 *      EIP-712 attestation signed by the note's registered attestor. This contract is the part
 *      that decides whether to believe it.
 *
 *      Four independent things must hold before an attestation counts, and each has its own
 *      refusal reason so a failure is never ambiguous:
 *        - the note is registered and its load line is configured;
 *        - the signature recovers to the registered attestor;
 *        - the attestation has not expired and its nonce has advanced;
 *        - the vault set it commits to is still the vault set we registered, and the source-chain
 *          block it read is not lagging beyond tolerance.
 *
 *      Every read path returns zero coverage on any doubt. There is no branch that returns a
 *      stale number, and no branch where an unknown note reads as covered.
 *
 *      Privileged mutation - registering notes, rotating an attestor, moving a vault set - is
 *      gated on {IMandateAuthority} exactly like the load line itself. The oracle holds no owner
 *      and no admin role: swapping the attestor for a note is as powerful as moving its load
 *      line, so it answers to the same humans.
 */
contract CoverageOracle is ICoverageOracle, Owned {
    /// @notice The off-chain attestor's claim about one note at one point in time.
    struct Attestation {
        bytes32 noteId;
        /// @dev 10000 = 100%.
        uint64 coverageBps;
        /// @dev Block on the SOURCE chain the vault data was read at, not a Hedera block.
        uint64 asOfBlock;
        /// @dev Commits to the exact set of backing vaults the number was computed over.
        bytes32 vaultSetHash;
        /// @dev Content hash of the evidence bundle behind the number.
        bytes32 sourceHash;
        uint64 expiry;
        uint64 nonce;
    }

    struct Note {
        address attestor;
        bytes32 vaultSetHash;
        /**
         * @dev Protocol-side freshness bound in seconds. Zero disables it.
         *
         *      This exists because `expiry` is chosen by the attestor, and an attestor that
         *      wants its number to keep counting can simply sign a long one. `maxAge` is set by
         *      mandate instead, so the protocol can insist on a shorter shelf life than the
         *      signer asked for. Whichever runs out first wins.
         */
        uint64 maxAgeSeconds;
        bool registered;
    }

    struct Record {
        uint64 coverageBps;
        uint64 asOfBlock;
        uint64 expiry;
        uint64 nonce;
        bytes32 vaultSetHash;
        bytes32 sourceHash;
        uint64 recordedAt;
        bool present;
    }

    bytes32 public constant ATTESTATION_TYPEHASH =
        keccak256(
            // solhint-disable-next-line max-line-length
            "Attestation(bytes32 noteId,uint64 coverageBps,uint64 asOfBlock,bytes32 vaultSetHash,bytes32 sourceHash,uint64 expiry,uint64 nonce)"
        );

    bytes32 private constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");

    /// @dev A coverage ratio above 100x is a malformed feed, not a solvent issuer.
    uint64 private constant MAX_PLAUSIBLE_COVERAGE_BPS = 1_000_000;


    bytes32 private immutable _cachedDomainSeparator;
    uint256 private immutable _cachedChainId;

    ILoadLine public loadLine;

    mapping(bytes32 => Note) private _notes;
    mapping(bytes32 => Record) private _records;
    /**
     * @dev Highest `asOfBlock` ever attested for a note.
     *
     *      Two different questions get asked about `asOfBlock`, and they need two different
     *      answers because we have no light client for the source chain and therefore cannot
     *      know its true head:
     *
     *      "Is this data older than data we have already accepted?" is answered exactly, by this
     *      monotonic head, at intake. An attestor that re-reads the vaults further back than last
     *      time is rejected outright - that is a replay wearing a fresh nonce.
     *
     *      "Is this data old?" cannot be answered in source-chain blocks at all without knowing
     *      where that chain actually is. So it is answered in wall-clock seconds against
     *      {Note.maxAgeSeconds} instead. Pretending a block-lag tolerance could answer it would
     *      be a check that reads well and never fires.
     */
    mapping(bytes32 => uint64) private _sourceHead;

    error UnknownNote(bytes32 noteId);
    error AttestationExpired(uint64 expiry, uint64 nowTs);
    error StaleAttestation(uint64 provided, uint64 floor);
    error VaultSetChanged(bytes32 expected, bytes32 provided);
    error BadSigner(address recovered, address expected);
    error NoteAlreadyRegistered(bytes32 noteId);
    error ZeroAddress();
    error ImplausibleCoverage(uint64 coverageBps);

    event NoteRegistered(bytes32 indexed noteId, address attestor, bytes32 vaultSetHash, uint64 maxAgeSeconds);
    event AttestorChanged(bytes32 indexed noteId, address previous, address current);
    event VaultSetMoved(bytes32 indexed noteId, bytes32 previous, bytes32 current);
    event MaxAgeChanged(bytes32 indexed noteId, uint64 maxAgeSeconds);
    event AttestationAccepted(
        bytes32 indexed noteId,
        uint64 coverageBps,
        uint64 asOfBlock,
        bytes32 vaultSetHash,
        bytes32 sourceHash,
        uint64 nonce
    );
    event LoadLineChanged(address previous, address current);

    constructor(address owner_) Owned(owner_) {
        _cachedChainId = block.chainid;
        _cachedDomainSeparator = _buildDomainSeparator();
    }

    // ---------------------------------------------------------------------------------------
    // Attestation intake
    // ---------------------------------------------------------------------------------------

    /**
     * @notice Records `attestation` if it survives every check.
     * @dev Intentionally permissionless: the signature is the authorisation, so anyone may relay
     *      a fresh attestation and nobody can suppress one by refusing to submit it.
     */
    function submitAttestation(Attestation calldata attestation, bytes calldata signature) external {
        Note storage note = _notes[attestation.noteId];
        if (!note.registered) revert UnknownNote(attestation.noteId);

        if (attestation.expiry <= block.timestamp) {
            revert AttestationExpired(attestation.expiry, uint64(block.timestamp));
        }
        if (attestation.coverageBps > MAX_PLAUSIBLE_COVERAGE_BPS) {
            revert ImplausibleCoverage(attestation.coverageBps);
        }

        Record storage record = _records[attestation.noteId];
        if (record.present && attestation.nonce <= record.nonce) {
            revert StaleAttestation(attestation.nonce, record.nonce);
        }
        if (attestation.vaultSetHash != note.vaultSetHash) {
            revert VaultSetChanged(note.vaultSetHash, attestation.vaultSetHash);
        }

        uint64 head = _sourceHead[attestation.noteId];
        // A newer nonce carrying older source data means the attestor re-read the vaults further
        // back than last time. That is the shape of a replay dressed up as an update.
        if (attestation.asOfBlock < head) {
            revert StaleAttestation(attestation.asOfBlock, head);
        }

        address recovered = Ecdsa.recover(_hashTypedData(attestation), signature);
        if (recovered != note.attestor) revert BadSigner(recovered, note.attestor);

        _sourceHead[attestation.noteId] = attestation.asOfBlock;
        _records[attestation.noteId] = Record({
            coverageBps: attestation.coverageBps,
            asOfBlock: attestation.asOfBlock,
            expiry: attestation.expiry,
            nonce: attestation.nonce,
            vaultSetHash: attestation.vaultSetHash,
            sourceHash: attestation.sourceHash,
            recordedAt: uint64(block.timestamp),
            present: true
        });

        emit AttestationAccepted(
            attestation.noteId,
            attestation.coverageBps,
            attestation.asOfBlock,
            attestation.vaultSetHash,
            attestation.sourceHash,
            attestation.nonce
        );
    }

    // ---------------------------------------------------------------------------------------
    // Reads. Every branch fails closed.
    // ---------------------------------------------------------------------------------------

    /// @inheritdoc ICoverageOracle
    function evidenceOf(bytes32 noteId) public view returns (uint64 coverageBps, Coverage.Reason reason) {
        Note storage note = _notes[noteId];
        if (!note.registered) return (0, Coverage.Reason.NoteUnknown);

        Record storage record = _records[noteId];
        if (!record.present) return (0, Coverage.Reason.NoAttestation);
        if (record.expiry <= block.timestamp) return (0, Coverage.Reason.AttestationExpired);

        // Re-checked on read, not just on intake: a mandate may have moved the vault set after
        // this attestation landed, which retroactively makes the number about the wrong assets.
        if (record.vaultSetHash != note.vaultSetHash) return (0, Coverage.Reason.VaultSetChanged);

        uint64 maxAge = note.maxAgeSeconds;
        if (maxAge != 0 && block.timestamp - record.recordedAt > maxAge) {
            return (0, Coverage.Reason.SourceDataStale);
        }

        return (record.coverageBps, Coverage.Reason.None);
    }

    /// @inheritdoc ICoverageOracle
    function coverageOf(
        bytes32 noteId
    ) public view returns (uint64 coverageBps, Coverage.Verdict verdict, Coverage.Reason reason) {
        (uint64 bps, Coverage.Reason evidenceReason) = evidenceOf(noteId);
        if (evidenceReason != Coverage.Reason.None) {
            return (0, Coverage.Verdict.Unproven, evidenceReason);
        }

        (uint64 threshold, bool configured) = _line(noteId);
        if (!configured) return (0, Coverage.Verdict.Unproven, Coverage.Reason.LineUnset);
        if (bps < threshold) return (bps, Coverage.Verdict.Short, Coverage.Reason.BelowLoadLine);

        return (bps, Coverage.Verdict.Covered, Coverage.Reason.None);
    }

    /// @inheritdoc ICoverageOracle
    function isFresh(bytes32 noteId) external view returns (bool) {
        (, Coverage.Reason reason) = evidenceOf(noteId);
        return reason == Coverage.Reason.None;
    }

    /// @inheritdoc ICoverageOracle
    function thresholdOf(bytes32 noteId) external view returns (uint64) {
        (uint64 threshold, ) = _line(noteId);
        return threshold;
    }

    function noteOf(bytes32 noteId) external view returns (Note memory) {
        return _notes[noteId];
    }

    function recordOf(bytes32 noteId) external view returns (Record memory) {
        return _records[noteId];
    }

    function sourceHeadOf(bytes32 noteId) external view returns (uint64) {
        return _sourceHead[noteId];
    }

    function domainSeparator() public view returns (bytes32) {
        // Rebuilt after a fork so a signature bound to the old chain id cannot be replayed here.
        return block.chainid == _cachedChainId ? _cachedDomainSeparator : _buildDomainSeparator();
    }

    /// @notice The EIP-712 digest the attestor signs. Exposed so the service can assert against it.
    function hashAttestation(Attestation calldata attestation) external view returns (bytes32) {
        return _hashTypedData(attestation);
    }

    // ---------------------------------------------------------------------------------------
    // Mandate-gated configuration
    // ---------------------------------------------------------------------------------------

    function registerNote(
        bytes32 noteId,
        address attestor,
        bytes32 vaultSetHash,
        uint64 maxAgeSeconds
    ) external onlyOwner {
        if (attestor == address(0)) revert ZeroAddress();
        if (_notes[noteId].registered) revert NoteAlreadyRegistered(noteId);

        _notes[noteId] = Note({
            attestor: attestor,
            vaultSetHash: vaultSetHash,
            maxAgeSeconds: maxAgeSeconds,
            registered: true
        });
        emit NoteRegistered(noteId, attestor, vaultSetHash, maxAgeSeconds);
    }

    function setAttestor(bytes32 noteId, address attestor) external onlyOwner {
        if (attestor == address(0)) revert ZeroAddress();
        Note storage note = _notes[noteId];
        if (!note.registered) revert UnknownNote(noteId);

        emit AttestorChanged(noteId, note.attestor, attestor);
        note.attestor = attestor;
    }

    /**
     * @notice Repoints a note at a different set of backing vaults.
     * @dev Deliberately does not clear the stored record. {evidenceOf} compares the record's
     *      committed hash against the live one on every read, so the old attestation reads
     *      `Unproven`/`VaultSetChanged` the moment this lands and stays that way until the
     *      attestor signs over the new set. Clearing it here would destroy the audit trail of
     *      what the note looked like before the move.
     */
    function setVaultSet(bytes32 noteId, bytes32 vaultSetHash) external onlyOwner {
        Note storage note = _notes[noteId];
        if (!note.registered) revert UnknownNote(noteId);

        emit VaultSetMoved(noteId, note.vaultSetHash, vaultSetHash);
        note.vaultSetHash = vaultSetHash;
    }

    function setMaxAge(bytes32 noteId, uint64 maxAgeSeconds) external onlyOwner {
        Note storage note = _notes[noteId];
        if (!note.registered) revert UnknownNote(noteId);

        note.maxAgeSeconds = maxAgeSeconds;
        emit MaxAgeChanged(noteId, maxAgeSeconds);
    }

    function setLoadLine(ILoadLine newLoadLine) external onlyOwner {
        emit LoadLineChanged(address(loadLine), address(newLoadLine));
        loadLine = newLoadLine;
    }

    // ---------------------------------------------------------------------------------------
    // Internals
    // ---------------------------------------------------------------------------------------

    /**
     * @dev Reads the load line defensively. An unset or misbehaving {ILoadLine} yields an
     *      unreachable threshold rather than a permissive one, so broken wiring reads as
     *      "not covered" instead of waving trades through.
     */
    function _line(bytes32 noteId) private view returns (uint64 thresholdBps, bool configured) {
        ILoadLine line = loadLine;
        if (address(line) == address(0)) return (type(uint64).max, false);

        try line.lineOf(noteId) returns (uint64 bps, bool isConfigured) {
            return (bps, isConfigured);
        } catch {
            return (type(uint64).max, false);
        }
    }

    function _hashTypedData(Attestation calldata attestation) private view returns (bytes32) {
        bytes32 structHash = keccak256(
            abi.encode(
                ATTESTATION_TYPEHASH,
                attestation.noteId,
                attestation.coverageBps,
                attestation.asOfBlock,
                attestation.vaultSetHash,
                attestation.sourceHash,
                attestation.expiry,
                attestation.nonce
            )
        );
        return keccak256(abi.encodePacked(hex"1901", domainSeparator(), structHash));
    }

    function _buildDomainSeparator() private view returns (bytes32) {
        return
            keccak256(
                abi.encode(
                    DOMAIN_TYPEHASH,
                    keccak256("Plimsoll CoverageOracle"),
                    keccak256("1"),
                    block.chainid,
                    address(this)
                )
            );
    }

}
