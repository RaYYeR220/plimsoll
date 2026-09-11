// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { Base } from "./Base.t.sol";
import { LoadLine } from "../src/LoadLine.sol";
import { Coverage } from "../src/libraries/Coverage.sol";
import { ICoverageOracle } from "../src/interfaces/IPlimsoll.sol";
import { IMandateAuthority } from "../src/interfaces/IMandateAuthority.sol";
import { Owned } from "../src/access/Owned.sol";
import { MockMandateAuthority } from "./mocks/Mocks.sol";

contract LoadLineTest is Base {
    function test_ClearWhenCovered() public {
        _attest(12_000);

        (bool clear, Coverage.Verdict verdict, Coverage.Reason reason, uint64 bps, uint64 threshold) = loadLine
            .status(NOTE_ID);
        assertTrue(clear);
        assertEq(uint8(verdict), uint8(Coverage.Verdict.Covered));
        assertEq(uint8(reason), uint8(Coverage.Reason.None));
        assertEq(bps, 12_000);
        assertEq(threshold, THRESHOLD_BPS);
        loadLine.requireClear(NOTE_ID);
    }

    // ------------------------------------------------------------------ refusal ordering

    function test_HaltOutranksGoodCoverage() public {
        _attest(50_000); // wildly over-covered
        loadLine.halt(NOTE_ID, "");

        (bool clear, , Coverage.Reason reason, , ) = loadLine.status(NOTE_ID);
        assertFalse(clear, "a human stop outranks any number");
        assertEq(uint8(reason), uint8(Coverage.Reason.AuthorityHalt));
        assertFalse(Coverage.isEvidenceFailure(reason), "a halt is not a failure of our evidence");

        vm.expectRevert(abi.encodeWithSelector(LoadLine.NoteHalted.selector, NOTE_ID));
        loadLine.requireClear(NOTE_ID);
    }

    function test_HaltOutranksMissingEvidence() public {
        loadLine.halt(NOTE_ID, "");

        (, , Coverage.Reason reason, , ) = loadLine.status(NOTE_ID);
        assertEq(uint8(reason), uint8(Coverage.Reason.AuthorityHalt), "the halt is reported, not the gap");
    }

    function test_EvidenceFailureOutranksShortness() public {
        _attest(9_000); // short
        vm.warp(block.timestamp + 2 hours); // and now also unproven

        (, Coverage.Verdict verdict, Coverage.Reason reason, , ) = loadLine.status(NOTE_ID);
        assertEq(uint8(verdict), uint8(Coverage.Verdict.Unproven));
        assertEq(
            uint8(reason),
            uint8(Coverage.Reason.AttestationExpired),
            "we must not call an issuer short on evidence we no longer trust"
        );
    }

    function test_ShortRevertsWithTheNumbers() public {
        _attest(9_000);

        vm.expectRevert(
            abi.encodeWithSelector(LoadLine.BelowLoadLine.selector, NOTE_ID, uint64(9_000), THRESHOLD_BPS)
        );
        loadLine.requireClear(NOTE_ID);
    }

    function test_UnprovenRevertsWithTheReason() public {
        vm.expectRevert(
            abi.encodeWithSelector(
                LoadLine.CoverageUnproven.selector,
                NOTE_ID,
                Coverage.Reason.NoAttestation
            )
        );
        loadLine.requireClear(NOTE_ID);
    }

    function test_ResumeRestoresTrading() public {
        _attest(12_000);
        loadLine.halt(NOTE_ID, "");
        assertTrue(loadLine.isHalted(NOTE_ID));

        loadLine.resume(NOTE_ID, "");
        assertFalse(loadLine.isHalted(NOTE_ID));
        loadLine.requireClear(NOTE_ID);
    }

    // ------------------------------------------------------------------ fail-closed wiring

    function test_FailsClosed_WithNoLineConfigured() public {
        bytes32 other = keccak256("unconfigured");

        (bool clear, , Coverage.Reason reason, , uint64 threshold) = loadLine.status(other);
        assertFalse(clear);
        assertEq(uint8(reason), uint8(Coverage.Reason.LineUnset));
        assertEq(threshold, type(uint64).max);

        (uint64 bps, bool configured) = loadLine.lineOf(other);
        assertEq(bps, type(uint64).max, "an unset line must be unreachable, not zero");
        assertFalse(configured);
    }

    function test_FailsClosed_WithNoOracleWired() public {
        LoadLine bare = new LoadLine(authority, address(this));
        bare.setThreshold(NOTE_ID, THRESHOLD_BPS, "");

        (bool clear, , Coverage.Reason reason, , ) = bare.status(NOTE_ID);
        assertFalse(clear);
        assertEq(uint8(reason), uint8(Coverage.Reason.NoAttestation));
    }

    function test_FailsClosed_WhenOracleReverts() public {
        loadLine.setOracle(ICoverageOracle(address(new ExplodingOracle())));

        (bool clear, Coverage.Verdict verdict, , , ) = loadLine.status(NOTE_ID);
        assertFalse(clear, "a broken oracle must never read as covered");
        assertEq(uint8(verdict), uint8(Coverage.Verdict.Unproven));
    }

    // ------------------------------------------------------------------ mandate gating

    function test_RevertWhen_SettingThresholdWithoutMandate() public {
        authority.setAllowAll(false);

        vm.expectRevert();
        loadLine.setThreshold(NOTE_ID, 20_000, "");
    }

    function test_RevertWhen_HaltingWithoutMandate() public {
        authority.setAllowAll(false);

        vm.expectRevert();
        loadLine.halt(NOTE_ID, "");
    }

    function test_RevertWhen_ResumingWithoutMandate() public {
        loadLine.halt(NOTE_ID, "");
        authority.setAllowAll(false);

        vm.expectRevert();
        loadLine.resume(NOTE_ID, "");
    }

    function test_MandateIsScopedToActionAndSubject() public {
        authority.setAllowAll(false);
        // The authority sees the gating contract as its caller, not the human behind it - the
        // human's authorisation is what lives inside `proof`. So the grant is keyed to LoadLine.
        // A mandate to halt is not a mandate to move the line.
        authority.grant(loadLine.ACTION_HALT(), NOTE_ID, address(loadLine));

        loadLine.halt(NOTE_ID, "");

        vm.expectRevert();
        loadLine.setThreshold(NOTE_ID, 20_000, "");
    }

    function test_MandateForOneNoteDoesNotCoverAnother() public {
        bytes32 other = keccak256("PLIM-B");
        authority.setAllowAll(false);
        authority.grant(loadLine.ACTION_HALT(), NOTE_ID, address(loadLine));

        loadLine.halt(NOTE_ID, "");

        vm.expectRevert();
        loadLine.halt(other, "");
    }

    function test_RevertWhen_AuthorityHasNoCode() public {
        // The one misconfiguration in this system that would fail OPEN. Solidity emits no
        // extcodesize check for an external call it decodes no return data from, so calling
        // `requireMandate` on an EOA succeeds silently and every gate stops gating.
        address eoa = makeAddr("not-a-contract");
        vm.expectRevert(abi.encodeWithSelector(LoadLine.AuthorityNotAContract.selector, eoa));
        new LoadLine(IMandateAuthority(eoa), address(this));
    }

    function test_RevertWhen_RotatingAuthorityToAnEoa() public {
        address eoa = makeAddr("not-a-contract");
        vm.expectRevert(abi.encodeWithSelector(LoadLine.AuthorityNotAContract.selector, eoa));
        loadLine.setMandateAuthority(IMandateAuthority(eoa));
    }

    function test_RevertWhen_RewiringAsNonOwner() public {
        vm.prank(outsider);
        vm.expectRevert(abi.encodeWithSelector(Owned.NotOwner.selector, outsider));
        loadLine.setOracle(ICoverageOracle(address(oracle)));

        vm.prank(outsider);
        vm.expectRevert(abi.encodeWithSelector(Owned.NotOwner.selector, outsider));
        loadLine.setMandateAuthority(IMandateAuthority(address(authority)));
    }

    function test_TheOwnerCanRepointTheAuthority() public {
        // Stated rather than hidden: deployment administration is owner-controlled, so an owner
        // who swaps the authority governs the load line too. The README says this in as many
        // words instead of implying the device is unbypassable.
        MockMandateAuthority replacement = new MockMandateAuthority();
        replacement.setAllowAll(true);
        loadLine.setMandateAuthority(IMandateAuthority(address(replacement)));
        assertEq(address(loadLine.mandateAuthority()), address(replacement));
    }

    function test_ACodelessAuthorityWouldHaveFailedOpen() public {
        // Demonstrates the hazard the guard exists for, using a contract that self-destructs is
        // unnecessary: calling into a bare address with this signature simply returns success.
        address eoa = makeAddr("bare");
        (bool ok, ) = eoa.call(
            abi.encodeWithSignature("requireMandate(bytes32,bytes32,bytes)", bytes32(0), bytes32(0), "")
        );
        assertTrue(ok, "a call into a codeless address reports success, which is why we check");
    }

    function test_RevertWhen_ThresholdIsZero() public {
        // Zero is not a permissive line, it is no line at all, and would clear a note with
        // proven zero coverage.
        vm.expectRevert(abi.encodeWithSelector(LoadLine.ThresholdOutOfRange.selector, uint64(0)));
        loadLine.setThreshold(NOTE_ID, 0, "");
    }

    function test_RevertWhen_ThresholdIsAbsurd() public {
        vm.expectRevert(abi.encodeWithSelector(LoadLine.ThresholdOutOfRange.selector, uint64(1_000_001)));
        loadLine.setThreshold(NOTE_ID, 1_000_001, "");
    }

    function test_RaisingTheLineCanStrandAPreviouslyClearNote() public {
        _attest(12_000);
        loadLine.requireClear(NOTE_ID);

        loadLine.setThreshold(NOTE_ID, 15_000, "");

        vm.expectRevert(
            abi.encodeWithSelector(LoadLine.BelowLoadLine.selector, NOTE_ID, uint64(12_000), uint64(15_000))
        );
        loadLine.requireClear(NOTE_ID);
    }

    function test_Fuzz_ClearOnlyWhenCoverageMeetsTheLine(uint64 bps, uint64 threshold) public {
        bps = uint64(bound(bps, 0, 1_000_000));
        threshold = uint64(bound(threshold, 1, 1_000_000));

        loadLine.setThreshold(NOTE_ID, threshold, "");
        _attest(bps);

        (bool clear, , , , ) = loadLine.status(NOTE_ID);
        assertEq(clear, bps >= threshold);
    }
}

/// @dev An oracle that throws, to prove the gate treats a broken dependency as "no proof".
contract ExplodingOracle {
    function coverageOf(bytes32) external pure returns (uint64, uint8, uint8) {
        revert("boom");
    }

    function evidenceOf(bytes32) external pure returns (uint64, uint8) {
        revert("boom");
    }
}
