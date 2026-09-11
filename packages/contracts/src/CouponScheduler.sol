// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { Coverage } from "./libraries/Coverage.sol";
import { HederaResponse } from "./libraries/HederaResponse.sol";
import { ICoverageOracle, ILoadLine } from "./interfaces/IPlimsoll.sol";
import { Owned } from "./access/Owned.sol";
import { IHederaScheduleService } from "./interfaces/IHederaScheduleService.sol";
import { IAtsKpis } from "./interfaces/IAts.sol";
import { IERC20 } from "./interfaces/IERC20.sol";

/**
 * @title CouponScheduler
 * @notice Coupon payments that fire on their own, from the ledger's own scheduler, with no keeper.
 *
 * @dev Built on HIP-1215 `scheduleCall`. Hedera's scheduled transactions are one-shot and cannot
 *      be placed more than 62 days out, so a recurring coupon has to re-arm itself from inside
 *      its own execution. That is the interesting part and also the dangerous part, so the loop
 *      is bounded three independent ways: it stops at `maturity`, it stops after `maxPeriods`
 *      regardless of any date arithmetic, and every period strictly advances `nextPaymentAt`. If
 *      all three of those are wrong at once the schedule still cannot outlive `maxPeriods`.
 *
 *      Coupons longer than the 62-day ceiling - which is most of them, quarterly included - are
 *      reached by hopping. The scheduler wakes itself at the horizon, notices it is early, pays
 *      nothing, and re-arms. {executeCoupon} is the only entry point either way; an early wake-up
 *      is just a no-op that books the next one.
 *
 *      **Failures inside a scheduled execution are swallowed on purpose.** If the KPI write or
 *      the cash transfer reverted, that revert would roll back the re-arm too and the schedule
 *      would die silently at the first missed coupon - the exact failure mode a self-rescheduling
 *      design exists to avoid. So payment failures are caught, counted and evented, never thrown.
 *      This is a real trade-off: an unfunded coupon looks like a successful transaction with a
 *      `CouponUnfunded` log rather than a failed one, and anything watching this contract has to
 *      watch the events, not the receipts. The safety property is preserved elsewhere - coverage
 *      is checked *before* the payment attempt, so a swallowed failure can never become a payment.
 *
 *      Calls into 0x16b never revert; they return an `int64`. A rejected schedule leaves `armed`
 *      false, emits {ScheduleRejected}, and waits for someone to call {rearm}. It does not
 *      pretend to have succeeded.
 */
