// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { Base } from "./Base.t.sol";
import { CashLegController } from "../src/CashLegController.sol";
import { CouponScheduler } from "../src/CouponScheduler.sol";
import { BerthMarket } from "../src/BerthMarket.sol";
import { Coverage } from "../src/libraries/Coverage.sol";
import { HederaResponse } from "../src/libraries/HederaResponse.sol";
import { Preflight } from "../src/libraries/Preflight.sol";
import { Owned } from "../src/access/Owned.sol";

/**
 * @notice The cash leg, and the claim that the rule holds with our server off.
 * @dev The freeze state lives in a registry that both the HTS system-contract mock and the cash
 *      token read. Nothing in these tests tells the token to refuse a transfer; the token asks
 *      the ledger, exactly as an HTS token does at consensus.
 */
contract CashLegTest is Base {
    function setUp() public override {
        super.setUp();
        _attest(12_000);
        cashController.setPayer(NOTE_ID, issuer);
    }

    function _createToken() internal {
        cashController.createCashToken("Plimsoll Cash", "PCASH", "cash leg", 6, 0, 1e15);
    }

    // ------------------------------------------------------------------ creation

    function test_CreatesTheTokenAndRecordsIt() public {
        _createToken();
        assertEq(cashController.cashToken(), address(cash));
    }

    function test_RevertWhen_CreationResponseCodeIsNotSuccess() public {
        // HTS reports failure by return code. Reading only the returned address would hand us a
        // zero token and a contract that thinks it succeeded.
        hts.setNextResponseCode(int64(23));

        vm.expectRevert(abi.encodeWithSelector(HederaResponse.HederaCallFailed.selector, int64(23)));
        _createToken();
        assertEq(cashController.cashToken(), address(0));
    }

    function test_RevertWhen_CreatingTwice() public {
        _createToken();
        vm.expectRevert(CashLegController.CashTokenAlreadyCreated.selector);
        _createToken();
    }

    function test_RevertWhen_CreatingAsNonOwner() public {
        vm.prank(outsider);
        vm.expectRevert(abi.encodeWithSelector(Owned.NotOwner.selector, outsider));
        cashController.createCashToken("Plimsoll Cash", "PCASH", "cash leg", 6, 0, 1e15);
    }

    // ------------------------------------------------------------------ the breaker

    function test_BreakerRefusesToTripWhileTheLineIsClear() public {
        _createToken();
        // The breaker copies the load line onto the ledger. It does not get an opinion.
        vm.expectRevert(abi.encodeWithSelector(CashLegController.LineIsClear.selector, NOTE_ID));
        cashController.tripBreaker(NOTE_ID);
    }

    function test_BreakerFreezesThePayerOnceCoverageFails() public {
        _createToken();
        loadLine.setThreshold(NOTE_ID, 20_000, "");

        vm.expectEmit(true, false, false, true);
        emit CashLegController.BreakerTripped(NOTE_ID, issuer, Coverage.Reason.BelowLoadLine);
        cashController.tripBreaker(NOTE_ID);

        assertTrue(freezeRegistry.frozen(address(cash), issuer));
        assertTrue(cashController.isPayerFrozen(NOTE_ID));
    }

    function test_AnyoneMayTripTheBreaker() public {
        _createToken();
        loadLine.halt(NOTE_ID, "");

        // Enforcing a rule the mandate already set needs no further permission, and requiring
        // one would only add a way for enforcement to be late.
        vm.prank(outsider);
        cashController.tripBreaker(NOTE_ID);
        assertTrue(freezeRegistry.frozen(address(cash), issuer));
    }

    function test_BreakerResetsOnlyWhenTheLineIsClearAgain() public {
        _createToken();
        loadLine.halt(NOTE_ID, "");
        cashController.tripBreaker(NOTE_ID);

        vm.expectRevert(
            abi.encodeWithSelector(
                CashLegController.LineIsNotClear.selector,
                NOTE_ID,
                Coverage.Reason.AuthorityHalt
            )
        );
        cashController.resetBreaker(NOTE_ID);

        loadLine.resume(NOTE_ID, "");
        cashController.resetBreaker(NOTE_ID);
        assertFalse(freezeRegistry.frozen(address(cash), issuer));
    }

    function test_BreakerSurfacesAFailedFreeze() public {
        _createToken();
        loadLine.halt(NOTE_ID, "");
        hts.setNextResponseCode(int64(180));

        vm.expectRevert(abi.encodeWithSelector(HederaResponse.HederaCallFailed.selector, int64(180)));
        cashController.tripBreaker(NOTE_ID);
        assertFalse(freezeRegistry.frozen(address(cash), issuer), "nothing was frozen");
    }

    function test_RevertWhen_NoPayerIsRegistered() public {
        _createToken();
        bytes32 other = keccak256("PLIM-B");

        vm.expectRevert(abi.encodeWithSelector(CashLegController.NoPayer.selector, other));
        cashController.tripBreaker(other);
    }

    function test_RevertWhen_SettingPayerAsNonOwner() public {
        vm.prank(outsider);
        vm.expectRevert(abi.encodeWithSelector(Owned.NotOwner.selector, outsider));
        cashController.setPayer(NOTE_ID, outsider);
    }

    // ------------------------------------------------------------------ the property that matters

    function test_AFrozenPayerCannotPayACouponEvenWithCoverageRestored() public {
        _createToken();
        _fundCash(issuer, 10_000_000, address(scheduler));

        uint64 firstPaymentAt = uint64(block.timestamp + 10 days);
        scheduler.createSchedule(
            NOTE_ID,
            CouponScheduler.ScheduleParams({
                note: address(note),
                project: issuer,
                payer: issuer,
                paymentAgent: paymentAgent,
                couponAmount: 50_000,
                firstPaymentAt: firstPaymentAt,
                period: 30 days,
                maturity: firstPaymentAt + 30 days,
                gasLimit: 400_000,
                maxPeriods: 4
            })
        );
        scheduler.arm(NOTE_ID);

        // Coverage breaks, the breaker trips, and the payer is frozen at the ledger.
        loadLine.setThreshold(NOTE_ID, 20_000, "");
        cashController.tripBreaker(NOTE_ID);

        // Now imagine our whole stack is wrong and the load line wrongly reads clear again.
        loadLine.setThreshold(NOTE_ID, 10_500, "");
        vm.warp(firstPaymentAt);
        _attest(12_000);
        (bool clear, , , , ) = loadLine.status(NOTE_ID);
        assertTrue(clear, "our own logic now says this coupon may pay");

        uint256 before = cash.balanceOf(paymentAgent);
        schedules.fire(0);

        // And it still cannot, because the refusal does not live in our code.
        assertEq(cash.balanceOf(paymentAgent), before, "consensus refused regardless of our logic");
        assertEq(scheduler.scheduleOf(NOTE_ID).paymentsMissed, 1);
    }

    function test_AFrozenBuyerCannotSettleATrade() public {
        _createToken();
        _fundNotes(maker, 10_000);
        _fundCash(taker, 1_000_000, address(market));

        vm.prank(maker);
        uint256 id = market.placeAsk(
            address(note),
            NOTE_ID,
            PARTITION,
            1_000,
            2e18,
            uint64(block.timestamp + 7 days)
        );

        loadLine.halt(NOTE_ID, "");
        cashController.setPayer(NOTE_ID, taker);
        cashController.tripBreaker(NOTE_ID);
        loadLine.resume(NOTE_ID, "");

        // The venue reports the freeze rather than discovering it in a reverted settlement.
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
        market.fill(id, 1_000);
    }
}
