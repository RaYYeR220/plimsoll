// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {MandateVerifier} from "contracts/MandateVerifier.sol";

/// @notice The on-chain half of the authority's test suite.
/// @dev    Two things are being proved here. First, that `mandateText` reproduces, byte for byte,
///         the string `packages/authority/src/mandate.ts` renders -- checked against the same
///         golden vector the TypeScript suite uses, and against a signature a Ledger actually
///         produced over it. Second, that every way of presenting a mandate that a human did not
///         approve reverts with a named error.
contract MandateVerifierTest is Test {
    /// @dev secp256k1 group order, for building a high-s signature on purpose.
    uint256 private constant CURVE_ORDER =
        0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;

    uint256 private constant AUTHORITY_PK = uint256(keccak256("plimsoll.authority"));
    uint256 private constant IMPOSTOR_PK = uint256(keccak256("plimsoll.impostor"));

    uint256 private constant HEDERA_TESTNET = 296;

    /// @dev Every canonical expiry ends in the UTC designator.
    bytes1 private constant UTC_SUFFIX = "Z";

    // --- the golden vector, identical to test/vectors.ts ------------------------------------

    address private constant GOLDEN_VERIFIER = 0x71C7656EC7ab88b098defB751B7401B5f6d8976F;
    address private constant DEVICE_AUTHORITY = 0xDad77910DbDFdE764fC21FCD4E74D71bBACA6D8D;
    uint64 private constant GOLDEN_EXPIRY = 1_789_315_200; // 2026-09-13T16:00:00Z

    string private constant GOLDEN_TEXT = "PLIMSOLL MANDATE v1\n"
        "ACTION: SET-THRESHOLD\n"
        "MARKET: SEA-2026-A\n"
        "COVERAGE: 98.60%\n"
        "LOAD LINE: 95.00%\n"
        "NONCE: 7\n"
        "EXPIRES: 2026-09-13T16:00:00Z\n"
        "CHAIN: 296\n"
        "VERIFIER: 0x71c7656ec7ab88b098defb751b7401b5f6d8976f";

    bytes32 private constant GOLDEN_DIGEST = 0x195cff43efc99c7b78124a2037a9546e716ef5454a43c2233e0170befbd337de;

    /// @dev Produced by a Ledger Nano S+ (app-ethereum 1.22.3) over GOLDEN_TEXT, captured by
    ///      `demo/fixture.ts`. Ledger signs with RFC 6979, so this is reproducible.
    bytes private constant DEVICE_SIGNATURE = hex"cc17337be1f33a3a122e98a34af2e07ee3826831ba85e273afc4eebc948a5c3622b914a4b441bd0ea7b93c8b1229be8507e75be3414b75a1890f5199d4ca67011c";

    address private authority;
    address private impostor;
    MandateVerifier private verifier;

    function setUp() public {
        authority = vm.addr(AUTHORITY_PK);
        impostor = vm.addr(IMPOSTOR_PK);
        vm.chainId(HEDERA_TESTNET);
        vm.warp(GOLDEN_EXPIRY - 1 days);
        verifier = new MandateVerifier(authority);
    }

    // --- cross-language agreement -----------------------------------------------------------

    function test_MandateTextMatchesTheTypeScriptGoldenVector() public {
        MandateVerifier golden = _deployAt(GOLDEN_VERIFIER, DEVICE_AUTHORITY);
        assertEq(golden.mandateText(_goldenMandate()), GOLDEN_TEXT);
        assertEq(golden.mandateDigest(_goldenMandate()), GOLDEN_DIGEST);
    }

    function test_AcceptsASignatureProducedOnTheDevice() public {
        MandateVerifier golden = _deployAt(GOLDEN_VERIFIER, DEVICE_AUTHORITY);
        golden.setCoverageThreshold(_goldenMandate(), DEVICE_SIGNATURE);
        assertEq(golden.marketState("SEA-2026-A").loadLineBps, 9500);
        assertTrue(golden.marketState("SEA-2026-A").listed);
        assertTrue(golden.nonceUsed(7));
    }

    // --- the happy path ---------------------------------------------------------------------

    function test_ListsHaltsAndResumesAMarket() public {
        _authorise(_mandate(MandateVerifier.Action.SET_THRESHOLD, 10_340, 10_200, 1));
        assertEq(verifier.marketState("SEA-2026-A").loadLineBps, 10_200);
        assertFalse(verifier.isHalted("SEA-2026-A"));

        _authorise(_mandate(MandateVerifier.Action.HALT, 9_860, 10_200, 2));
        assertTrue(verifier.isHalted("SEA-2026-A"));

        _authorise(_mandate(MandateVerifier.Action.RESUME, 10_340, 10_200, 3));
        assertFalse(verifier.isHalted("SEA-2026-A"));
    }

    function test_MarketsAreIndependent() public {
        _authorise(_mandate(MandateVerifier.Action.SET_THRESHOLD, 10_340, 10_200, 1));
        MandateVerifier.Mandate memory other = _mandate(MandateVerifier.Action.SET_THRESHOLD, 10_100, 9_000, 2);
        other.market = "SEA-2026-B";
        _authorise(other);

        assertEq(verifier.marketState("SEA-2026-A").loadLineBps, 10_200);
        assertEq(verifier.marketState("SEA-2026-B").loadLineBps, 9_000);
    }

    // --- negative controls: mandates nobody approved -----------------------------------------

    function test_RevertWhen_NonceIsReplayed() public {
        MandateVerifier.Mandate memory m = _mandate(MandateVerifier.Action.SET_THRESHOLD, 10_340, 10_200, 1);
        bytes memory signature = _sign(verifier, m, AUTHORITY_PK);
        verifier.setCoverageThreshold(m, signature);

        vm.expectRevert(abi.encodeWithSelector(MandateVerifier.NonceUsed.selector, uint64(1)));
        verifier.setCoverageThreshold(m, signature);
    }

    function test_RevertWhen_NonceIsReplayedAcrossActions() public {
        _authorise(_mandate(MandateVerifier.Action.SET_THRESHOLD, 10_340, 10_200, 1));
        MandateVerifier.Mandate memory halt = _mandate(MandateVerifier.Action.HALT, 9_860, 10_200, 1);
        bytes memory signature = _sign(verifier, halt, AUTHORITY_PK);

        vm.expectRevert(abi.encodeWithSelector(MandateVerifier.NonceUsed.selector, uint64(1)));
        verifier.haltMarket(halt, signature);
    }

    function test_RevertWhen_MandateHasExpired() public {
        MandateVerifier.Mandate memory m = _mandate(MandateVerifier.Action.SET_THRESHOLD, 10_340, 10_200, 1);
        bytes memory signature = _sign(verifier, m, AUTHORITY_PK);

        vm.warp(uint256(m.expiry) + 1);
        vm.expectRevert(
            abi.encodeWithSelector(MandateVerifier.MandateExpired.selector, m.expiry, uint64(block.timestamp))
        );
        verifier.setCoverageThreshold(m, signature);
    }

    function test_RevertWhen_SignedByTheWrongKey() public {
        MandateVerifier.Mandate memory m = _mandate(MandateVerifier.Action.SET_THRESHOLD, 10_340, 10_200, 1);
        bytes memory forged = _sign(verifier, m, IMPOSTOR_PK);

        vm.expectRevert(abi.encodeWithSelector(MandateVerifier.WrongAuthority.selector, impostor, authority));
        verifier.setCoverageThreshold(m, forged);
    }

    function test_RevertWhen_SignedForAnotherChain() public {
        MandateVerifier.Mandate memory m = _mandate(MandateVerifier.Action.SET_THRESHOLD, 10_340, 10_200, 1);

        vm.chainId(1);
        bytes memory elsewhere = _sign(verifier, m, AUTHORITY_PK);
        vm.chainId(HEDERA_TESTNET);

        vm.expectPartialRevert(MandateVerifier.WrongAuthority.selector);
        verifier.setCoverageThreshold(m, elsewhere);
    }

    function test_RevertWhen_SignedForAnotherDeployment() public {
        MandateVerifier twin = new MandateVerifier(authority);
        MandateVerifier.Mandate memory m = _mandate(MandateVerifier.Action.SET_THRESHOLD, 10_340, 10_200, 1);

        assertTrue(twin.mandateDigest(m) != verifier.mandateDigest(m));
        bytes memory forOtherDeployment = _sign(twin, m, AUTHORITY_PK);

        vm.expectPartialRevert(MandateVerifier.WrongAuthority.selector);
        verifier.setCoverageThreshold(m, forOtherDeployment);
    }

    /// @dev The failure the whole module is built around: displayed text and hashed text differ
    ///      by one character. 98.60% was approved; 98.61% is submitted.
    function test_RevertWhen_DisplayedTextDiffersByOneByte() public {
        MandateVerifier.Mandate memory approved = _mandate(MandateVerifier.Action.SET_THRESHOLD, 9_860, 10_200, 1);
        bytes memory signature = _sign(verifier, approved, AUTHORITY_PK);

        MandateVerifier.Mandate memory submitted = approved;
        submitted.coverageBps = 9_861;
        assertEq(bytes(verifier.mandateText(approved)).length, bytes(verifier.mandateText(submitted)).length);

        vm.expectPartialRevert(MandateVerifier.WrongAuthority.selector);
        verifier.setCoverageThreshold(submitted, signature);
    }

    function test_RevertWhen_ActionDoesNotMatchTheEntrypoint() public {
        _authorise(_mandate(MandateVerifier.Action.SET_THRESHOLD, 10_340, 10_200, 1));
        MandateVerifier.Mandate memory halt = _mandate(MandateVerifier.Action.HALT, 9_860, 10_200, 2);
        bytes memory signature = _sign(verifier, halt, AUTHORITY_PK);

        vm.expectRevert(
            abi.encodeWithSelector(
                MandateVerifier.WrongAction.selector, MandateVerifier.Action.HALT, MandateVerifier.Action.RESUME
            )
        );
        verifier.resumeMarket(halt, signature);
    }

    // --- negative controls: malformed signatures ---------------------------------------------

    function test_RevertWhen_SignatureIsTheWrongLength() public {
        MandateVerifier.Mandate memory m = _mandate(MandateVerifier.Action.SET_THRESHOLD, 10_340, 10_200, 1);
        bytes memory signature = _sign(verifier, m, AUTHORITY_PK);

        vm.expectRevert(MandateVerifier.InvalidAttestation.selector);
        verifier.setCoverageThreshold(m, bytes.concat(signature, hex"00"));
    }

    function test_RevertWhen_RecoveryIdIsNotCanonical() public {
        MandateVerifier.Mandate memory m = _mandate(MandateVerifier.Action.SET_THRESHOLD, 10_340, 10_200, 1);
        (, bytes32 r, bytes32 s) = vm.sign(AUTHORITY_PK, verifier.mandateDigest(m));

        vm.expectRevert(MandateVerifier.InvalidAttestation.selector);
        verifier.setCoverageThreshold(m, abi.encodePacked(r, s, uint8(29)));
    }

    /// @dev One approval must not be presentable as two distinct signatures.
    function test_RevertWhen_SignatureIsMalleated() public {
        MandateVerifier.Mandate memory m = _mandate(MandateVerifier.Action.SET_THRESHOLD, 10_340, 10_200, 1);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(AUTHORITY_PK, verifier.mandateDigest(m));

        bytes32 flippedS = bytes32(CURVE_ORDER - uint256(s));
        uint8 flippedV = v == 27 ? 28 : 27;

        vm.expectRevert(MandateVerifier.InvalidAttestation.selector);
        verifier.setCoverageThreshold(m, abi.encodePacked(r, flippedS, flippedV));
    }

    // --- negative controls: market state ------------------------------------------------------

    function test_RevertWhen_HaltingAnUnlistedMarket() public {
        MandateVerifier.Mandate memory m = _mandate(MandateVerifier.Action.HALT, 9_860, 10_200, 1);
        bytes memory signature = _sign(verifier, m, AUTHORITY_PK);

        vm.expectRevert(abi.encodeWithSelector(MandateVerifier.UnknownMarket.selector, keccak256("SEA-2026-A")));
        verifier.haltMarket(m, signature);
    }

    function test_RevertWhen_TheLoadLineMovedUnderTheMandate() public {
        _authorise(_mandate(MandateVerifier.Action.SET_THRESHOLD, 10_340, 10_200, 1));
        MandateVerifier.Mandate memory stale = _mandate(MandateVerifier.Action.HALT, 9_860, 9_900, 2);
        bytes memory signature = _sign(verifier, stale, AUTHORITY_PK);

        vm.expectRevert(abi.encodeWithSelector(MandateVerifier.LoadLineMoved.selector, uint32(9_900), uint32(10_200)));
        verifier.haltMarket(stale, signature);
    }

    function test_RevertWhen_HaltingATwiceHaltedMarket() public {
        _authorise(_mandate(MandateVerifier.Action.SET_THRESHOLD, 10_340, 10_200, 1));
        _authorise(_mandate(MandateVerifier.Action.HALT, 9_860, 10_200, 2));
        MandateVerifier.Mandate memory again = _mandate(MandateVerifier.Action.HALT, 9_860, 10_200, 3);
        bytes memory signature = _sign(verifier, again, AUTHORITY_PK);

        vm.expectRevert(MandateVerifier.MarketAlreadyHalted.selector);
        verifier.haltMarket(again, signature);
    }

    function test_RevertWhen_ResumingAMarketThatIsRunning() public {
        _authorise(_mandate(MandateVerifier.Action.SET_THRESHOLD, 10_340, 10_200, 1));
        MandateVerifier.Mandate memory m = _mandate(MandateVerifier.Action.RESUME, 10_340, 10_200, 2);
        bytes memory signature = _sign(verifier, m, AUTHORITY_PK);

        vm.expectRevert(MandateVerifier.MarketNotHalted.selector);
        verifier.resumeMarket(m, signature);
    }

    /// @dev A signed contradiction -- resume the market while its own numbers say it is under
    ///      water -- is refused. A human can approve a mistake; they cannot approve nonsense.
    function test_RevertWhen_ResumingBelowTheLoadLine() public {
        _authorise(_mandate(MandateVerifier.Action.SET_THRESHOLD, 10_340, 10_200, 1));
        _authorise(_mandate(MandateVerifier.Action.HALT, 9_860, 10_200, 2));
        MandateVerifier.Mandate memory m = _mandate(MandateVerifier.Action.RESUME, 9_860, 10_200, 3);
        bytes memory signature = _sign(verifier, m, AUTHORITY_PK);

        vm.expectRevert(
            abi.encodeWithSelector(MandateVerifier.CoverageBelowLine.selector, uint32(9_860), uint32(10_200))
        );
        verifier.resumeMarket(m, signature);
    }

    // --- negative controls: field shapes -------------------------------------------------------

    function test_RevertWhen_MarketCodeIsNotCanonical() public {
        string[8] memory bad =
            ["", "sea-2026-a", "SEA 2026 A", "SEA-2026-", "-SEA", "SEA--2026", "SEA:2026", "AAAAAAAAAAAAAAAAAAAAAAAAA"];
        for (uint256 i = 0; i < bad.length; ++i) {
            MandateVerifier.Mandate memory m = _mandate(MandateVerifier.Action.SET_THRESHOLD, 10_340, 10_200, 1);
            m.market = bad[i];
            vm.expectRevert(MandateVerifier.BadMarketCode.selector);
            verifier.mandateText(m);
        }
    }

    function test_RevertWhen_ValuesAreOutOfRange() public {
        MandateVerifier.Mandate memory m = _mandate(MandateVerifier.Action.SET_THRESHOLD, 100_000, 10_200, 1);
        vm.expectRevert(MandateVerifier.ValueOutOfRange.selector);
        verifier.mandateText(m);

        m = _mandate(MandateVerifier.Action.SET_THRESHOLD, 10_340, 10_200, 1);
        m.expiry = 1_704_067_199; // one second before 2024-01-01T00:00:00Z
        vm.expectRevert(MandateVerifier.ValueOutOfRange.selector);
        verifier.mandateText(m);

        m.expiry = 4_133_980_800; // one second past 2100-12-31T23:59:59Z
        vm.expectRevert(MandateVerifier.ValueOutOfRange.selector);
        verifier.mandateText(m);
    }

    function test_RevertWhen_AuthorityIsUnset() public {
        vm.expectRevert(MandateVerifier.NoAuthority.selector);
        new MandateVerifier(address(0));
    }

    // --- formatting ----------------------------------------------------------------------------

    function test_FormatsPercentagesWithTwoDecimals() public view {
        assertEq(_coverageLine(0), "COVERAGE: 0.00%");
        assertEq(_coverageLine(5), "COVERAGE: 0.05%");
        assertEq(_coverageLine(986), "COVERAGE: 9.86%");
        assertEq(_coverageLine(9_860), "COVERAGE: 98.60%");
        assertEq(_coverageLine(10_000), "COVERAGE: 100.00%");
        assertEq(_coverageLine(99_999), "COVERAGE: 999.99%");
    }

    function test_FormatsTimestampsIncludingLeapDays() public view {
        assertEq(_expiresLine(1_704_067_200), "EXPIRES: 2024-01-01T00:00:00Z");
        assertEq(_expiresLine(1_709_208_000), "EXPIRES: 2024-02-29T12:00:00Z");
        assertEq(_expiresLine(1_789_315_200), "EXPIRES: 2026-09-13T16:00:00Z");
        assertEq(_expiresLine(1_835_481_599), "EXPIRES: 2028-02-29T23:59:59Z");
        assertEq(_expiresLine(1_835_481_600), "EXPIRES: 2028-03-01T00:00:00Z");
        assertEq(_expiresLine(4_102_444_799), "EXPIRES: 2099-12-31T23:59:59Z");
        // 2100 is divisible by 4 but not a leap year; the century rule has to survive.
        assertEq(_expiresLine(4_107_542_399), "EXPIRES: 2100-02-28T23:59:59Z");
        assertEq(_expiresLine(4_107_542_400), "EXPIRES: 2100-03-01T00:00:00Z");
        assertEq(_expiresLine(4_133_980_799), "EXPIRES: 2100-12-31T23:59:59Z");
    }

    function testFuzz_TimestampsRoundTripThroughTheDateFormatter(uint64 expiry) public view {
        expiry = uint64(bound(expiry, 1_704_067_200, 4_133_980_799));
        MandateVerifier.Mandate memory m = _mandate(MandateVerifier.Action.HALT, 9_860, 10_200, 1);
        m.expiry = expiry;

        string memory rendered = _line(verifier.mandateText(m), 6);
        // A canonical ISO-8601 instant is 29 characters including the `EXPIRES: ` key.
        assertEq(bytes(rendered).length, 29);
        assertEq(bytes(rendered)[28], UTC_SUFFIX);
    }

    // --- helpers --------------------------------------------------------------------------------

    function _goldenMandate() private pure returns (MandateVerifier.Mandate memory) {
        return MandateVerifier.Mandate({
            action: MandateVerifier.Action.SET_THRESHOLD,
            market: "SEA-2026-A",
            coverageBps: 9_860,
            loadLineBps: 9_500,
            nonce: 7,
            expiry: GOLDEN_EXPIRY
        });
    }

    function _mandate(MandateVerifier.Action action, uint32 coverageBps, uint32 loadLineBps, uint64 nonce)
        private
        pure
        returns (MandateVerifier.Mandate memory)
    {
        return MandateVerifier.Mandate({
            action: action,
            market: "SEA-2026-A",
            coverageBps: coverageBps,
            loadLineBps: loadLineBps,
            nonce: nonce,
            expiry: GOLDEN_EXPIRY
        });
    }

    function _sign(MandateVerifier target, MandateVerifier.Mandate memory m, uint256 pk)
        private
        view
        returns (bytes memory)
    {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, target.mandateDigest(m));
        return abi.encodePacked(r, s, v);
    }

    function _authorise(MandateVerifier.Mandate memory m) private {
        bytes memory signature = _sign(verifier, m, AUTHORITY_PK);
        if (m.action == MandateVerifier.Action.HALT) verifier.haltMarket(m, signature);
        else if (m.action == MandateVerifier.Action.RESUME) verifier.resumeMarket(m, signature);
        else verifier.setCoverageThreshold(m, signature);
    }

    function _deployAt(address where, address authority_) private returns (MandateVerifier) {
        MandateVerifier template = new MandateVerifier(authority_);
        // `authority` is immutable, so it lives in runtime code and survives the copy.
        vm.etch(where, address(template).code);
        return MandateVerifier(where);
    }

    function _coverageLine(uint32 coverageBps) private view returns (string memory) {
        return _line(verifier.mandateText(_mandate(MandateVerifier.Action.HALT, coverageBps, 10_200, 1)), 3);
    }

    function _expiresLine(uint64 expiry) private view returns (string memory) {
        MandateVerifier.Mandate memory m = _mandate(MandateVerifier.Action.HALT, 9_860, 10_200, 1);
        m.expiry = expiry;
        return _line(verifier.mandateText(m), 6);
    }

    function _line(string memory text, uint256 index) private pure returns (string memory) {
        bytes memory raw = bytes(text);
        uint256 start;
        uint256 seen;
        for (uint256 i = 0; i < raw.length; ++i) {
            if (raw[i] != "\n") continue;
            if (seen == index) return _slice(raw, start, i);
            ++seen;
            start = i + 1;
        }
        return _slice(raw, start, raw.length);
    }

    function _slice(bytes memory raw, uint256 start, uint256 end) private pure returns (string memory) {
        bytes memory out = new bytes(end - start);
        for (uint256 i = 0; i < out.length; ++i) {
            out[i] = raw[start + i];
        }
        return string(out);
    }
}
