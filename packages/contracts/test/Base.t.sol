// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { Test } from "forge-std/Test.sol";

import { CoverageOracle } from "../src/CoverageOracle.sol";
import { LoadLine } from "../src/LoadLine.sol";
import { BerthMarket } from "../src/BerthMarket.sol";
import { CouponScheduler } from "../src/CouponScheduler.sol";
import { CashLegController } from "../src/CashLegController.sol";
import { ICoverageOracle, ILoadLine } from "../src/interfaces/IPlimsoll.sol";
import { IERC20 } from "../src/interfaces/IERC20.sol";
import { IMandateAuthority } from "../src/interfaces/IMandateAuthority.sol";

import { MockNote } from "./mocks/MockNote.sol";
import { MockMandateAuthority, MockCash, FreezeRegistry, MockHts, MockScheduleService } from "./mocks/Mocks.sol";

/// @notice Shared rig: a wired protocol, a funded market, and a signing attestor.
abstract contract Base is Test {
    bytes32 internal constant NOTE_ID = keccak256("PLIM-A");
    bytes32 internal constant PARTITION = bytes32(uint256(1));
    bytes32 internal constant VAULT_SET = keccak256("vaults/v1");
    bytes32 internal constant SOURCE_HASH = keccak256("evidence-bundle");
    uint64 internal constant THRESHOLD_BPS = 10_500;
    /// @dev Zero by default, so most tests exercise expiry; specific tests tighten it.
    uint64 internal constant MAX_AGE_SECONDS = 0;

    int64 internal constant HEDERA_SUCCESS = 22;
    address internal constant HTS_ADDR = address(0x167);
    address internal constant SCHEDULE_ADDR = address(0x16b);

    uint256 internal attestorKey = 0xA11CE;
    uint256 internal rogueKey = 0xBADBAD;
    address internal attestor;
    address internal rogue;

    address internal maker = makeAddr("maker");
    address internal taker = makeAddr("taker");
    address internal issuer = makeAddr("issuer");
    address internal paymentAgent = makeAddr("paymentAgent");
    address internal outsider = makeAddr("outsider");

    MockMandateAuthority internal authority;
    CoverageOracle internal oracle;
    LoadLine internal loadLine;
    BerthMarket internal market;
    CouponScheduler internal scheduler;
    CashLegController internal cashController;

    MockNote internal note;
    MockCash internal cash;
    FreezeRegistry internal freezeRegistry;
    MockHts internal hts;
    MockScheduleService internal schedules;

    uint64 internal nonceCounter;

    function setUp() public virtual {
        attestor = vm.addr(attestorKey);
        rogue = vm.addr(rogueKey);

        // The system contracts live at fixed addresses on Hedera, so the mocks are etched there
        // rather than injected. That keeps the production code free of test-only indirection.
        freezeRegistry = new FreezeRegistry();
        MockHts htsImpl = new MockHts();
        vm.etch(HTS_ADDR, address(htsImpl).code);
        hts = MockHts(payable(HTS_ADDR));
        // vm.etch copies runtime code but not storage, so the etched mocks start with every slot
        // zeroed and have to be initialised through their setters rather than a constructor.
        hts.setRegistry(freezeRegistry);
        hts.setNextResponseCode(HEDERA_SUCCESS);

        MockScheduleService scheduleImpl = new MockScheduleService();
        vm.etch(SCHEDULE_ADDR, address(scheduleImpl).code);
        schedules = MockScheduleService(SCHEDULE_ADDR);
        schedules.setNextResponseCode(HEDERA_SUCCESS);
        schedules.setCapacity(true);

        authority = new MockMandateAuthority();
        authority.setAllowAll(true);

        oracle = new CoverageOracle(address(this));
        loadLine = new LoadLine(IMandateAuthority(address(authority)), address(this));

        oracle.setLoadLine(ILoadLine(address(loadLine)));
        loadLine.setOracle(ICoverageOracle(address(oracle)));

        note = new MockNote();
        cash = new MockCash(freezeRegistry);
        hts.setCreatedToken(address(cash));

        market = new BerthMarket(ILoadLine(address(loadLine)), IERC20(address(cash)));
        scheduler = new CouponScheduler(
            ILoadLine(address(loadLine)),
            ICoverageOracle(address(oracle)),
            IERC20(address(cash)),
            address(this)
        );
        cashController = new CashLegController(ILoadLine(address(loadLine)), address(this));

        // Start well past the epoch so expiries and coupon dates are realistic.
        vm.warp(1_800_000_000);

        oracle.registerNote(NOTE_ID, attestor, VAULT_SET, MAX_AGE_SECONDS);
        loadLine.setThreshold(NOTE_ID, THRESHOLD_BPS, "");

        // ATS refuses a transfer to an account without KYC, so the rig grants it to the parties
        // that are supposed to be able to trade. Tests that want a denial revoke it explicitly.
        note.setKyc(maker, true);
        note.setKyc(taker, true);
        note.setKyc(issuer, true);
        note.setKyc(paymentAgent, true);
    }

    // ------------------------------------------------------------------ attestation helpers

    function _sign(
        CoverageOracle.Attestation memory a,
        uint256 key
    ) internal view returns (bytes memory) {
        bytes32 structHash = keccak256(
            abi.encode(
                oracle.ATTESTATION_TYPEHASH(),
                a.noteId,
                a.coverageBps,
                a.asOfBlock,
                a.vaultSetHash,
                a.sourceHash,
                a.expiry,
                a.nonce
            )
        );
        bytes32 digest = keccak256(abi.encodePacked(hex"1901", oracle.domainSeparator(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
        return abi.encodePacked(r, s, v);
    }

    function _attestation(uint64 bps) internal returns (CoverageOracle.Attestation memory) {
        return
            CoverageOracle.Attestation({
                noteId: NOTE_ID,
                coverageBps: bps,
                asOfBlock: 1_000_000,
                vaultSetHash: VAULT_SET,
                sourceHash: SOURCE_HASH,
                expiry: uint64(block.timestamp + 1 hours),
                nonce: ++nonceCounter
            });
    }

    /// @notice Records a valid attestation at `bps`. The default happy-path setup step.
    function _attest(uint64 bps) internal {
        CoverageOracle.Attestation memory a = _attestation(bps);
        oracle.submitAttestation(a, _sign(a, attestorKey));
    }

    function _submit(CoverageOracle.Attestation memory a, uint256 key) internal {
        oracle.submitAttestation(a, _sign(a, key));
    }

    // ------------------------------------------------------------------ market helpers

    /// @notice Gives `holder` notes and lets the venue escrow and move them.
    /// @dev A maker needs both. Asks are escrowed with a hold, which ATS funds from an ERC-20
    ///      allowance; bids pull notes with operatorTransferByPartition, which needs operator rights.
    function _fundNotes(address holder, uint256 amount) internal {
        note.mint(PARTITION, holder, amount);
        vm.startPrank(holder);
        note.authorizeOperatorByPartition(PARTITION, address(market));
        note.approve(address(market), type(uint256).max);
        vm.stopPrank();
    }

    function _fundCash(address who, uint256 amount, address spender) internal {
        cash.mint(who, amount);
        vm.prank(who);
        cash.approve(spender, amount);
    }
}
