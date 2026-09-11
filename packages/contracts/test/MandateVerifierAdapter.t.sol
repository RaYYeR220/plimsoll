// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { Test } from "forge-std/Test.sol";
import { MandateVerifier } from "../src/authority/MandateVerifier.sol";
import { MandateVerifierAdapter } from "../src/authority/MandateVerifierAdapter.sol";
import { LoadLine } from "../src/LoadLine.sol";
import { CoverageOracle } from "../src/CoverageOracle.sol";
import { Coverage } from "../src/libraries/Coverage.sol";
import { ICoverageOracle, ILoadLine } from "../src/interfaces/IPlimsoll.sol";
import { IMandateAuthority } from "../src/interfaces/IMandateAuthority.sol";

/**
 * @notice The seam between the load line and a human holding a hardware device.
 * @dev Every mandate here is signed over the digest the verifier itself formats, so these tests
 *      exercise the same bytes a Ledger would render. The device-produced golden signature lives
 *      in the verifier's own suite; this file is about the adapter that carries its decision into
 *      {LoadLine}.
 */
contract MandateVerifierAdapterTest is Test {
    string internal constant MARKET = "PLIM-A";

    uint256 internal authorityKey = uint256(keccak256("plimsoll.authority.adapter"));
    address internal authoritySigner;
    address internal outsider = makeAddr("outsider");

    MandateVerifier internal verifier;
    MandateVerifierAdapter internal adapter;
    LoadLine internal loadLine;
    CoverageOracle internal oracle;

    bytes32 internal noteId;
    uint64 internal nonce;

    function setUp() public {
        authoritySigner = vm.addr(authorityKey);
        verifier = new MandateVerifier(authoritySigner);
        adapter = new MandateVerifierAdapter(verifier);
        loadLine = new LoadLine(IMandateAuthority(address(adapter)), address(this));
        oracle = new CoverageOracle(address(this));

        loadLine.setOracle(ICoverageOracle(address(oracle)));
        oracle.setLoadLine(ILoadLine(address(loadLine)));

        vm.warp(1_800_000_000);
        noteId = adapter.registerMarket(MARKET);
    }

    function _mandate(
        MandateVerifier.Action action,
        uint32 coverageBps,
        uint32 loadLineBps
    ) internal returns (bytes memory proof) {
        MandateVerifier.Mandate memory m = MandateVerifier.Mandate({
            action: action,
            market: MARKET,
            coverageBps: coverageBps,
            loadLineBps: loadLineBps,
            nonce: ++nonce,
            expiry: uint64(block.timestamp + 1 hours)
        });
        bytes32 digest = verifier.mandateDigest(m);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(authorityKey, digest);
        return abi.encode(m, abi.encodePacked(r, s, v));
    }

    // ------------------------------------------------------------------ market codes

    /**
     * @notice A market code carrying a mandate delimiter must never be registrable.
     * @dev The Ethereum app reflows newlines into spaces and wraps greedily at around nineteen
     *      characters, so a human never sees the mandate's line structure. A market code
     *      containing `NONCE: 9` would therefore render as a mandate with two nonces, and the
     *      human would approve one of them without knowing which. The charset rule is the only
     *      defence, and it has to hold at the point a code enters the system.
     */
    function test_RevertWhen_MarketCodeCarriesADelimiter() public {
        string[7] memory injections = [
            "NONCE: 9",
            "A NONCE",
            "A:B",
            "A B",
            "A\nB",
            "A\tB",
            "PLIM: 1"
        ];
        for (uint256 i; i < injections.length; ++i) {
            vm.expectRevert(MandateVerifier.BadMarketCode.selector);
            adapter.registerMarket(injections[i]);
        }
    }

    function test_RevertWhen_MarketCodeIsOtherwiseMalformed() public {
        string[6] memory bad = [
            "", // empty
            "plim-a", // lowercase
            "-PLIM", // leading hyphen
            "PLIM-", // trailing hyphen
            "PLIM--A", // doubled hyphen
            "PLIMSOLLNOTESERIESAAAAAAAAAAAA" // over 24 characters
        ];
        for (uint256 i; i < bad.length; ++i) {
            vm.expectRevert(MandateVerifier.BadMarketCode.selector);
            adapter.registerMarket(bad[i]);
        }
    }

    function test_RegisteredMarketBindsToTheNoteIdTheDeviceApproved() public view {
        assertEq(noteId, keccak256(bytes(MARKET)));
        assertEq(adapter.marketOf(noteId), MARKET);
    }

    function test_RevertWhen_RegisteringTwice() public {
        vm.expectRevert(abi.encodeWithSelector(MandateVerifierAdapter.MarketAlreadyRegistered.selector, noteId));
        adapter.registerMarket(MARKET);
    }

    // ------------------------------------------------------------------ action mapping

    function test_ThresholdMandateMovesTheLoadLine() public {
        bytes memory proof = _mandate(MandateVerifier.Action.SET_THRESHOLD, 13_000, 10_500);
        loadLine.setThreshold(noteId, 10_500, proof);

        (uint64 bps, bool configured) = loadLine.lineOf(noteId);
        assertEq(bps, 10_500);
        assertTrue(configured);

        // And the verifier recorded the same number the human read.
        adapter.assertThresholdMatchesMandate(noteId, 10_500);
    }

    function test_HaltAndResumeMandatesFlowThrough() public {
        loadLine.setThreshold(noteId, 10_500, _mandate(MandateVerifier.Action.SET_THRESHOLD, 13_000, 10_500));

        loadLine.halt(noteId, _mandate(MandateVerifier.Action.HALT, 9_000, 10_500));
        assertTrue(loadLine.isHalted(noteId));
        assertTrue(adapter.mandatedHalt(noteId), "the verifier is the record of the halt");

        loadLine.resume(noteId, _mandate(MandateVerifier.Action.RESUME, 12_000, 10_500));
        assertFalse(loadLine.isHalted(noteId));
        assertFalse(adapter.mandatedHalt(noteId));
    }

    function test_RevertWhen_MandateIsForAnotherMarket() public {
        adapter.registerMarket("PLIM-B");
        bytes memory proof = _mandate(MandateVerifier.Action.SET_THRESHOLD, 13_000, 10_500);

        // The signature is valid, but it approves a different market than the note being acted on.
        bytes32 other = keccak256(bytes("PLIM-B"));
        vm.expectRevert(
            abi.encodeWithSelector(
                MandateVerifierAdapter.MarketMismatch.selector,
                other,
                keccak256(bytes(MARKET))
            )
        );
        loadLine.setThreshold(other, 10_500, proof);
    }

    function test_RevertWhen_MandateActionDoesNotMatchTheEntrypoint() public {
        loadLine.setThreshold(noteId, 10_500, _mandate(MandateVerifier.Action.SET_THRESHOLD, 13_000, 10_500));

        // A halt-shaped call carrying a resume-shaped mandate.
        bytes memory proof = _mandate(MandateVerifier.Action.RESUME, 12_000, 10_500);
        vm.expectRevert(
            abi.encodeWithSelector(
                MandateVerifier.WrongAction.selector,
                MandateVerifier.Action.RESUME,
                MandateVerifier.Action.HALT
            )
        );
        loadLine.halt(noteId, proof);
    }

    function test_RevertWhen_SignedByTheWrongKey() public {
        MandateVerifier.Mandate memory m = MandateVerifier.Mandate({
            action: MandateVerifier.Action.SET_THRESHOLD,
            market: MARKET,
            coverageBps: 13_000,
            loadLineBps: 10_500,
            nonce: ++nonce,
            expiry: uint64(block.timestamp + 1 hours)
        });
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(uint256(keccak256("impostor")), verifier.mandateDigest(m));
        bytes memory proof = abi.encode(m, abi.encodePacked(r, s, v));

        vm.expectRevert();
        loadLine.setThreshold(noteId, 10_500, proof);
    }

    function test_RevertWhen_MandateNonceIsReplayed() public {
        MandateVerifier.Mandate memory m = MandateVerifier.Mandate({
            action: MandateVerifier.Action.SET_THRESHOLD,
            market: MARKET,
            coverageBps: 13_000,
            loadLineBps: 10_500,
            nonce: 77,
            expiry: uint64(block.timestamp + 1 hours)
        });
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(authorityKey, verifier.mandateDigest(m));
        bytes memory proof = abi.encode(m, abi.encodePacked(r, s, v));

        loadLine.setThreshold(noteId, 10_500, proof);

        vm.expectRevert(abi.encodeWithSelector(MandateVerifier.NonceUsed.selector, uint64(77)));
        loadLine.setThreshold(noteId, 10_500, proof);
    }

    function test_RevertWhen_MandateHasExpired() public {
        MandateVerifier.Mandate memory m = MandateVerifier.Mandate({
            action: MandateVerifier.Action.SET_THRESHOLD,
            market: MARKET,
            coverageBps: 13_000,
            loadLineBps: 10_500,
            nonce: ++nonce,
            expiry: uint64(block.timestamp + 1 hours)
        });
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(authorityKey, verifier.mandateDigest(m));
        bytes memory proof = abi.encode(m, abi.encodePacked(r, s, v));

        vm.warp(block.timestamp + 2 hours);
        vm.expectRevert();
        loadLine.setThreshold(noteId, 10_500, proof);
    }

    function test_RevertWhen_ActionIsNotOneOfTheThree() public {
        bytes memory proof = _mandate(MandateVerifier.Action.SET_THRESHOLD, 13_000, 10_500);
        bytes32 stray = keccak256("PLIMSOLL_LOADLINE_SET_ORACLE");

        // Deployment administration is owner-gated and must never resolve to a mandate action.
        vm.expectRevert(abi.encodeWithSelector(MandateVerifierAdapter.UnsupportedAction.selector, stray));
        adapter.requireMandate(stray, noteId, 0, proof);
    }

    // ------------------------------------------------------------------ reconciliation

    /**
     * @notice The human approves one number; another must not execute.
     * @dev A valid SET-THRESHOLD mandate the device signed for 95.00% is submitted with 90.00% as
     *      the value to write. It must revert - not succeed and be flagged afterwards - and it must
     *      revert before the mandate is consumed, so nothing about the approval is lost.
     */
    function test_RevertWhen_ThresholdDiffersFromWhatTheHumanApproved() public {
        bytes memory proof = _mandate(MandateVerifier.Action.SET_THRESHOLD, 13_000, 9_500);

        vm.expectRevert(
            abi.encodeWithSelector(
                MandateVerifierAdapter.MandateValueMismatch.selector,
                noteId,
                uint256(9_000),
                uint32(9_500)
            )
        );
        loadLine.setThreshold(noteId, 9_000, proof);

        // Nothing was written on either side.
        (, bool configured) = loadLine.lineOf(noteId);
        assertFalse(configured, "the load line did not take the unapproved number");
        (, bool listed) = adapter.mandatedThreshold(noteId);
        assertFalse(listed, "the verifier did not consume the mandate");

        // And the approval survives, usable for exactly what it approved.
        loadLine.setThreshold(noteId, 9_500, proof);
        (uint64 written, ) = loadLine.lineOf(noteId);
        assertEq(written, 9_500);
        adapter.assertThresholdMatchesMandate(noteId, 9_500);
    }

    function test_Fuzz_OnlyTheApprovedThresholdCanBeWritten(uint32 approved, uint64 attempted) public {
        approved = uint32(bound(approved, 1, 99_999));
        attempted = uint64(bound(attempted, 1, 1_000_000));
        vm.assume(attempted != approved);

        bytes memory proof = _mandate(MandateVerifier.Action.SET_THRESHOLD, 13_000, approved);
        vm.expectRevert();
        loadLine.setThreshold(noteId, attempted, proof);
    }

    function test_RevertWhen_ReadingAnUnregisteredMarket() public {
        bytes32 ghost = keccak256("never-registered");
        vm.expectRevert(abi.encodeWithSelector(MandateVerifierAdapter.MarketNotRegistered.selector, ghost));
        adapter.mandatedHalt(ghost);
    }

    // ------------------------------------------------------------------ owner vs mandate

    function test_DeploymentAdminIsOwnerGatedNotMandated() public {
        // Stated plainly in the README too: the device governs the load line, and nothing else.
        vm.prank(outsider);
        vm.expectRevert();
        loadLine.setOracle(ICoverageOracle(address(oracle)));

        // The owner needs no mandate for it, because no device screen could render an address.
        loadLine.setOracle(ICoverageOracle(address(oracle)));
    }
}
