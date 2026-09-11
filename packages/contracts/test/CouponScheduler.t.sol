// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { Base } from "./Base.t.sol";
import { CouponScheduler } from "../src/CouponScheduler.sol";
import { LoadLine } from "../src/LoadLine.sol";
import { Coverage } from "../src/libraries/Coverage.sol";
import { HederaResponse } from "../src/libraries/HederaResponse.sol";
import { MockScheduleService } from "./mocks/Mocks.sol";
import { Owned } from "../src/access/Owned.sol";

contract CouponSchedulerTest is Base {
    uint128 internal constant COUPON = 50_000;
    uint64 internal constant PERIOD = 30 days;
    uint64 internal firstPaymentAt;
    uint64 internal maturity;

    function setUp() public override {
        super.setUp();
        firstPaymentAt = uint64(block.timestamp + 10 days);
        maturity = firstPaymentAt + 2 * PERIOD;

        _attest(12_000);
        _fundCash(issuer, 10_000_000, address(scheduler));
    }

    function _params() internal view returns (CouponScheduler.ScheduleParams memory) {
        return
            CouponScheduler.ScheduleParams({
                note: address(note),
                project: issuer,
                payer: issuer,
                paymentAgent: paymentAgent,
                couponAmount: COUPON,
                firstPaymentAt: firstPaymentAt,
                period: PERIOD,
                maturity: maturity,
                gasLimit: 400_000,
                maxPeriods: 12
            });
    }

    function _create() internal {
        scheduler.createSchedule(NOTE_ID, _params());
    }

    /// @dev Re-attests so coverage stays proven after a warp past the previous expiry.
    function _refresh(uint64 bps) internal {
        _attest(bps);
    }

    // ------------------------------------------------------------------ arming

    function test_ArmBooksTheFirstCallAtTheDueSecond() public {
        _create();
        scheduler.arm(NOTE_ID);

        assertEq(schedules.bookingCount(), 1);
        MockScheduleService.Booking memory b = schedules.lastBooking();
        assertEq(b.to, address(scheduler));
        assertEq(b.expirySecond, firstPaymentAt);
        assertEq(b.callData, abi.encodeCall(scheduler.executeCoupon, (NOTE_ID)));
        assertTrue(scheduler.scheduleOf(NOTE_ID).armed);
    }

    function test_RevertWhen_ArmingBelowTheLine() public {
        _create();
        loadLine.setThreshold(NOTE_ID, 20_000, "");

        // No reason to commit ledger capacity to a payment we already know we would withhold.
        vm.expectRevert(
            abi.encodeWithSelector(LoadLine.BelowLoadLine.selector, NOTE_ID, uint64(12_000), uint64(20_000))
        );
        scheduler.arm(NOTE_ID);
        assertEq(schedules.bookingCount(), 0);
    }

    function test_RevertWhen_ArmingWhileHalted() public {
        _create();
        loadLine.halt(NOTE_ID, "");

        vm.expectRevert(abi.encodeWithSelector(LoadLine.NoteHalted.selector, NOTE_ID));
        scheduler.arm(NOTE_ID);
    }

    function test_RevertWhen_ArmingTwice() public {
        _create();
        scheduler.arm(NOTE_ID);

        vm.expectRevert(abi.encodeWithSelector(CouponScheduler.AlreadyArmed.selector, NOTE_ID));
        scheduler.arm(NOTE_ID);
    }

    function test_RevertWhen_LedgerHasNoCapacity() public {
        _create();
        schedules.setCapacity(false);

        vm.expectRevert(
            abi.encodeWithSelector(CouponScheduler.NoCapacity.selector, uint256(firstPaymentAt), uint256(400_000))
        );
        scheduler.arm(NOTE_ID);
    }

    function test_RevertWhen_CreatingScheduleAsNonOwner() public {
        vm.prank(outsider);
        vm.expectRevert(abi.encodeWithSelector(Owned.NotOwner.selector, outsider));
        scheduler.createSchedule(NOTE_ID, _params());
    }

    function test_RevertWhen_CancellingAsNonOwner() public {
        _create();
        vm.prank(outsider);
        vm.expectRevert(abi.encodeWithSelector(Owned.NotOwner.selector, outsider));
        scheduler.cancelSchedule(NOTE_ID);
    }

    // ------------------------------------------------------------------ the response code

    function test_ArmSurfacesANonSuccessResponseCode() public {
        _create();
        // 0x16b signals failure by return value. A scheduler that assumes success is broken.
        schedules.setNextResponseCode(int64(7));

        vm.expectRevert(abi.encodeWithSelector(HederaResponse.HederaCallFailed.selector, int64(7)));
        scheduler.arm(NOTE_ID);
        assertFalse(scheduler.scheduleOf(NOTE_ID).armed);
    }

    function test_RejectedRescheduleLeavesTheLoopRecoverable() public {
        _create();
        scheduler.arm(NOTE_ID);

        vm.warp(firstPaymentAt);
        _refresh(12_000);
        // The re-arm inside the scheduled execution is refused by the ledger.
        schedules.setNextResponseCode(int64(29));

        vm.expectEmit(true, false, false, false);
        emit CouponScheduler.ScheduleRejected(NOTE_ID, 0, 0);
        schedules.fire(0);

        CouponScheduler.Schedule memory s = scheduler.scheduleOf(NOTE_ID);
        assertFalse(s.armed, "nothing is booked");
        assertTrue(s.active, "but the schedule is not dead");
        assertEq(s.paymentsMade, 1, "and the coupon that was due still paid");

        // Recovery is a single permissionless call.
        scheduler.rearm(NOTE_ID);
        assertTrue(scheduler.scheduleOf(NOTE_ID).armed);
    }

    // ------------------------------------------------------------------ paying

    function test_PaysTheCouponAndRecordsCoverageAsAKpi() public {
        _create();
        scheduler.arm(NOTE_ID);

        vm.warp(firstPaymentAt);
        _refresh(12_000);

        uint256 agentBefore = cash.balanceOf(paymentAgent);
        schedules.fire(0);

        assertEq(cash.balanceOf(paymentAgent), agentBefore + COUPON, "the coupon was paid");
        assertEq(scheduler.scheduleOf(NOTE_ID).paymentsMade, 1);
        assertEq(note.kpiAt(issuer, firstPaymentAt), 12_000, "coverage reached the ATS KPI series");
    }

    function test_RebooksItselfForTheNextPeriod() public {
        _create();
        scheduler.arm(NOTE_ID);

        vm.warp(firstPaymentAt);
        _refresh(12_000);
        schedules.fire(0);

        assertEq(schedules.bookingCount(), 2, "the loop booked its own next leg");
        assertEq(schedules.lastBooking().expirySecond, firstPaymentAt + PERIOD);
        assertEq(scheduler.scheduleOf(NOTE_ID).nextPaymentAt, firstPaymentAt + PERIOD);
    }

    // ------------------------------------------------------------------ withholding

    function test_WithholdsTheCouponBelowTheLineButKeepsTheLoopAlive() public {
        _create();
        scheduler.arm(NOTE_ID);

        vm.warp(firstPaymentAt);
        _refresh(9_000); // short

        uint256 agentBefore = cash.balanceOf(paymentAgent);

        vm.expectEmit(true, false, false, true);
        emit CouponScheduler.CouponWithheld(NOTE_ID, firstPaymentAt, Coverage.Reason.BelowLoadLine);
        schedules.fire(0);

        assertEq(cash.balanceOf(paymentAgent), agentBefore, "nothing moved");
        CouponScheduler.Schedule memory s = scheduler.scheduleOf(NOTE_ID);
        assertEq(s.paymentsMade, 0);
        assertEq(s.paymentsMissed, 1);
        assertTrue(s.armed, "an unpaid coupon is a credit event, not a reason to stop watching");
    }

    function test_WithholdsWhenCoverageIsMerelyUnproven() public {
        _create();
        scheduler.arm(NOTE_ID);

        // Let the attestation lapse rather than go short.
        vm.warp(firstPaymentAt);

        vm.expectEmit(true, false, false, true);
        emit CouponScheduler.CouponWithheld(NOTE_ID, firstPaymentAt, Coverage.Reason.AttestationExpired);
        schedules.fire(0);

        assertEq(scheduler.scheduleOf(NOTE_ID).paymentsMade, 0);
    }

    function test_WithholdsWhileHalted() public {
        _create();
        scheduler.arm(NOTE_ID);

        vm.warp(firstPaymentAt);
        _refresh(12_000);
        loadLine.halt(NOTE_ID, "");

        vm.expectEmit(true, false, false, true);
        emit CouponScheduler.CouponWithheld(NOTE_ID, firstPaymentAt, Coverage.Reason.AuthorityHalt);
        schedules.fire(0);

        assertEq(scheduler.scheduleOf(NOTE_ID).paymentsMade, 0);
    }

    function test_ResumesPayingOnceCoverageRecovers() public {
        _create();
        scheduler.arm(NOTE_ID);

        vm.warp(firstPaymentAt);
        _refresh(9_000);
        schedules.fire(0); // withheld

        vm.warp(firstPaymentAt + PERIOD);
        _refresh(13_000);
        schedules.fire(1); // paid

        CouponScheduler.Schedule memory s = scheduler.scheduleOf(NOTE_ID);
        assertEq(s.paymentsMissed, 1);
        assertEq(s.paymentsMade, 1);
    }

    function test_UnfundedCouponIsReportedNotThrown() public {
        _create();
        scheduler.arm(NOTE_ID);

        // The issuer's cash is frozen at the ledger. Coverage is fine; the money cannot move.
        vm.warp(firstPaymentAt);
        _refresh(12_000);
        freezeRegistry.set(address(cash), issuer, true);

        vm.expectEmit(true, false, false, true);
        emit CouponScheduler.CouponUnfunded(NOTE_ID, firstPaymentAt, COUPON);
        schedules.fire(0);

        CouponScheduler.Schedule memory s = scheduler.scheduleOf(NOTE_ID);
        assertEq(s.paymentsMade, 0);
        assertEq(s.paymentsMissed, 1);
        assertTrue(s.armed, "a swallowed payment failure must not kill the self-rescheduling loop");
    }

    function test_KpiWriteFailureDoesNotCostTheCoupon() public {
        _create();
        scheduler.arm(NOTE_ID);

        vm.warp(firstPaymentAt);
        _refresh(12_000);
        // ATS rejects a duplicate date; the coupon must survive it.
        note.addKpiData(firstPaymentAt, 1, issuer);

        vm.expectEmit(true, false, false, true);
        emit CouponScheduler.CoveragePushFailed(NOTE_ID, firstPaymentAt);
        schedules.fire(0);

        assertEq(scheduler.scheduleOf(NOTE_ID).paymentsMade, 1, "the coupon still paid");
    }

    // ------------------------------------------------------------------ hopping and termination

    function test_HopsWhenTheNextCouponIsPastTheLedgerHorizon() public {
        uint64 farOff = uint64(block.timestamp + 100 days);
        CouponScheduler.ScheduleParams memory p = _params();
        p.firstPaymentAt = farOff;
        p.maturity = farOff + PERIOD;
        scheduler.createSchedule(NOTE_ID, p);
        scheduler.arm(NOTE_ID);

        // Hedera will not take a schedule 100 days out, so the first booking is a wake-up.
        uint256 horizon = block.timestamp + scheduler.SCHEDULE_HORIZON();
        assertEq(schedules.lastBooking().expirySecond, horizon);

        vm.warp(horizon);
        _refresh(12_000);

        vm.expectEmit(true, false, false, true);
        emit CouponScheduler.Hopped(NOTE_ID, farOff);
        schedules.fire(0);

        // Nothing paid, and the next leg lands on the real date now that it is inside the horizon.
        assertEq(scheduler.scheduleOf(NOTE_ID).paymentsMade, 0);
        assertEq(schedules.lastBooking().expirySecond, farOff);
    }

    function test_TerminatesAtMaturity() public {
        _create();
        scheduler.arm(NOTE_ID);

        uint64 due = firstPaymentAt;
        for (uint256 i; i < 3; ++i) {
            vm.warp(due);
            _refresh(12_000);
            schedules.fire(i);
            due += PERIOD;
        }

        CouponScheduler.Schedule memory s = scheduler.scheduleOf(NOTE_ID);
        assertFalse(s.active, "the loop stops at maturity");
        assertFalse(s.armed, "and books nothing further");
        assertEq(s.paymentsMade, 3);
        assertEq(schedules.bookingCount(), 3, "no fourth booking was ever made");
    }

    function test_RevertWhen_ExecutingACompletedSchedule() public {
        _create();
        scheduler.arm(NOTE_ID);

        uint64 due = firstPaymentAt;
        for (uint256 i; i < 3; ++i) {
            vm.warp(due);
            _refresh(12_000);
            schedules.fire(i);
            due += PERIOD;
        }

        vm.expectRevert(abi.encodeWithSelector(CouponScheduler.ScheduleInactive.selector, NOTE_ID));
        scheduler.executeCoupon(NOTE_ID);
    }

    function test_MaxPeriodsStopsARunawayLoopEvenIfTheDatesWouldNot() public {
        CouponScheduler.ScheduleParams memory p = _params();
        p.maturity = uint64(block.timestamp + 3650 days); // effectively never
        p.maxPeriods = 2; // the hard stop
        scheduler.createSchedule(NOTE_ID, p);
        scheduler.arm(NOTE_ID);

        uint64 due = firstPaymentAt;
        for (uint256 i; i < 2; ++i) {
            vm.warp(due);
            _refresh(12_000);
            schedules.fire(i);
            due += PERIOD;
        }

        CouponScheduler.Schedule memory s = scheduler.scheduleOf(NOTE_ID);
        assertFalse(s.active, "the period cap ended it regardless of maturity");
        assertEq(s.periodsElapsed, 2);
        assertEq(schedules.bookingCount(), 2);
    }

    function test_EarlyExecutionPaysNothing() public {
        _create();
        scheduler.arm(NOTE_ID);

        // Anyone may call it; before the due second it is a no-op that only books the next leg.
        vm.prank(outsider);
        scheduler.executeCoupon(NOTE_ID);

        assertEq(scheduler.scheduleOf(NOTE_ID).paymentsMade, 0);
        assertEq(cash.balanceOf(paymentAgent), 0);
    }

    function test_EachPeriodPaysAtMostOnce() public {
        _create();
        scheduler.arm(NOTE_ID);

        vm.warp(firstPaymentAt);
        _refresh(12_000);
        schedules.fire(0);
        assertEq(scheduler.scheduleOf(NOTE_ID).paymentsMade, 1);

        // A second call in the same period is early for the *next* coupon, so it pays nothing.
        vm.prank(outsider);
        scheduler.executeCoupon(NOTE_ID);
        assertEq(scheduler.scheduleOf(NOTE_ID).paymentsMade, 1);
        assertEq(cash.balanceOf(paymentAgent), COUPON);
    }

    // ------------------------------------------------------------------ coverage ingress

    function test_PushCoverageWritesAProvableNumber() public {
        _create();
        scheduler.pushCoverage(NOTE_ID, block.timestamp);
        assertEq(note.kpiAt(issuer, block.timestamp), 12_000);
    }

    function test_PushCoverageWritesLowNumbersToo() public {
        // A short reading is exactly the signal the KPI-linked rate facet needs; suppressing it
        // would flatter the issuer.
        _create();
        _refresh(4_000);
        scheduler.pushCoverage(NOTE_ID, block.timestamp);
        assertEq(note.kpiAt(issuer, block.timestamp), 4_000);
    }

    function test_RevertWhen_PushingUnprovableCoverage() public {
        _create();
        vm.warp(block.timestamp + 2 hours); // attestation lapsed

        vm.expectRevert(CouponScheduler.BadSchedule.selector);
        scheduler.pushCoverage(NOTE_ID, block.timestamp);
    }

    // ------------------------------------------------------------------ validation

    function test_RevertWhen_ScheduleParamsAreNonsense() public {
        CouponScheduler.ScheduleParams memory p = _params();

        p.period = 0;
        vm.expectRevert(CouponScheduler.BadSchedule.selector);
        scheduler.createSchedule(NOTE_ID, p);

        p = _params();
        p.maturity = p.firstPaymentAt - 1;
        vm.expectRevert(CouponScheduler.BadSchedule.selector);
        scheduler.createSchedule(NOTE_ID, p);

        p = _params();
        p.maxPeriods = 0;
        vm.expectRevert(CouponScheduler.BadSchedule.selector);
        scheduler.createSchedule(NOTE_ID, p);

        p = _params();
        p.firstPaymentAt = uint64(block.timestamp);
        vm.expectRevert(CouponScheduler.BadSchedule.selector);
        scheduler.createSchedule(NOTE_ID, p);
    }

    function test_CancelStopsTheLoop() public {
        _create();
        scheduler.arm(NOTE_ID);
        scheduler.cancelSchedule(NOTE_ID);

        vm.warp(firstPaymentAt);
        _refresh(12_000);
        (bool ok, ) = schedules.fire(0);
        assertFalse(ok, "a cancelled schedule refuses to execute");
        assertEq(cash.balanceOf(paymentAgent), 0);
    }

    function test_BookingTimeIsAlwaysStrictlyInTheFuture() public {
        CouponScheduler.ScheduleParams memory p = _params();
        p.firstPaymentAt = uint64(block.timestamp + 1);
        scheduler.createSchedule(NOTE_ID, p);
        scheduler.arm(NOTE_ID);

        // Hedera rejects an expiry that is not strictly greater than the consensus second.
        assertGt(schedules.lastBooking().expirySecond, block.timestamp);
    }

    function test_Fuzz_NeverPaysWhileUnderTheLine(uint64 bps) public {
        bps = uint64(bound(bps, 0, THRESHOLD_BPS - 1));
        _create();
        scheduler.arm(NOTE_ID);

        vm.warp(firstPaymentAt);
        _refresh(bps);
        schedules.fire(0);

        assertEq(scheduler.scheduleOf(NOTE_ID).paymentsMade, 0);
        assertEq(cash.balanceOf(paymentAgent), 0);
    }
}
