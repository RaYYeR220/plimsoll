// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { Base } from "./Base.t.sol";
import { BerthMarket } from "../src/BerthMarket.sol";
import { CouponScheduler } from "../src/CouponScheduler.sol";
import { LoadLine } from "../src/LoadLine.sol";
import { Coverage } from "../src/libraries/Coverage.sol";

/// @notice Issue, place, match, settle, coupon - and then the same note failing the line.
contract EndToEndTest is Base {
    uint128 internal constant LOT = 5_000;
    uint128 internal constant PRICE = 3e18;
    uint128 internal constant COUPON = 25_000;

    function test_HappyPath_IssueToCoupon() public {
        // --- issue -------------------------------------------------------------------------
        _attest(13_500);
        _fundNotes(maker, 100_000);
        _fundCash(taker, 10_000_000, address(market));
        _fundCash(issuer, 10_000_000, address(scheduler));

        (bool clear, Coverage.Verdict verdict, , uint64 bps, uint64 line) = loadLine.status(NOTE_ID);
        assertTrue(clear);
        assertEq(uint8(verdict), uint8(Coverage.Verdict.Covered));
        assertEq(bps, 13_500);
        assertEq(line, THRESHOLD_BPS);

        // --- place -------------------------------------------------------------------------
        uint64 expiry = uint64(block.timestamp + 30 days);
        vm.prank(maker);
        uint256 orderId = market.placeAsk(address(note), NOTE_ID, PARTITION, LOT, PRICE, expiry);
        assertEq(note.heldOfByPartition(PARTITION, maker), LOT, "the maker's notes are escrowed in ATS");

        // --- match -------------------------------------------------------------------------
        (bool settles, , bytes32 noteReason, bytes32 cashReason, uint256 quoted) = market.quote(
            orderId,
            taker,
            LOT
        );
        assertTrue(settles, "the pre-flight cleared both legs before anything was booked");
        assertEq(noteReason, bytes32(0));
        assertEq(cashReason, bytes32(0));

        // --- settle ------------------------------------------------------------------------
        uint256 makerCashBefore = cash.balanceOf(maker);
        vm.prank(taker);
        uint256 paid = market.fill(orderId, LOT);

        assertEq(paid, quoted);
        assertEq(note.balanceOfByPartition(PARTITION, taker), LOT, "the buyer holds the notes");
        assertEq(cash.balanceOf(maker), makerCashBefore + paid, "the seller holds the cash");
        assertEq(note.heldOfByPartition(PARTITION, maker), 0, "the escrow is gone");
        assertFalse(market.orderOf(orderId).open);

        // --- coupon ------------------------------------------------------------------------
        uint64 firstPaymentAt = uint64(block.timestamp + 20 days);
        scheduler.createSchedule(
            NOTE_ID,
            CouponScheduler.ScheduleParams({
                note: address(note),
                project: issuer,
                payer: issuer,
                paymentAgent: paymentAgent,
                couponAmount: COUPON,
                firstPaymentAt: firstPaymentAt,
                period: 30 days,
                maturity: firstPaymentAt + 30 days,
                gasLimit: 400_000,
                maxPeriods: 4
            })
        );
        scheduler.arm(NOTE_ID);
        assertEq(schedules.lastBooking().expirySecond, firstPaymentAt);

        vm.warp(firstPaymentAt);
        _attest(13_500);
        schedules.fire(0);

        assertEq(cash.balanceOf(paymentAgent), COUPON, "the coupon paid");
        assertEq(note.kpiAt(issuer, firstPaymentAt), 13_500, "coverage drove the ATS KPI series");
        assertEq(scheduler.scheduleOf(NOTE_ID).paymentsMade, 1);

        // The loop booked its own next leg, with no keeper anywhere in this test.
        assertEq(schedules.bookingCount(), 2);
        assertEq(schedules.lastBooking().expirySecond, firstPaymentAt + 30 days);
    }

    function test_SadPath_CoverageFallsAndTheMarketCloses() public {
        _attest(13_500);
        _fundNotes(maker, 100_000);
        _fundCash(taker, 10_000_000, address(market));
        _fundCash(issuer, 10_000_000, address(scheduler));

        uint64 expiry = uint64(block.timestamp + 30 days);
        vm.prank(maker);
        uint256 orderId = market.placeAsk(address(note), NOTE_ID, PARTITION, LOT, PRICE, expiry);

        uint64 firstPaymentAt = uint64(block.timestamp + 20 days);
        scheduler.createSchedule(
            NOTE_ID,
            CouponScheduler.ScheduleParams({
                note: address(note),
                project: issuer,
                payer: issuer,
                paymentAgent: paymentAgent,
                couponAmount: COUPON,
                firstPaymentAt: firstPaymentAt,
                period: 30 days,
                maturity: firstPaymentAt + 30 days,
                gasLimit: 400_000,
                maxPeriods: 4
            })
        );
        scheduler.arm(NOTE_ID);

        // The vaults drain. The next attestation is honest about it.
        vm.warp(block.timestamp + 1 days);
        _attest(8_000);

        (bool clear, Coverage.Verdict verdict, Coverage.Reason reason, , ) = loadLine.status(NOTE_ID);
        assertFalse(clear);
        assertEq(uint8(verdict), uint8(Coverage.Verdict.Short));
        assertEq(uint8(reason), uint8(Coverage.Reason.BelowLoadLine));

        // The resting order can no longer be matched.
        vm.prank(taker);
        vm.expectRevert(
            abi.encodeWithSelector(LoadLine.BelowLoadLine.selector, NOTE_ID, uint64(8_000), THRESHOLD_BPS)
        );
        market.fill(orderId, LOT);

        // No new orders either.
        vm.prank(maker);
        vm.expectRevert(
            abi.encodeWithSelector(LoadLine.BelowLoadLine.selector, NOTE_ID, uint64(8_000), THRESHOLD_BPS)
        );
        market.placeAsk(address(note), NOTE_ID, PARTITION, LOT, PRICE, expiry);

        // The coupon is withheld rather than paid, and the schedule stays alive to try again.
        vm.warp(firstPaymentAt);
        _attest(8_000);
        schedules.fire(0);
        assertEq(cash.balanceOf(paymentAgent), 0, "no coupon while the note is short");
        assertTrue(scheduler.scheduleOf(NOTE_ID).armed);

        // The maker can still take their own notes back. A halt is not a seizure.
        vm.prank(maker);
        market.cancel(orderId);
        assertEq(note.balanceOfByPartition(PARTITION, maker), 100_000);

        // Coverage recovers, and the venue reopens on its own.
        vm.warp(firstPaymentAt + 30 days);
        _attest(14_000);
        loadLine.requireClear(NOTE_ID);
        schedules.fire(1);
        assertEq(cash.balanceOf(paymentAgent), COUPON, "paying resumes without intervention");
    }
}