contract CouponScheduler is Owned {
    struct Schedule {
        /// @dev The ATS token, for the KPI write that drives the coupon rate.
        address note;
        /// @dev The KPI "project" address the rate facet aggregates over.
        address project;
        /// @dev Account funding the coupon; must have approved this contract for cash.
        address payer;
        /// @dev Where the coupon cash lands for distribution to holders.
        address paymentAgent;
        uint128 couponAmount;
        uint64 nextPaymentAt;
        uint64 period;
        uint64 maturity;
        uint64 gasLimit;
        uint32 periodsElapsed;
        uint32 maxPeriods;
        uint32 paymentsMade;
        uint32 paymentsMissed;
        bool active;
        bool armed;
    }

    /// @notice Everything a schedule needs at creation, grouped so the call site stays readable.
    struct ScheduleParams {
        address note;
        address project;
        address payer;
        address paymentAgent;
        uint128 couponAmount;
        uint64 firstPaymentAt;
        uint64 period;
        uint64 maturity;
        uint64 gasLimit;
        uint32 maxPeriods;
    }

    /// @dev Hedera's ceiling is 62 days. Sitting well under it leaves room for a late wake-up.
    uint256 public constant SCHEDULE_HORIZON = 55 days;
    uint256 public constant MAX_PERIODS_LIMIT = 4000;


    IHederaScheduleService public constant SCHEDULE_SERVICE = IHederaScheduleService(address(0x16b));

    ILoadLine public immutable loadLine;
    ICoverageOracle public immutable oracle;
    IERC20 public immutable cash;

    mapping(bytes32 => Schedule) private _schedules;
    mapping(bytes32 => address) private _lastScheduleAddress;

    error ZeroAddress();
    error BadSchedule();
    error UnknownSchedule(bytes32 noteId);
    error ScheduleInactive(bytes32 noteId);
    error AlreadyArmed(bytes32 noteId);
    error NoCapacity(uint256 expirySecond, uint256 gasLimit);

    event ScheduleCreated(
        bytes32 indexed noteId,
        address note,
        address payer,
        uint128 couponAmount,
        uint64 firstPaymentAt,
        uint64 period,
        uint64 maturity
    );
    event ScheduleArmed(bytes32 indexed noteId, uint256 expirySecond, address scheduleAddress);
    /// @dev The response code from 0x16b was not 22. Nothing is armed; {rearm} is the recovery.
    event ScheduleRejected(bytes32 indexed noteId, int64 responseCode, uint256 expirySecond);
    event ScheduleCompleted(bytes32 indexed noteId, uint32 paymentsMade, uint32 paymentsMissed);
    event ScheduleCancelled(bytes32 indexed noteId);
    event Hopped(bytes32 indexed noteId, uint64 dueAt);
    event CouponPaid(bytes32 indexed noteId, uint64 dueAt, uint256 amount, uint64 coverageBps);
    /// @dev Coverage was under the line or unproven. Nothing moved, and that is the product.
    event CouponWithheld(bytes32 indexed noteId, uint64 dueAt, Coverage.Reason reason);
    /// @dev Coverage was fine but the cash did not move - no allowance, no balance, or frozen.
    event CouponUnfunded(bytes32 indexed noteId, uint64 dueAt, uint256 amount);
    event CoveragePushed(bytes32 indexed noteId, uint256 date, uint64 coverageBps);
    event CoveragePushFailed(bytes32 indexed noteId, uint256 date);

    constructor(ILoadLine loadLine_, ICoverageOracle oracle_, IERC20 cash_, address owner_) Owned(owner_) {
        if (
            address(loadLine_) == address(0) || address(oracle_) == address(0) || address(cash_) == address(0)
        ) revert ZeroAddress();
        loadLine = loadLine_;
        oracle = oracle_;
        cash = cash_;
    }

    // ---------------------------------------------------------------------------------------
    // Setup
    // ---------------------------------------------------------------------------------------

    function createSchedule(bytes32 noteId, ScheduleParams calldata p) external onlyOwner {
        if (p.note == address(0) || p.payer == address(0) || p.paymentAgent == address(0)) revert ZeroAddress();
        if (
            p.period == 0 ||
            p.firstPaymentAt <= block.timestamp ||
            p.maturity < p.firstPaymentAt ||
            p.maxPeriods == 0 ||
            p.maxPeriods > MAX_PERIODS_LIMIT ||
            p.gasLimit == 0
        ) revert BadSchedule();

        _schedules[noteId] = Schedule({
            note: p.note,
            project: p.project,
            payer: p.payer,
            paymentAgent: p.paymentAgent,
            couponAmount: p.couponAmount,
            nextPaymentAt: p.firstPaymentAt,
            period: p.period,
            maturity: p.maturity,
            gasLimit: p.gasLimit,
            periodsElapsed: 0,
            maxPeriods: p.maxPeriods,
            paymentsMade: 0,
            paymentsMissed: 0,
            active: true,
            armed: false
        });

        emit ScheduleCreated(noteId, p.note, p.payer, p.couponAmount, p.firstPaymentAt, p.period, p.maturity);
    }

    /**
     * @notice Books the first scheduled call for a note.
     * @dev Refuses outright when coverage is under the line. There is no reason to commit ledger
     *      capacity to a payment we already know we would withhold.
     */
    function arm(bytes32 noteId) external {
        Schedule storage s = _schedules[noteId];
        if (s.note == address(0)) revert UnknownSchedule(noteId);
        if (!s.active) revert ScheduleInactive(noteId);
        if (s.armed) revert AlreadyArmed(noteId);

        loadLine.requireClear(noteId);
        _book(noteId, s, true);
    }

    /**
     * @notice Re-books a schedule whose last {scheduleCall} was rejected by the ledger.
     * @dev Permissionless and idempotent-ish: it only does anything when nothing is armed. This
     *      is the recovery path for the one failure the scheduler cannot fix from inside itself.
     */
    function rearm(bytes32 noteId) external {
        Schedule storage s = _schedules[noteId];
        if (s.note == address(0)) revert UnknownSchedule(noteId);
        if (!s.active) revert ScheduleInactive(noteId);
        if (s.armed) revert AlreadyArmed(noteId);

        _book(noteId, s, true);
    }

    function cancelSchedule(bytes32 noteId) external onlyOwner {
        Schedule storage s = _schedules[noteId];
        if (s.note == address(0)) revert UnknownSchedule(noteId);

        s.active = false;
        s.armed = false;
        emit ScheduleCancelled(noteId);
    }

    // ---------------------------------------------------------------------------------------
    // The loop
    // ---------------------------------------------------------------------------------------

    /**
     * @notice Pays the coupon due for `noteId`, then books the next one.
     * @dev The target of every scheduled call this contract makes.
     *
     *      Deliberately permissionless. Restricting it to the scheduler would mean asserting
     *      what `msg.sender` looks like inside a HIP-1215 execution, and getting that assertion
     *      wrong strands every coupon in the system. Openness is safe here because nothing
     *      depends on the caller: the work is gated on `block.timestamp >= nextPaymentAt`, each
     *      period is paid at most once, and an early call is a no-op that costs the caller gas.
     */
    function executeCoupon(bytes32 noteId) external {
        Schedule storage s = _schedules[noteId];
        if (s.note == address(0)) revert UnknownSchedule(noteId);
        if (!s.active) revert ScheduleInactive(noteId);

        // Whatever booked this call has now been consumed.
        s.armed = false;

        uint64 dueAt = s.nextPaymentAt;
        if (block.timestamp < dueAt) {
            // A horizon hop, not a payment date. Book the next leg and get out.
            emit Hopped(noteId, dueAt);
            _book(noteId, s, false);
            return;
        }

        // Written whatever the number is: a low coverage reading is exactly the signal the
        // KPI-linked rate facet needs, and suppressing it would flatter the issuer. What we never
        // write is a number we cannot prove.
        _pushCoverage(noteId, s, dueAt);

        (bool clear, , Coverage.Reason reason, uint64 coverageBps, ) = loadLine.status(noteId);
        if (!clear) {
            s.paymentsMissed += 1;
            emit CouponWithheld(noteId, dueAt, reason);
        } else if (_tryPay(s.payer, s.paymentAgent, s.couponAmount)) {
            s.paymentsMade += 1;
            emit CouponPaid(noteId, dueAt, s.couponAmount, coverageBps);
        } else {
            s.paymentsMissed += 1;
            emit CouponUnfunded(noteId, dueAt, s.couponAmount);
        }

        s.periodsElapsed += 1;

        uint256 next = uint256(dueAt) + uint256(s.period);
        // Three independent stops. Any one of them ends the loop; all three would have to be
        // wrong simultaneously for it to run on.
        if (next > s.maturity || s.periodsElapsed >= s.maxPeriods || next > type(uint64).max) {
            s.active = false;
            emit ScheduleCompleted(noteId, s.paymentsMade, s.paymentsMissed);
            return;
        }

        // Safe: the branch above returns when `next` exceeds the uint64 range.
        // forge-lint: disable-next-line(unsafe-typecast)
        s.nextPaymentAt = uint64(next);
        _book(noteId, s, false);
    }

    /**
     * @notice Writes the current provable coverage into the note's ATS KPI series.
     * @dev Permissionless, and usable between coupons so the rate facet always has a recent
     *      point. Reverts if there is nothing provable to write - an unproven reading must not
     *      be laundered into the coupon rate as a zero.
     */
    function pushCoverage(bytes32 noteId, uint256 date) external {
        Schedule storage s = _schedules[noteId];
        if (s.note == address(0)) revert UnknownSchedule(noteId);

        (uint64 bps, Coverage.Reason reason) = oracle.evidenceOf(noteId);
        if (reason != Coverage.Reason.None) revert BadSchedule();

        IAtsKpis(s.note).addKpiData(date, bps, s.project);
        emit CoveragePushed(noteId, date, bps);
    }

    // ---------------------------------------------------------------------------------------
    // Reads
    // ---------------------------------------------------------------------------------------

    function scheduleOf(bytes32 noteId) external view returns (Schedule memory) {
        return _schedules[noteId];
    }

    function lastScheduleAddress(bytes32 noteId) external view returns (address) {
        return _lastScheduleAddress[noteId];
    }

    /// @notice The consensus second the next scheduled call would be booked for, right now.
    function nextBookingAt(bytes32 noteId) external view returns (uint256) {
        return _bookingTime(_schedules[noteId].nextPaymentAt);
    }

    // ---------------------------------------------------------------------------------------
    // Internals
    // ---------------------------------------------------------------------------------------

    /**
     * @dev Books one scheduled call. `strict` reverts on rejection - correct for a user-initiated
     *      {arm}, where the caller wants to know. Inside {executeCoupon} it is false: a rejection
     *      there must not roll back a coupon that already paid.
     */
    function _book(bytes32 noteId, Schedule storage s, bool strict) private {
        uint256 when = _bookingTime(s.nextPaymentAt);
        uint256 gas_ = s.gasLimit;

        if (!SCHEDULE_SERVICE.hasScheduleCapacity(when, gas_)) {
            if (strict) revert NoCapacity(when, gas_);
            emit ScheduleRejected(noteId, 0, when);
            return;
        }

        (int64 responseCode, address scheduleAddress) = SCHEDULE_SERVICE.scheduleCall(
            address(this),
            when,
            gas_,
            0,
            abi.encodeCall(this.executeCoupon, (noteId))
        );

        // 0x16b signals failure by return value, not by reverting. Checking this is the whole
        // difference between a scheduler that works and one that appears to.
        if (!HederaResponse.ok(responseCode)) {
            if (strict) HederaResponse.check(responseCode);
            emit ScheduleRejected(noteId, responseCode, when);
            return;
        }

        s.armed = true;
        _lastScheduleAddress[noteId] = scheduleAddress;
        emit ScheduleArmed(noteId, when, scheduleAddress);
    }

    /// @dev `expirySecond` must be strictly greater than the current consensus second, and no
    ///      further out than the ledger's ceiling. Anything past the horizon becomes a hop.
    function _bookingTime(uint64 dueAt) private view returns (uint256) {
        uint256 earliest = block.timestamp + 1;
        uint256 horizon = block.timestamp + SCHEDULE_HORIZON;
        uint256 when = uint256(dueAt) < earliest ? earliest : uint256(dueAt);
        return when > horizon ? horizon : when;
    }

    function _pushCoverage(bytes32 noteId, Schedule storage s, uint64 dueAt) private {
        (uint64 bps, Coverage.Reason reason) = oracle.evidenceOf(noteId);
        if (reason != Coverage.Reason.None) {
            emit CoveragePushFailed(noteId, dueAt);
            return;
        }

        // ATS rejects a duplicate date and enforces its own date window; neither is worth losing
        // the coupon over.
        try IAtsKpis(s.note).addKpiData(dueAt, bps, s.project) {
            emit CoveragePushed(noteId, dueAt, bps);
        } catch {
            emit CoveragePushFailed(noteId, dueAt);
        }
    }

    function _tryPay(address from, address to, uint256 amount) private returns (bool) {
        if (amount == 0) return true;
        // solhint-disable-next-line avoid-low-level-calls
        (bool sent, bytes memory data) = address(cash).call(
            abi.encodeCall(IERC20.transferFrom, (from, to, amount))
        );
        return sent && (data.length == 0 || abi.decode(data, (bool)));
    }
}
