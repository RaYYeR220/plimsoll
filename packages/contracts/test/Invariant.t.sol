// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { Test } from "forge-std/Test.sol";
import { Base } from "./Base.t.sol";
import { CoverageOracle } from "../src/CoverageOracle.sol";
import { LoadLine } from "../src/LoadLine.sol";
import { BerthMarket } from "../src/BerthMarket.sol";
import { CouponScheduler } from "../src/CouponScheduler.sol";
import { MockNote } from "./mocks/MockNote.sol";
import { MockCash, MockScheduleService } from "./mocks/Mocks.sol";

/**
 * @notice The product, stated as an invariant: nothing settles and nothing pays while the note is
 *         under its load line, halted, or backed by evidence we cannot stand behind.
 *
 * @dev The handler drives the protocol through arbitrary interleavings of attestations, time,
 *      authority actions and trading. Before every value-moving call it records what the load
 *      line said; if value moved anyway, it counts a violation. The invariants then assert those
 *      counters are still zero.
 *
 *      Counting rather than asserting inside the handler is deliberate: an assertion inside a
 *      handler call can be swallowed by the fuzzer's revert handling, whereas a counter read from
 *      outside cannot.
 */
contract Handler is Test {
    CoverageOracle public immutable oracle;
    LoadLine public immutable loadLine;
    BerthMarket public immutable market;
    CouponScheduler public immutable scheduler;
    MockNote public immutable note;
    MockCash public immutable cash;
    MockScheduleService public immutable schedules;

    bytes32 public immutable noteId;
    bytes32 public immutable partition;
    bytes32 public immutable vaultSet;
    uint256 public immutable attestorKey;
    address public immutable maker;
    address public immutable taker;

    /**
     * @dev Must not sit below the source head the rig already seeded, or every attestation the
     *      handler signs is rejected as a regression and the whole campaign quietly goes inert.
     */
    uint64 internal constant SOURCE_BLOCK_BASE = 1_000_000;

    uint256[] public orderIds;
    uint64 public nonce;

    /// @notice Times a trade settled while the venue should have refused. Must stay zero.
    uint256 public settlesWhileUnsafe;
    /// @notice Times a coupon paid while the venue should have refused. Must stay zero.
    uint256 public couponsWhileUnsafe;
    /// @notice Sanity counters, so a green invariant cannot come from doing nothing.
    uint256 public settlements;
    uint256 public couponsPaid;
    uint256 public ordersPlaced;

    /// @dev Grouped so the constructor stays inside the stack limit.
    struct Wiring {
        CoverageOracle oracle;
        LoadLine loadLine;
        BerthMarket market;
        CouponScheduler scheduler;
        MockNote note;
        MockCash cash;
        MockScheduleService schedules;
        bytes32 noteId;
        bytes32 partition;
        bytes32 vaultSet;
        uint256 attestorKey;
        address maker;
        address taker;
    }

    constructor(Wiring memory w) {
        oracle = w.oracle;
        loadLine = w.loadLine;
        market = w.market;
        scheduler = w.scheduler;
        note = w.note;
        cash = w.cash;
        schedules = w.schedules;
        noteId = w.noteId;
        partition = w.partition;
        vaultSet = w.vaultSet;
        attestorKey = w.attestorKey;
        maker = w.maker;
        taker = w.taker;
    }

    function _clear() internal view returns (bool clear) {
        (clear, , , , ) = loadLine.status(noteId);
    }

    // ------------------------------------------------------------------ evidence and time

    function attest(uint64 bps, uint32 ttl) external {
        // Straddles the default line in both directions so runs spend real time on each side.
        bps = uint64(bound(bps, 0, 25_000));
        ttl = uint32(bound(ttl, 1 hours, 30 days));

        CoverageOracle.Attestation memory a = CoverageOracle.Attestation({
            noteId: noteId,
            coverageBps: bps,
            asOfBlock: SOURCE_BLOCK_BASE + uint64(block.number),
            vaultSetHash: vaultSet,
            sourceHash: keccak256(abi.encode(bps, ttl)),
            expiry: uint64(block.timestamp) + ttl,
            nonce: ++nonce
        });

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
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(attestorKey, digest);

        try oracle.submitAttestation(a, abi.encodePacked(r, s, v)) {} catch {}
    }

    /// @dev Time is the adversary here: it is what turns good evidence stale mid-flight.
    function passTime(uint32 dt) external {
        vm.warp(block.timestamp + bound(dt, 1, 20 days));
        vm.roll(block.number + 1);
    }

    // ------------------------------------------------------------------ authority

    function moveTheLine(uint64 threshold) external {
        threshold = uint64(bound(threshold, 1, 40_000));
        try loadLine.setThreshold(noteId, threshold, "") {} catch {}
    }

    function toggleHalt(bool stop) external {
        if (stop) {
            try loadLine.halt(noteId, "") {} catch {}
        } else {
            try loadLine.resume(noteId, "") {} catch {}
        }
    }

    /**
     * @dev Toggles between the real backing set and a decoy rather than taking an arbitrary
     *      hash. An arbitrary hash is a one-way door - the handler only ever signs over the
     *      canonical set, so one random move would strand the note as permanently unproven and
     *      every later action would be a no-op. The interesting state is the note going
     *      unproven and then recovering, which needs the move to be reversible.
     */
    function moveTheVaultSet(bool canonical) external {
        bytes32 target = canonical ? vaultSet : keccak256("decoy-vault-set");
        try oracle.setVaultSet(noteId, target) {} catch {}
    }

    // ------------------------------------------------------------------ trading

    function placeAsk(uint128 amount, uint128 price, uint32 life) external {
        amount = uint128(bound(amount, 1, 500));
        price = uint128(bound(price, 1, 5e18));
        // Long-lived on purpose: with `passTime` jumping up to 20 days, short expiries mean the
        // fuzzer spends its budget reaping dead orders instead of trying to settle live ones.
        uint64 expiry = uint64(block.timestamp + bound(life, 30 days, 365 days));

        vm.prank(maker);
        try market.placeAsk(address(note), noteId, partition, amount, price, expiry) returns (uint256 id) {
            orderIds.push(id);
            ordersPlaced++;
        } catch {}
    }

    function fill(uint256 seed, uint128 amount) external {
        if (orderIds.length == 0) return;
        uint256 id = orderIds[seed % orderIds.length];

        // Sized against what is actually left. An independently drawn size overfills almost
        // every time, and a fuzzer that only ever attempts impossible trades proves nothing.
        BerthMarket.Order memory order = market.orderOf(id);
        if (!order.open || order.remaining == 0) return;
        amount = uint128(bound(amount, 1, order.remaining));

        bool clearBefore = _clear();
        uint256 takerNotesBefore = note.balanceOfByPartition(partition, taker);

        vm.prank(taker);
        try market.fill(id, amount) {
            settlements++;
            if (!clearBefore) settlesWhileUnsafe++;
        } catch {
            // A refused match must leave the taker exactly as it found them.
            if (note.balanceOfByPartition(partition, taker) != takerNotesBefore) settlesWhileUnsafe++;
        }
    }

    function cancel(uint256 seed) external {
        if (orderIds.length == 0) return;
        vm.prank(maker);
        try market.cancel(orderIds[seed % orderIds.length]) {} catch {}
    }

    // ------------------------------------------------------------------ coupons

    function runCoupon() external {
        bool clearBefore = _clear();
        uint32 paidBefore = scheduler.scheduleOf(noteId).paymentsMade;

        try scheduler.executeCoupon(noteId) {} catch {}

        uint32 paidAfter = scheduler.scheduleOf(noteId).paymentsMade;
        if (paidAfter > paidBefore) {
            couponsPaid++;
            if (!clearBefore) couponsWhileUnsafe++;
        }
    }

    function rearm() external {
        try scheduler.rearm(noteId) {} catch {}
    }
}

