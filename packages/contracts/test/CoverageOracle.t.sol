// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { Base } from "./Base.t.sol";
import { CoverageOracle } from "../src/CoverageOracle.sol";
import { Coverage } from "../src/libraries/Coverage.sol";
import { Ecdsa } from "../src/libraries/Ecdsa.sol";
import { ILoadLine } from "../src/interfaces/IPlimsoll.sol";
import { Owned } from "../src/access/Owned.sol";

contract CoverageOracleTest is Base {
    function test_AcceptsValidAttestation() public {
        _attest(12_000);

        (uint64 bps, Coverage.Reason reason) = oracle.evidenceOf(NOTE_ID);
        assertEq(bps, 12_000);
        assertEq(uint8(reason), uint8(Coverage.Reason.None));
        assertTrue(oracle.isFresh(NOTE_ID));

        (uint64 covered, Coverage.Verdict verdict, ) = oracle.coverageOf(NOTE_ID);
        assertEq(covered, 12_000);
        assertEq(uint8(verdict), uint8(Coverage.Verdict.Covered));
    }

    // -------------------------------------------------------------- fail-closed read branches

    function test_FailsClosed_UnknownNote() public view {
        (uint64 bps, Coverage.Reason reason) = oracle.evidenceOf(keccak256("never-registered"));
        assertEq(bps, 0);
        assertEq(uint8(reason), uint8(Coverage.Reason.NoteUnknown));
        assertFalse(oracle.isFresh(keccak256("never-registered")));
    }

    function test_FailsClosed_NoAttestationYet() public view {
        (uint64 bps, Coverage.Reason reason) = oracle.evidenceOf(NOTE_ID);
        assertEq(bps, 0);
        assertEq(uint8(reason), uint8(Coverage.Reason.NoAttestation));
    }

    function test_FailsClosed_AttestationExpires() public {
        _attest(12_000);
        assertTrue(oracle.isFresh(NOTE_ID));

        vm.warp(block.timestamp + 2 hours);

        (uint64 bps, Coverage.Reason reason) = oracle.evidenceOf(NOTE_ID);
        assertEq(bps, 0, "an expired attestation must not still report its number");
        assertEq(uint8(reason), uint8(Coverage.Reason.AttestationExpired));
    }

    function test_FailsClosed_VaultSetMovedAfterAttestation() public {
        _attest(12_000);

        // A mandate repoints the note at a different set of backing vaults. The stored number was
        // computed over the old set, so it stops meaning anything about this note.
        oracle.setVaultSet(NOTE_ID, keccak256("vaults/v2"));

        (uint64 bps, Coverage.Reason reason) = oracle.evidenceOf(NOTE_ID);
        assertEq(bps, 0);
        assertEq(uint8(reason), uint8(Coverage.Reason.VaultSetChanged));
    }

    function test_FailsClosed_WhenDataOutlivesTheProtocolsFreshnessBound() public {
        // A five-minute bound, tighter than the hour-long expiry the attestor chose.
        oracle.setMaxAge(NOTE_ID, 300);
        _attest(12_000);
        assertTrue(oracle.isFresh(NOTE_ID));

        vm.warp(block.timestamp + 301);

        (uint64 bps, Coverage.Reason reason) = oracle.evidenceOf(NOTE_ID);
        assertEq(bps, 0);
        assertEq(uint8(reason), uint8(Coverage.Reason.SourceDataStale));
        assertTrue(Coverage.isEvidenceFailure(reason));

        // The attestation itself has not expired - the protocol simply refuses to keep counting
        // a number this old, whatever shelf life the signer asked for.
        CoverageOracle.Record memory rec = oracle.recordOf(NOTE_ID);
        assertGt(rec.expiry, block.timestamp, "expiry has not run out; maxAge is what bit");
    }

    function test_FreshnessBoundIsExactAtTheBoundary() public {
        oracle.setMaxAge(NOTE_ID, 300);
        _attest(12_000);

        vm.warp(block.timestamp + 300);
        (, Coverage.Reason atBound) = oracle.evidenceOf(NOTE_ID);
        assertEq(uint8(atBound), uint8(Coverage.Reason.None), "exactly at the bound is still fresh");

        vm.warp(block.timestamp + 1);
        (, Coverage.Reason pastBound) = oracle.evidenceOf(NOTE_ID);
        assertEq(uint8(pastBound), uint8(Coverage.Reason.SourceDataStale));
    }

    function test_ZeroFreshnessBoundLeavesExpiryAsTheBackstop() public {
        _attest(12_000);
        vm.warp(block.timestamp + 59 minutes);
        assertTrue(oracle.isFresh(NOTE_ID), "no protocol bound is configured");

        vm.warp(block.timestamp + 2 minutes);
        (, Coverage.Reason reason) = oracle.evidenceOf(NOTE_ID);
        assertEq(uint8(reason), uint8(Coverage.Reason.AttestationExpired));
    }

    function test_SourceHeadTracksTheHighestBlockSeen() public {
        CoverageOracle.Attestation memory a = _attestation(12_000);
        a.asOfBlock = 1_000;
        _submit(a, attestorKey);
        assertEq(oracle.sourceHeadOf(NOTE_ID), 1_000);

        CoverageOracle.Attestation memory b = _attestation(11_000);
        b.asOfBlock = 1_050;
        _submit(b, attestorKey);
        assertEq(oracle.sourceHeadOf(NOTE_ID), 1_050);
    }

    function test_FailsClosed_LineUnsetReadsUnproven() public {
        bytes32 other = keccak256("PLIM-B");
        oracle.registerNote(other, attestor, VAULT_SET, MAX_AGE_SECONDS);

        CoverageOracle.Attestation memory a = CoverageOracle.Attestation({
            noteId: other,
            coverageBps: 20_000,
            asOfBlock: 1_000_000,
            vaultSetHash: VAULT_SET,
            sourceHash: SOURCE_HASH,
            expiry: uint64(block.timestamp + 1 hours),
            nonce: 1
        });
        _submit(a, attestorKey);

        // Evidence is fine; there is simply no line to judge it against.
        (, Coverage.Reason evidence) = oracle.evidenceOf(other);
        assertEq(uint8(evidence), uint8(Coverage.Reason.None));

        (uint64 bps, Coverage.Verdict verdict, Coverage.Reason reason) = oracle.coverageOf(other);
        assertEq(bps, 0);
        assertEq(uint8(verdict), uint8(Coverage.Verdict.Unproven));
        assertEq(uint8(reason), uint8(Coverage.Reason.LineUnset));
    }

    function test_FailsClosed_WhenLoadLineUnwired() public {
        _attest(12_000);
        oracle.setLoadLine(ILoadLine(address(0)));

        (uint64 bps, Coverage.Verdict verdict, Coverage.Reason reason) = oracle.coverageOf(NOTE_ID);
        assertEq(bps, 0);
        assertEq(uint8(verdict), uint8(Coverage.Verdict.Unproven));
        assertEq(uint8(reason), uint8(Coverage.Reason.LineUnset));
        assertEq(oracle.thresholdOf(NOTE_ID), type(uint64).max, "an unwired line must be unreachable");
    }

    function test_FailsClosed_WhenLoadLineReverts() public {
        _attest(12_000);
        oracle.setLoadLine(ILoadLine(address(new RevertingLine())));

        (, Coverage.Verdict verdict, Coverage.Reason reason) = oracle.coverageOf(NOTE_ID);
        assertEq(uint8(verdict), uint8(Coverage.Verdict.Unproven));
        assertEq(uint8(reason), uint8(Coverage.Reason.LineUnset));
    }

    // -------------------------------------------------------------- short vs unproven

    function test_ShortIsAFindingNotAnEvidenceFailure() public {
        _attest(9_000); // below the 10,500 line

        (uint64 bps, Coverage.Verdict verdict, Coverage.Reason reason) = oracle.coverageOf(NOTE_ID);
        assertEq(bps, 9_000, "a short note still reports its real coverage");
        assertEq(uint8(verdict), uint8(Coverage.Verdict.Short));
        assertEq(uint8(reason), uint8(Coverage.Reason.BelowLoadLine));
        assertFalse(Coverage.isEvidenceFailure(reason), "being short is a claim about the asset");

        // Evidence is still good: we know the number, we just do not like it.
        assertTrue(oracle.isFresh(NOTE_ID));
    }

    function test_UnprovenIsAnEvidenceFailure() public {
        _attest(12_000);
        vm.warp(block.timestamp + 2 hours);

        (, Coverage.Verdict verdict, Coverage.Reason reason) = oracle.coverageOf(NOTE_ID);
        assertEq(uint8(verdict), uint8(Coverage.Verdict.Unproven));
        assertTrue(Coverage.isEvidenceFailure(reason), "staleness is a claim about our evidence");
        assertFalse(oracle.isFresh(NOTE_ID));
    }

    function test_ExactlyAtTheLineIsCovered() public {
        _attest(THRESHOLD_BPS);
        (, Coverage.Verdict verdict, ) = oracle.coverageOf(NOTE_ID);
        assertEq(uint8(verdict), uint8(Coverage.Verdict.Covered), "the line itself is inside the line");
    }

    function test_OneBipUnderTheLineIsShort() public {
        _attest(THRESHOLD_BPS - 1);
        (, Coverage.Verdict verdict, ) = oracle.coverageOf(NOTE_ID);
        assertEq(uint8(verdict), uint8(Coverage.Verdict.Short));
    }

    // -------------------------------------------------------------- negative controls

    function test_RevertWhen_NonceReplayed() public {
        CoverageOracle.Attestation memory a = _attestation(12_000);
        bytes memory sig = _sign(a, attestorKey);
        oracle.submitAttestation(a, sig);

        vm.expectRevert(abi.encodeWithSelector(CoverageOracle.StaleAttestation.selector, a.nonce, a.nonce));
        oracle.submitAttestation(a, sig);
    }

    function test_RevertWhen_NonceGoesBackwards() public {
        CoverageOracle.Attestation memory first = _attestation(12_000);
        first.nonce = 5;
        _submit(first, attestorKey);

        CoverageOracle.Attestation memory second = _attestation(12_000);
        second.nonce = 4;
        bytes memory sig = _sign(second, attestorKey);
        vm.expectRevert(abi.encodeWithSelector(CoverageOracle.StaleAttestation.selector, uint64(4), uint64(5)));
        oracle.submitAttestation(second, sig);
    }

    function test_RevertWhen_AttestationAlreadyExpired() public {
        CoverageOracle.Attestation memory a = _attestation(12_000);
        a.expiry = uint64(block.timestamp);

        bytes memory sig = _sign(a, attestorKey);
        vm.expectRevert(
            abi.encodeWithSelector(
                CoverageOracle.AttestationExpired.selector,
                a.expiry,
                uint64(block.timestamp)
            )
        );
        oracle.submitAttestation(a, sig);
    }

    function test_RevertWhen_VaultSetSwapped() public {
        CoverageOracle.Attestation memory a = _attestation(12_000);
        a.vaultSetHash = keccak256("a-different-basket");

        bytes memory sig = _sign(a, attestorKey);
        vm.expectRevert(
            abi.encodeWithSelector(CoverageOracle.VaultSetChanged.selector, VAULT_SET, a.vaultSetHash)
        );
        oracle.submitAttestation(a, sig);
    }

    function test_RevertWhen_SignedByWrongKey() public {
        CoverageOracle.Attestation memory a = _attestation(12_000);

        bytes memory sig = _sign(a, rogueKey);
        vm.expectRevert(abi.encodeWithSelector(CoverageOracle.BadSigner.selector, rogue, attestor));
        oracle.submitAttestation(a, sig);
    }

    function test_RevertWhen_SignatureIsForAnotherNote() public {
        bytes32 other = keccak256("PLIM-B");
        oracle.registerNote(other, attestor, VAULT_SET, MAX_AGE_SECONDS);

        CoverageOracle.Attestation memory signedFor = _attestation(12_000);
        bytes memory sig = _sign(signedFor, attestorKey);

        // Same signature, different note id: the digest no longer matches, so recovery drifts.
        CoverageOracle.Attestation memory tampered = signedFor;
        tampered.noteId = other;

        vm.expectRevert();
        oracle.submitAttestation(tampered, sig);
    }

    function test_RevertWhen_CoverageFieldTamperedAfterSigning() public {
        CoverageOracle.Attestation memory a = _attestation(9_000);
        bytes memory sig = _sign(a, attestorKey);

        a.coverageBps = 20_000; // the obvious attack: inflate coverage, reuse the signature
        vm.expectRevert();
        oracle.submitAttestation(a, sig);
    }

    function test_RevertWhen_SourceBlockRegresses() public {
        CoverageOracle.Attestation memory first = _attestation(12_000);
        first.asOfBlock = 2_000_000;
        _submit(first, attestorKey);

        CoverageOracle.Attestation memory second = _attestation(12_000);
        second.asOfBlock = 1_900_000; // newer nonce, older vault data

        bytes memory sig = _sign(second, attestorKey);
        vm.expectRevert(
            abi.encodeWithSelector(
                CoverageOracle.StaleAttestation.selector,
                uint64(1_900_000),
                uint64(2_000_000)
            )
        );
        oracle.submitAttestation(second, sig);
    }

    function test_RevertWhen_MalleableSignatureReplayed() public {
        CoverageOracle.Attestation memory a = _attestation(12_000);
        bytes memory sig = _sign(a, attestorKey);

        // Flip the signature to its mirror: same signer under naive ecrecover, different bytes.
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := mload(add(sig, 0x20))
            s := mload(add(sig, 0x40))
            v := byte(0, mload(add(sig, 0x60)))
        }
        uint256 n = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;
        bytes32 flippedS = bytes32(n - uint256(s));
        uint8 flippedV = v == 27 ? 28 : 27;
        bytes memory malleable = abi.encodePacked(r, flippedS, flippedV);

        vm.expectRevert(abi.encodeWithSelector(CoverageOracle.BadSigner.selector, address(0), attestor));
        oracle.submitAttestation(a, malleable);
    }

    function test_RevertWhen_SubmittingForUnknownNote() public {
        CoverageOracle.Attestation memory a = _attestation(12_000);
        a.noteId = keccak256("ghost");

        bytes memory sig = _sign(a, attestorKey);
        vm.expectRevert(abi.encodeWithSelector(CoverageOracle.UnknownNote.selector, a.noteId));
        oracle.submitAttestation(a, sig);
    }

    function test_RevertWhen_CoverageIsImplausible() public {
        CoverageOracle.Attestation memory a = _attestation(1_000_001);

        bytes memory sig = _sign(a, attestorKey);
        vm.expectRevert(abi.encodeWithSelector(CoverageOracle.ImplausibleCoverage.selector, uint64(1_000_001)));
        oracle.submitAttestation(a, sig);
    }

    function test_RevertWhen_SignatureMalformed() public {
        CoverageOracle.Attestation memory a = _attestation(12_000);

        vm.expectRevert(Ecdsa.MalformedSignature.selector);
        oracle.submitAttestation(a, hex"deadbeef");
    }

    // -------------------------------------------------------------- mandate gating

    function test_RevertWhen_RegisteringAsNonOwner() public {
        // Note registration is deployment administration, not a device mandate: its arguments are
        // an address and two hashes, none of which a human can meaningfully read off a screen.
        vm.prank(outsider);
        vm.expectRevert(abi.encodeWithSelector(Owned.NotOwner.selector, outsider));
        oracle.registerNote(keccak256("PLIM-C"), attestor, VAULT_SET, MAX_AGE_SECONDS);
    }

    function test_RevertWhen_RotatingAttestorAsNonOwner() public {
        vm.prank(outsider);
        vm.expectRevert(abi.encodeWithSelector(Owned.NotOwner.selector, outsider));
        oracle.setAttestor(NOTE_ID, rogue);
    }

    function test_RevertWhen_MovingVaultSetAsNonOwner() public {
        vm.prank(outsider);
        vm.expectRevert(abi.encodeWithSelector(Owned.NotOwner.selector, outsider));
        oracle.setVaultSet(NOTE_ID, keccak256("elsewhere"));
    }

    function test_OwnershipTransferIsTwoStep() public {
        oracle.transferOwnership(issuer);
        assertEq(oracle.owner(), address(this), "not transferred until accepted");

        vm.prank(issuer);
        oracle.acceptOwnership();
        assertEq(oracle.owner(), issuer);

        vm.expectRevert(abi.encodeWithSelector(Owned.NotOwner.selector, address(this)));
        oracle.setAttestor(NOTE_ID, rogue);
    }

    function test_AttestorRotationInvalidatesTheOldSigner() public {
        _attest(12_000);
        oracle.setAttestor(NOTE_ID, rogue);

        CoverageOracle.Attestation memory a = _attestation(12_000);
        bytes memory staleSig = _sign(a, attestorKey);
        bytes memory freshSig = _sign(a, rogueKey);

        vm.expectRevert(abi.encodeWithSelector(CoverageOracle.BadSigner.selector, attestor, rogue));
        oracle.submitAttestation(a, staleSig);

        // And the new signer works.
        oracle.submitAttestation(a, freshSig);
        assertTrue(oracle.isFresh(NOTE_ID));
    }

    function test_RevertWhen_RegisteringTwice() public {
        vm.expectRevert(abi.encodeWithSelector(CoverageOracle.NoteAlreadyRegistered.selector, NOTE_ID));
        oracle.registerNote(NOTE_ID, attestor, VAULT_SET, MAX_AGE_SECONDS);
    }



    // -------------------------------------------------------------- EIP-712 surface

    function test_DomainSeparatorBindsToChainAndAddress() public view {
        bytes32 expected = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("Plimsoll CoverageOracle"),
                keccak256("1"),
                block.chainid,
                address(oracle)
            )
        );
        assertEq(oracle.domainSeparator(), expected);
    }

    function test_AttestationCannotBeReplayedOnAnotherDeployment() public {
        CoverageOracle.Attestation memory a = _attestation(12_000);
        bytes memory sig = _sign(a, attestorKey);

        CoverageOracle twin = new CoverageOracle(address(this));
        twin.setLoadLine(ILoadLine(address(loadLine)));
        twin.registerNote(NOTE_ID, attestor, VAULT_SET, MAX_AGE_SECONDS);

        // Same payload, same signer, different verifying contract.
        vm.expectRevert();
        twin.submitAttestation(a, sig);
    }

    function test_Fuzz_AnyCoverageBelowLineIsShort(uint64 bps) public {
        bps = uint64(bound(bps, 0, THRESHOLD_BPS - 1));
        _attest(bps);

        (, Coverage.Verdict verdict, ) = oracle.coverageOf(NOTE_ID);
        assertEq(uint8(verdict), uint8(Coverage.Verdict.Short));
    }

    function test_Fuzz_AnyCoverageAtOrAboveLineIsCovered(uint64 bps) public {
        bps = uint64(bound(bps, THRESHOLD_BPS, 1_000_000));
        _attest(bps);

        (, Coverage.Verdict verdict, ) = oracle.coverageOf(NOTE_ID);
        assertEq(uint8(verdict), uint8(Coverage.Verdict.Covered));
    }

    function test_Fuzz_ExpiredAttestationNeverReadsCovered(uint64 bps, uint64 skip) public {
        bps = uint64(bound(bps, 0, 1_000_000));
        skip = uint64(bound(skip, 1 hours, 3650 days));
        _attest(bps);

        vm.warp(block.timestamp + skip);
        (uint64 read, Coverage.Verdict verdict, ) = oracle.coverageOf(NOTE_ID);
        assertEq(read, 0);
        assertEq(uint8(verdict), uint8(Coverage.Verdict.Unproven));
    }
}

/// @dev A load line that throws, to prove the oracle treats a broken dependency as "no proof".
contract RevertingLine {
    function lineOf(bytes32) external pure returns (uint64, bool) {
        revert("down");
    }
}
