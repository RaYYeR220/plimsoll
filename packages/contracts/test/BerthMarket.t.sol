// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { Base } from "./Base.t.sol";
import { BerthMarket } from "../src/BerthMarket.sol";
import { LoadLine } from "../src/LoadLine.sol";
import { Coverage } from "../src/libraries/Coverage.sol";
import { Preflight } from "../src/libraries/Preflight.sol";
import { MockNote } from "./mocks/MockNote.sol";

contract BerthMarketTest is Base {
    uint128 internal constant LOT = 1_000;
    uint128 internal constant PRICE = 2e18; // 2 cash units per note unit
    uint64 internal orderExpiry;

    function setUp() public override {
        super.setUp();
        orderExpiry = uint64(block.timestamp + 7 days);
        _attest(12_000);
        _fundNotes(maker, 10_000);
        _fundCash(taker, 1_000_000, address(market));
    }

    function _placeAsk() internal returns (uint256 id) {
        vm.prank(maker);
        id = market.placeAsk(address(note), NOTE_ID, PARTITION, LOT, PRICE, orderExpiry);
    }

    // ------------------------------------------------------------------ placement

    function test_PlacingAnAskEscrowsTheNotes() public {
        uint256 before = note.balanceOfByPartition(PARTITION, maker);
        uint256 id = _placeAsk();

        assertEq(note.balanceOfByPartition(PARTITION, maker), before - LOT, "notes leave available balance");
        assertEq(note.heldOfByPartition(PARTITION, maker), LOT, "and land in an ATS hold");

        BerthMarket.Order memory o = market.orderOf(id);
        assertEq(o.maker, maker);
        assertTrue(o.open);
        assertEq(o.remaining, LOT);
        assertGt(o.holdId, 0, "the hold id is recorded so settlement can execute it");
    }

    function test_TheVenueNeverCustodiesTheNotes() public {
        _placeAsk();
        assertEq(
            note.balanceOfByPartition(PARTITION, address(market)),
            0,
            "escrow is a hold on the maker, not a transfer to us"
        );
    }

    function test_RevertWhen_PlacingWithoutAnAllowance() public {
        note.mint(PARTITION, outsider, LOT);
        note.setKyc(outsider, true);

        vm.prank(outsider);
        vm.expectRevert(abi.encodeWithSelector(MockNote.InsufficientAllowance.selector, address(market), outsider));
        market.placeAsk(address(note), NOTE_ID, PARTITION, LOT, PRICE, orderExpiry);
    }

    /// @notice Operator rights are what a bid needs; they are not enough to escrow an ask.
    function test_RevertWhen_OperatorRightsAloneTryToEscrowAnAsk() public {
        note.mint(PARTITION, outsider, LOT);
        note.setKyc(outsider, true);
        vm.prank(outsider);
        note.authorizeOperatorByPartition(PARTITION, address(market));

        vm.prank(outsider);
        vm.expectRevert(abi.encodeWithSelector(MockNote.InsufficientAllowance.selector, address(market), outsider));
        market.placeAsk(address(note), NOTE_ID, PARTITION, LOT, PRICE, orderExpiry);
    }

    function test_PlacingAnAskSpendsTheAllowance() public {
        note.mint(PARTITION, outsider, LOT);
        note.setKyc(outsider, true);
        vm.prank(outsider);
        note.approve(address(market), LOT);

        vm.prank(outsider);
        market.placeAsk(address(note), NOTE_ID, PARTITION, LOT, PRICE, orderExpiry);
        assertEq(note.allowance(outsider, address(market)), 0, "the hold spent exactly the approved amount");
        assertEq(note.heldOfByPartition(PARTITION, outsider), LOT);
    }

    function test_RevertWhen_PlacingWhileHalted() public {
        loadLine.halt(NOTE_ID, "");

        vm.prank(maker);
        vm.expectRevert(abi.encodeWithSelector(LoadLine.NoteHalted.selector, NOTE_ID));
        market.placeAsk(address(note), NOTE_ID, PARTITION, LOT, PRICE, orderExpiry);
    }

    function test_RevertWhen_PlacingBelowTheLine() public {
        loadLine.setThreshold(NOTE_ID, 15_000, "");

        vm.prank(maker);
        vm.expectRevert(
            abi.encodeWithSelector(LoadLine.BelowLoadLine.selector, NOTE_ID, uint64(12_000), uint64(15_000))
        );
        market.placeAsk(address(note), NOTE_ID, PARTITION, LOT, PRICE, orderExpiry);
    }

    function test_RevertWhen_PlacingWithStaleEvidence() public {
        vm.warp(block.timestamp + 2 hours);

        vm.prank(maker);
        vm.expectRevert(
            abi.encodeWithSelector(
                LoadLine.CoverageUnproven.selector,
                NOTE_ID,
                Coverage.Reason.AttestationExpired
            )
        );
        market.placeAsk(address(note), NOTE_ID, PARTITION, LOT, PRICE, orderExpiry);
    }

    function test_RevertWhen_OrderIsMalformed() public {
        vm.startPrank(maker);
        vm.expectRevert(BerthMarket.BadOrder.selector);
        market.placeAsk(address(note), NOTE_ID, PARTITION, 0, PRICE, orderExpiry);

        vm.expectRevert(BerthMarket.BadOrder.selector);
        market.placeAsk(address(note), NOTE_ID, PARTITION, LOT, 0, orderExpiry);

        vm.expectRevert(BerthMarket.BadOrder.selector);
        market.placeAsk(address(note), NOTE_ID, PARTITION, LOT, PRICE, uint64(block.timestamp));
        vm.stopPrank();
    }

    // ------------------------------------------------------------------ settlement

    function test_FillSettlesBothLegsAtomically() public {
        uint256 id = _placeAsk();
        uint256 makerCashBefore = cash.balanceOf(maker);

        vm.prank(taker);
        uint256 paid = market.fill(id, LOT);

        assertEq(paid, uint256(LOT) * PRICE / 1e18);
        assertEq(note.balanceOfByPartition(PARTITION, taker), LOT, "notes reached the taker");
        assertEq(note.heldOfByPartition(PARTITION, maker), 0, "the hold is consumed");
        assertEq(cash.balanceOf(maker), makerCashBefore + paid, "cash reached the maker");

        BerthMarket.Order memory o = market.orderOf(id);
        assertFalse(o.open);
        assertEq(o.remaining, 0);
    }

    function test_PartialFillsLeaveTheRestResting() public {
        uint256 id = _placeAsk();

        vm.prank(taker);
        market.fill(id, 400);

        BerthMarket.Order memory o = market.orderOf(id);
        assertTrue(o.open);
        assertEq(o.remaining, LOT - 400);
        assertEq(note.heldOfByPartition(PARTITION, maker), LOT - 400, "the rest stays escrowed");

        vm.prank(taker);
        market.fill(id, LOT - 400);
        assertFalse(market.orderOf(id).open);
    }

    function test_BidSettlesThroughOperatorTransfer() public {
        // Maker buys; the taker delivers notes, so there is no hold to execute.
        _fundCash(maker, 1_000_000, address(market));
        _fundNotes(taker, 5_000);

        vm.prank(maker);
        uint256 id = market.placeBid(address(note), NOTE_ID, PARTITION, LOT, PRICE, orderExpiry);
        assertEq(note.heldOfByPartition(PARTITION, maker), 0, "a bid escrows no notes");

        uint256 takerCashBefore = cash.balanceOf(taker);
        uint256 makerNotesBefore = note.balanceOfByPartition(PARTITION, maker);

        vm.prank(taker);
        uint256 paid = market.fill(id, LOT);

        assertEq(
            note.balanceOfByPartition(PARTITION, maker),
            makerNotesBefore + LOT,
            "notes reached the bidder"
        );
        assertEq(cash.balanceOf(taker), takerCashBefore + paid, "cash reached the seller");
    }

    function test_RevertWhen_FillingWhileHalted() public {
        uint256 id = _placeAsk();
        loadLine.halt(NOTE_ID, "");

        vm.prank(taker);
        vm.expectRevert(abi.encodeWithSelector(LoadLine.NoteHalted.selector, NOTE_ID));
        market.fill(id, LOT);
    }

    function test_RevertWhen_FillingBelowTheLine() public {
        uint256 id = _placeAsk();
        // Coverage falls under the line after the order was already resting.
        loadLine.setThreshold(NOTE_ID, 20_000, "");

        vm.prank(taker);
        vm.expectRevert(
            abi.encodeWithSelector(LoadLine.BelowLoadLine.selector, NOTE_ID, uint64(12_000), uint64(20_000))
        );
        market.fill(id, LOT);
    }

    function test_RevertWhen_FillingWithStaleEvidence() public {
        uint256 id = _placeAsk();
        vm.warp(block.timestamp + 2 hours);

        vm.prank(taker);
        vm.expectRevert(
            abi.encodeWithSelector(
                LoadLine.CoverageUnproven.selector,
                NOTE_ID,
                Coverage.Reason.AttestationExpired
            )
        );
        market.fill(id, LOT);
    }

    // ------------------------------------------------------------------ pre-flight refusals

    function test_RefusesToMatchWhenTheTakerIsBlocked() public {
        uint256 id = _placeAsk();
        note.setBlocked(taker, true);

        vm.prank(taker);
        vm.expectRevert(
            abi.encodeWithSelector(
                BerthMarket.PreflightRefused.selector,
                id,
                address(note),
                bytes1(0x10),
                bytes32(bytes4(0x796c1f0d)) // AccountIsBlocked(address)
            )
        );
        market.fill(id, LOT);
    }

    function test_RefusesToMatchWhenTheTakerLacksKyc() public {
        uint256 id = _placeAsk();
        note.setKyc(taker, false);

        vm.prank(taker);
        vm.expectRevert(
            abi.encodeWithSelector(
                BerthMarket.PreflightRefused.selector,
                id,
                address(note),
                bytes1(0x10),
                bytes32(bytes4(0xfc855b1b)) // InvalidKycStatus()
            )
        );
        market.fill(id, LOT);
    }

    function test_RefusesToMatchWhenTheNoteIsPaused() public {
        uint256 id = _placeAsk();
        note.setPaused(true);

        vm.prank(taker);
        vm.expectRevert(
            abi.encodeWithSelector(
                BerthMarket.PreflightRefused.selector,
                id,
                address(note),
                bytes1(0x10),
                bytes32(bytes4(0x1309a563)) // IsPaused()
            )
        );
        market.fill(id, LOT);
    }

    function test_RefusesToMatchWhenComplianceSaysNo() public {
        uint256 id = _placeAsk();
        note.setComplianceRefuses(true);

        vm.prank(taker);
        vm.expectRevert(
            abi.encodeWithSelector(
                BerthMarket.PreflightRefused.selector,
                id,
                address(note),
                bytes1(0x10),
                bytes32(bytes4(0x66eb1b54)) // ComplianceNotAllowed()
            )
        );
        market.fill(id, LOT);
    }

    function test_RefusesToMatchWhenTheCashPayerIsFrozen() public {
        uint256 id = _placeAsk();
        // Frozen at the ledger, through the same registry the HTS system contract writes.
        freezeRegistry.set(address(cash), taker, true);

        vm.prank(taker);
        vm.expectRevert(
            abi.encodeWithSelector(
                BerthMarket.PreflightRefused.selector,
                id,
                address(cash),
                bytes1(0x10),
                Preflight.REASON_CASH_FROZEN
            )
        );
        market.fill(id, LOT);
    }

    function test_RefusesToMatchWhenTheTakerCannotPay() public {
        uint256 id = _placeAsk();
        address pauper = makeAddr("pauper");
        note.setKyc(pauper, true);

        vm.prank(pauper);
        vm.expectRevert(
            abi.encodeWithSelector(
                BerthMarket.PreflightRefused.selector,
                id,
                address(cash),
                bytes1(0x10),
                Preflight.REASON_CASH_BALANCE
            )
        );
        market.fill(id, LOT);
    }

    function test_RefusesToMatchWithoutACashAllowance() public {
        uint256 id = _placeAsk();
        address funded = makeAddr("funded");
        note.setKyc(funded, true);
        cash.mint(funded, 1_000_000); // has the money, never approved the venue

        vm.prank(funded);
        vm.expectRevert(
            abi.encodeWithSelector(
                BerthMarket.PreflightRefused.selector,
                id,
                address(cash),
                bytes1(0x10),
                Preflight.REASON_CASH_ALLOWANCE
            )
        );
        market.fill(id, LOT);
    }

    function test_RefusesToMatchWhenThePreflightCannotBeReached() public {
        // A "note" with no compliance surface at all must not be waved through.
        vm.prank(maker);
        vm.expectRevert();
        market.placeAsk(address(0xdead), NOTE_ID, PARTITION, LOT, PRICE, orderExpiry);
    }

    function test_NothingMovesWhenAMatchIsRefused() public {
        uint256 id = _placeAsk();
        note.setBlocked(taker, true);

        uint256 heldBefore = note.heldOfByPartition(PARTITION, maker);
        uint256 cashBefore = cash.balanceOf(taker);

        vm.prank(taker);
        vm.expectRevert();
        market.fill(id, LOT);

        assertEq(note.heldOfByPartition(PARTITION, maker), heldBefore, "escrow untouched");
        assertEq(cash.balanceOf(taker), cashBefore, "cash untouched");
        assertTrue(market.orderOf(id).open, "the order is still resting");
    }

    // ------------------------------------------------------------------ withdrawal

    function test_CancelReleasesTheEscrow() public {
        uint256 id = _placeAsk();
        uint256 before = note.balanceOfByPartition(PARTITION, maker);

        vm.prank(maker);
        market.cancel(id);

        assertEq(note.balanceOfByPartition(PARTITION, maker), before + LOT, "notes came back");
        assertEq(note.heldOfByPartition(PARTITION, maker), 0);
        assertFalse(market.orderOf(id).open);
    }

    function test_CancelWorksWhileHalted() public {
        uint256 id = _placeAsk();
        loadLine.halt(NOTE_ID, "");

        // A halt stops trading. It must not turn into a confiscation of the maker's own notes.
        vm.prank(maker);
        market.cancel(id);
        assertEq(note.heldOfByPartition(PARTITION, maker), 0);
    }

    function test_RevertWhen_CancellingSomeoneElsesOrder() public {
        uint256 id = _placeAsk();

        vm.prank(taker);
        vm.expectRevert(abi.encodeWithSelector(BerthMarket.NotMaker.selector, id, taker));
        market.cancel(id);
    }

    function test_ReapReturnsAnExpiredEscrow() public {
        uint256 id = _placeAsk();
        vm.warp(orderExpiry + 1);

        // Permissionless: a maker who walked away must not leave their notes held forever.
        vm.prank(outsider);
        market.reap(id);

        assertEq(note.balanceOfByPartition(PARTITION, maker), 10_000, "everything came back to the maker");
        assertEq(note.heldOfByPartition(PARTITION, maker), 0);
    }

    function test_RevertWhen_ReapingBeforeExpiry() public {
        uint256 id = _placeAsk();

        vm.expectRevert(abi.encodeWithSelector(BerthMarket.NotYetExpired.selector, id, orderExpiry));
        market.reap(id);
    }

    function test_RevertWhen_FillingAnExpiredOrder() public {
        uint256 id = _placeAsk();
        vm.warp(orderExpiry);

        vm.prank(taker);
        vm.expectRevert(abi.encodeWithSelector(BerthMarket.OrderExpired.selector, id, orderExpiry));
        market.fill(id, LOT);
    }

    function test_RevertWhen_FillingAClosedOrder() public {
        uint256 id = _placeAsk();
        vm.prank(maker);
        market.cancel(id);

        vm.prank(taker);
        vm.expectRevert(abi.encodeWithSelector(BerthMarket.OrderNotOpen.selector, id));
        market.fill(id, LOT);
    }

    function test_RevertWhen_SelfTrading() public {
        uint256 id = _placeAsk();
        _fundCash(maker, 1_000_000, address(market));

        vm.prank(maker);
        vm.expectRevert(BerthMarket.SelfTrade.selector);
        market.fill(id, LOT);
    }

    function test_RevertWhen_OverfillingAnOrder() public {
        uint256 id = _placeAsk();

        vm.prank(taker);
        vm.expectRevert(abi.encodeWithSelector(BerthMarket.InsufficientRemaining.selector, id, LOT, LOT + 1));
        market.fill(id, LOT + 1);
    }

    // ------------------------------------------------------------------ quoting

    function test_QuoteAgreesWithTheFill() public {
        uint256 id = _placeAsk();

        (bool settles, , , , uint256 cost) = market.quote(id, taker, LOT);
        assertTrue(settles);

        vm.prank(taker);
        uint256 paid = market.fill(id, LOT);
        assertEq(paid, cost, "the quote is the price");
    }

    function test_QuoteExplainsACoverageRefusal() public {
        uint256 id = _placeAsk();
        loadLine.halt(NOTE_ID, "");

        (bool settles, Coverage.Reason reason, , , ) = market.quote(id, taker, LOT);
        assertFalse(settles);
        assertEq(uint8(reason), uint8(Coverage.Reason.AuthorityHalt));
    }

    function test_QuoteExplainsAComplianceRefusal() public {
        uint256 id = _placeAsk();
        note.setBlocked(taker, true);

        (bool settles, , bytes32 noteReason, , ) = market.quote(id, taker, LOT);
        assertFalse(settles);
        assertEq(noteReason, bytes32(bytes4(0x796c1f0d)), "the UI gets the ATS selector verbatim");
    }

    // ------------------------------------------------------------------ pricing

    function test_CostRoundsUpTowardsTheNoteSeller() public {
        // A price that does not divide evenly leaves a sub-unit remainder.
        vm.prank(maker);
        uint256 id = market.placeAsk(address(note), NOTE_ID, PARTITION, 3, uint128(1e18) / 3, orderExpiry);

        (, , , , uint256 cost) = market.quote(id, taker, 3);
        assertEq(cost, 1, "rounded up, deterministically, rather than left as an argument");
    }

    function test_Fuzz_FillNeverMovesMoreNotesThanEscrowed(uint128 amount) public {
        amount = uint128(bound(amount, 1, LOT));
        uint256 id = _placeAsk();

        vm.prank(taker);
        market.fill(id, amount);

        assertEq(note.balanceOfByPartition(PARTITION, taker), amount);
        assertEq(note.heldOfByPartition(PARTITION, maker), LOT - amount);
    }
}