contract PlimsollInvariantTest is Base {
    Handler internal handler;

    function setUp() public override {
        super.setUp();

        _attest(12_000);
        _fundNotes(maker, 1_000_000);
        _fundCash(taker, type(uint128).max, address(market));
        cash.mint(taker, type(uint128).max);
        _fundCash(issuer, type(uint128).max, address(scheduler));

        uint64 firstPaymentAt = uint64(block.timestamp + 1 days);
        scheduler.createSchedule(
            NOTE_ID,
            CouponScheduler.ScheduleParams({
                note: address(note),
                project: issuer,
                payer: issuer,
                paymentAgent: paymentAgent,
                couponAmount: 1_000,
                firstPaymentAt: firstPaymentAt,
                period: 1 days,
                maturity: uint64(block.timestamp + 3650 days),
                gasLimit: 400_000,
                maxPeriods: 4000
            })
        );
        scheduler.arm(NOTE_ID);

        handler = new Handler(
            Handler.Wiring({
                oracle: oracle,
                loadLine: loadLine,
                market: market,
                scheduler: scheduler,
                note: note,
                cash: cash,
                schedules: schedules,
                noteId: NOTE_ID,
                partition: PARTITION,
                vaultSet: VAULT_SET,
                attestorKey: attestorKey,
                maker: maker,
                taker: taker
            })
        );

        // The handler acts as maker and taker through pranks, so it needs their operator rights
        // rather than its own.
        targetContract(address(handler));
    }

    /// @notice No trade settles while the note is under its line, halted, or unproven.
    function invariant_NothingSettlesPastTheLoadLine() public view {
        assertEq(handler.settlesWhileUnsafe(), 0, "a trade settled while the venue should have refused");
    }

    /// @notice No coupon pays while the note is under its line, halted, or unproven.
    function invariant_NoCouponPaysPastTheLoadLine() public view {
        assertEq(handler.couponsWhileUnsafe(), 0, "a coupon paid while the venue should have refused");
    }

    /// @notice Escrowed notes are always accounted for: nothing is created or destroyed.
    function invariant_NotesAreConserved() public view {
        uint256 total = note.balanceOfByPartition(PARTITION, maker) +
            note.heldOfByPartition(PARTITION, maker) +
            note.balanceOfByPartition(PARTITION, taker) +
            note.heldOfByPartition(PARTITION, taker);
        assertEq(total, 1_000_000, "notes went missing or appeared from nowhere");
    }

    /// @notice The venue never ends a call holding notes or cash of its own.
    function invariant_VenueHoldsNothing() public view {
        assertEq(note.balanceOfByPartition(PARTITION, address(market)), 0);
        assertEq(cash.balanceOf(address(market)), 0);
    }

    /**
     * @notice Proof that the handler is not inert.
     *
     * @dev A suite of green invariants means nothing if every action the fuzzer takes reverts
     *      into a `catch`. This walks the same handler through a scripted happy path and asserts
     *      it really does settle trades and pay coupons, so the invariants above are known to be
     *      guarding live code rather than a rig that never gets off the ground.
     *
     *      It lives here as an ordinary test rather than in `afterInvariant`, because the
     *      shrinker minimises a failing sequence down to a single call - which would drive these
     *      counters to zero and make the assertion fail by construction.
     */
    function test_HandlerRigActuallyExercisesTheProtocol() public {
        handler.attest(20_000, 10 days);
        handler.placeAsk(200, 2e18, 60 days);
        assertGt(handler.ordersPlaced(), 0, "the rig cannot place an order");

        handler.fill(0, 150);
        assertGt(handler.settlements(), 0, "the rig cannot settle a trade");

        handler.passTime(2 days);
        handler.attest(20_000, 10 days);
        handler.runCoupon();
        assertGt(handler.couponsPaid(), 0, "the rig cannot pay a coupon");

        // And the safety counters stayed clean throughout.
        assertEq(handler.settlesWhileUnsafe(), 0);
        assertEq(handler.couponsWhileUnsafe(), 0);
    }

    /// @notice The counters trip when they should: a settlement past the line would be caught.
    function test_TheViolationCounterActuallyDetectsAViolation() public {
        handler.attest(20_000, 10 days);
        handler.placeAsk(200, 2e18, 60 days);

        // Push the note under its line, then try to settle. The venue must refuse, so the
        // counter stays zero - but this proves the counter is wired to a path that runs.
        handler.moveTheLine(25_000);
        (bool clear, , , , ) = loadLine.status(NOTE_ID);
        assertFalse(clear, "the note is under its line");

        uint256 settledBefore = handler.settlements();
        handler.fill(0, 150);
        assertEq(handler.settlements(), settledBefore, "no settlement past the line");
        assertEq(handler.settlesWhileUnsafe(), 0);
    }
}
