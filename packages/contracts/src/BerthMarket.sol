// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { Coverage } from "./libraries/Coverage.sol";
import { Preflight } from "./libraries/Preflight.sol";
import { ILoadLine } from "./interfaces/IPlimsoll.sol";
import { IAtsHold, IAtsOperator } from "./interfaces/IAts.sol";
import { IERC20 } from "./interfaces/IERC20.sol";

/**
 * @title BerthMarket
 * @notice An order book over ATS-issued notes that refuses to settle past the load line.
 *
 * @dev ATS issues compliance-enforced securities and has no secondary market. This is the gap:
 *      a venue where every match is checked against the issuing token's own compliance rules
 *      before it is booked, and against the note's coverage before either.
 *
 *      Two sides, escrowed differently, for reasons worth being explicit about:
 *
 *      An **ask** escrows the maker's notes at placement through `createHoldFromByPartition`.
 *      The hold is created with `to == address(0)`, which ATS reads as "destination not fixed at
 *      creation" - that is what lets a resting order be escrowed before any taker exists, and it
 *      means settlement is a single hop from maker to taker. This contract is the hold's escrow
 *      but never its destination, so it never custodies a note and never needs to pass the
 *      note's own KYC. Cancellation before expiry releases the hold; after expiry anyone may
 *      reclaim it back to the maker.
 *
 *      A **bid** is allowance-backed, not escrowed. Cash is an HTS token and holding it would
 *      require this contract to be associated with every cash token it ever quotes, which is an
 *      operational burden that buys nothing: the pre-flight already reads the maker's balance,
 *      allowance and freeze state, so an unfundable bid is refused at match time with a reason
 *      code rather than reverting in settlement. The asymmetry is real and stated in the README:
 *      an ask is escrow-backed and cannot fail for want of notes, a bid can go stale.
 *
 *      Settlement is atomic in the only sense that matters on-chain - one transaction moves both
 *      legs or neither. The note leg of a filled ask executes the hold; the note leg of a filled
 *      bid uses `operatorTransferByPartition`, since there is no hold to execute.
 *
 *      Every entry point that could move value consults {ILoadLine} first, including cancel -
 *      no, deliberately not cancel: a maker must always be able to withdraw an order, halted or
 *      not. Trapping a maker's notes in a halted market would make a halt a confiscation.
 */
contract BerthMarket {
    using Preflight for address;

    enum Side {
        Ask,
        Bid
    }

    struct Order {
        address maker;
        /// @dev The ATS token (a resolver proxy), which is where the compliance rules live.
        address note;
        /// @dev Plimsoll's identifier for the note, the key into {ILoadLine} and the oracle.
        bytes32 noteId;
        bytes32 partition;
        uint128 remaining;
        /// @dev Cash smallest-units per note base unit, scaled by {PRICE_SCALE}.
        uint128 pricePerNote;
        uint64 expiry;
        Side side;
        bool open;
        /// @dev Ask only. ATS hold ids are per (partition, holder), so this is meaningless alone.
        uint256 holdId;
    }

    uint256 public constant PRICE_SCALE = 1e18;

    ILoadLine public immutable loadLine;
    /// @dev The cash leg. One token per venue keeps the book and the circuit breaker in step.
    IERC20 public immutable cash;

    uint256 public nextOrderId = 1;
    mapping(uint256 => Order) private _orders;

    uint256 private _entered;

    error Reentrancy();
    error ZeroAddress();
    error BadOrder();
    error OrderNotOpen(uint256 orderId);
    error OrderExpired(uint256 orderId, uint64 expiry);
    error NotMaker(uint256 orderId, address caller);
    error NotYetExpired(uint256 orderId, uint64 expiry);
    error InsufficientRemaining(uint256 orderId, uint128 remaining, uint128 requested);
    error SelfTrade();
    error HoldNotCreated();
    error CashTransferFailed(address from, address to, uint256 amount);
    /// @dev `leg` is the note token for the securities leg, or the cash token for the cash leg.
    error PreflightRefused(uint256 orderId, address leg, bytes1 statusCode, bytes32 reasonCode);

    event OrderPlaced(
        uint256 indexed orderId,
        address indexed maker,
        bytes32 indexed noteId,
        Side side,
        address note,
        bytes32 partition,
        uint128 amount,
        uint128 pricePerNote,
        uint64 expiry,
        uint256 holdId
    );
    event OrderFilled(
        uint256 indexed orderId,
        address indexed taker,
        uint128 amount,
        uint256 cashPaid,
        uint64 coverageBps
    );
    event OrderCancelled(uint256 indexed orderId, address indexed by);
    event OrderReaped(uint256 indexed orderId, address indexed by, uint128 unfilled);

    modifier nonReentrant() {
        // Plain storage rather than transient: Hedera's Cancun support is recent enough that
        // leaning on TSTORE for a safety guard is not a trade worth making.
        if (_entered == 1) revert Reentrancy();
        _entered = 1;
        _;
        _entered = 0;
    }

    constructor(ILoadLine loadLine_, IERC20 cash_) {
        if (address(loadLine_) == address(0) || address(cash_) == address(0)) revert ZeroAddress();
        loadLine = loadLine_;
        cash = cash_;
    }

    // ---------------------------------------------------------------------------------------
    // Placement
    // ---------------------------------------------------------------------------------------

    /**
     * @notice Offers `amount` notes for sale, escrowing them in an ATS hold until expiry.
     * @dev The maker must have granted this contract operator rights on `partition` first
     *      (`authorizeOperatorByPartition`), which is what lets the venue create the hold on
     *      their behalf without ever taking custody.
     */
    function placeAsk(
        address note,
        bytes32 noteId,
        bytes32 partition,
        uint128 amount,
        uint128 pricePerNote,
        uint64 expiry
    ) external nonReentrant returns (uint256 orderId) {
        _validatePlacement(noteId, amount, pricePerNote, expiry);

        (bool created, uint256 holdId) = IAtsHold(note).createHoldFromByPartition(
            partition,
            msg.sender,
            IAtsHold.Hold({
                amount: amount,
                expirationTimestamp: expiry,
                escrow: address(this),
                // Left open: the taker does not exist yet. ATS treats zero as "any destination".
                to: address(0),
                data: ""
            }),
            ""
        );
        if (!created) revert HoldNotCreated();

        orderId = _record(note, noteId, partition, amount, pricePerNote, expiry, Side.Ask, holdId);
    }

    /**
     * @notice Bids for `amount` notes, backed by a cash allowance rather than an escrow.
     * @dev The maker must have approved this contract for `amount * pricePerNote / PRICE_SCALE`
     *      of cash. A taker filling this bid must have granted operator rights on `partition`.
     */
    function placeBid(
        address note,
        bytes32 noteId,
        bytes32 partition,
        uint128 amount,
        uint128 pricePerNote,
        uint64 expiry
    ) external nonReentrant returns (uint256 orderId) {
        _validatePlacement(noteId, amount, pricePerNote, expiry);
        orderId = _record(note, noteId, partition, amount, pricePerNote, expiry, Side.Bid, 0);
    }

    // ---------------------------------------------------------------------------------------
    // Matching
    // ---------------------------------------------------------------------------------------

    /**
     * @notice Fills `amount` of order `orderId` as the taker.
     * @dev Order of operations is the whole design. The load line is consulted before anything
     *      else, then both legs are asked whether they would settle, and only then is value
     *      moved. Nothing here books a match it has not already been told will clear.
     */
    function fill(uint256 orderId, uint128 amount) external nonReentrant returns (uint256 cashPaid) {
        Order storage order = _orders[orderId];
        if (!order.open) revert OrderNotOpen(orderId);
        if (block.timestamp >= order.expiry) revert OrderExpired(orderId, order.expiry);
        if (amount == 0 || amount > order.remaining) {
            revert InsufficientRemaining(orderId, order.remaining, amount);
        }
        if (msg.sender == order.maker) revert SelfTrade();

        loadLine.requireClear(order.noteId);

        bool makerSells = order.side == Side.Ask;
        address noteFrom = makerSells ? order.maker : msg.sender;
        address noteTo = makerSells ? msg.sender : order.maker;
        address cashFrom = makerSells ? msg.sender : order.maker;
        address cashTo = makerSells ? order.maker : msg.sender;

        cashPaid = _cost(amount, order.pricePerNote);

        Preflight.Result memory notes = Preflight.noteLeg(order.note, noteFrom, noteTo, order.partition, amount);
        if (!notes.allowed) revert PreflightRefused(orderId, order.note, notes.statusCode, notes.reasonCode);

        Preflight.Result memory funds = Preflight.cashLeg(address(cash), cashFrom, address(this), cashPaid);
        if (!funds.allowed) revert PreflightRefused(orderId, address(cash), funds.statusCode, funds.reasonCode);

        order.remaining -= amount;
        if (order.remaining == 0) order.open = false;

        _moveCash(cashFrom, cashTo, cashPaid);

        if (makerSells) {
            IAtsHold(order.note).executeHoldByPartition(
                IAtsHold.HoldIdentifier({
                    partition: order.partition,
                    tokenHolder: order.maker,
                    holdId: order.holdId
                }),
                msg.sender,
                amount
            );
        } else {
            IAtsOperator(order.note).operatorTransferByPartition(
                IAtsOperator.OperatorTransferData({
                    partition: order.partition,
                    from: msg.sender,
                    to: order.maker,
                    value: amount,
                    data: "",
                    operatorData: ""
                })
            );
        }

        (, , , uint64 coverageBps, ) = loadLine.status(order.noteId);
        emit OrderFilled(orderId, msg.sender, amount, cashPaid, coverageBps);
    }

    // ---------------------------------------------------------------------------------------
    // Withdrawal
    // ---------------------------------------------------------------------------------------

    /**
     * @notice Withdraws an order and releases any escrow back to the maker.
     * @dev Not gated on the load line. A halt stops trading, and stopping a maker from taking
     *      their own notes back out of escrow would make it a seizure instead.
     */
    function cancel(uint256 orderId) external nonReentrant {
        Order storage order = _orders[orderId];
        if (!order.open) revert OrderNotOpen(orderId);
        if (msg.sender != order.maker) revert NotMaker(orderId, msg.sender);

        uint128 unfilled = order.remaining;
        order.open = false;
        order.remaining = 0;

        if (order.side == Side.Ask) {
            // Release is only legal before expiry; past it the hold is reclaimed via reap().
            IAtsHold(order.note).releaseHoldByPartition(
                IAtsHold.HoldIdentifier({
                    partition: order.partition,
                    tokenHolder: order.maker,
                    holdId: order.holdId
                }),
                unfilled
            );
        }

        emit OrderCancelled(orderId, msg.sender);
    }

    /**
     * @notice Closes an expired order and reclaims its escrow to the maker.
     * @dev Permissionless. A maker who walks away must not leave their own notes held forever,
     *      and anyone clearing the book is doing the maker a favour at their own gas expense.
     */
    function reap(uint256 orderId) external nonReentrant {
        Order storage order = _orders[orderId];
        if (!order.open) revert OrderNotOpen(orderId);
        if (block.timestamp < order.expiry) revert NotYetExpired(orderId, order.expiry);

        uint128 unfilled = order.remaining;
        order.open = false;
        order.remaining = 0;

        if (order.side == Side.Ask) {
            IAtsHold(order.note).reclaimHoldByPartition(
                IAtsHold.HoldIdentifier({
                    partition: order.partition,
                    tokenHolder: order.maker,
                    holdId: order.holdId
                })
            );
        }

        emit OrderReaped(orderId, msg.sender, unfilled);
    }

    // ---------------------------------------------------------------------------------------
    // Reads
    // ---------------------------------------------------------------------------------------

    function orderOf(uint256 orderId) external view returns (Order memory) {
        return _orders[orderId];
    }

    /**
     * @notice Dry-runs a fill and reports every reason it would be refused.
     * @dev Same checks as {fill}, in the same order, with nothing moved. This exists so the UI
     *      can grey out a button and say why instead of letting the user discover it in a
     *      reverted transaction.
     */
    function quote(
        uint256 orderId,
        address taker,
        uint128 amount
    )
        external
        view
        returns (
            bool settles,
            Coverage.Reason coverageReason,
            bytes32 noteReasonCode,
            bytes32 cashReasonCode,
            uint256 cashPaid
        )
    {
        Order storage order = _orders[orderId];
        if (!order.open || block.timestamp >= order.expiry || amount == 0 || amount > order.remaining) {
            return (false, Coverage.Reason.None, bytes32(0), bytes32(0), 0);
        }

        (bool clear, , Coverage.Reason reason, , ) = loadLine.status(order.noteId);
        cashPaid = _cost(amount, order.pricePerNote);
        if (!clear) return (false, reason, bytes32(0), bytes32(0), cashPaid);

        bool makerSells = order.side == Side.Ask;
        Preflight.Result memory notes = Preflight.noteLeg(
            order.note,
            makerSells ? order.maker : taker,
            makerSells ? taker : order.maker,
            order.partition,
            amount
        );
        Preflight.Result memory funds = Preflight.cashLeg(
            address(cash),
            makerSells ? taker : order.maker,
            address(this),
            cashPaid
        );

        settles = notes.allowed && funds.allowed;
        return (settles, reason, notes.reasonCode, funds.reasonCode, cashPaid);
    }

    // ---------------------------------------------------------------------------------------
    // Internals
    // ---------------------------------------------------------------------------------------

    function _validatePlacement(bytes32 noteId, uint128 amount, uint128 price, uint64 expiry) private view {
        if (amount == 0 || price == 0 || expiry <= block.timestamp) revert BadOrder();
        loadLine.requireClear(noteId);
    }

    function _record(
        address note,
        bytes32 noteId,
        bytes32 partition,
        uint128 amount,
        uint128 pricePerNote,
        uint64 expiry,
        Side side,
        uint256 holdId
    ) private returns (uint256 orderId) {
        orderId = nextOrderId++;
        _orders[orderId] = Order({
            maker: msg.sender,
            note: note,
            noteId: noteId,
            partition: partition,
            remaining: amount,
            pricePerNote: pricePerNote,
            expiry: expiry,
            side: side,
            open: true,
            holdId: holdId
        });

        emit OrderPlaced(
            orderId,
            msg.sender,
            noteId,
            side,
            note,
            partition,
            amount,
            pricePerNote,
            expiry,
            holdId
        );
    }

    /// @dev Rounds up, so any sub-unit remainder always lands in favour of whoever is delivering
    ///      the notes. One smallest cash unit, deterministically, rather than an argument.
    function _cost(uint128 amount, uint128 pricePerNote) private pure returns (uint256) {
        uint256 product = uint256(amount) * uint256(pricePerNote);
        return (product + PRICE_SCALE - 1) / PRICE_SCALE;
    }

    /**
     * @dev Moves cash payer-to-payee in one hop with this contract only as the approved spender.
     *      The venue never holds a balance, which on Hedera also means it never has to be
     *      associated with the cash token - association is each counterparty's own affair.
     *
     *      Tolerates a token that returns nothing rather than a bool. HTS's ERC-20 facade is
     *      well behaved, but the cash leg is configurable and a non-standard token would
     *      otherwise revert here with no explanation.
     */
    function _moveCash(address from, address to, uint256 amount) private {
        if (amount == 0) return;
        // solhint-disable-next-line avoid-low-level-calls
        (bool sent, bytes memory data) = address(cash).call(
            abi.encodeCall(IERC20.transferFrom, (from, to, amount))
        );
        if (!sent || (data.length != 0 && !abi.decode(data, (bool)))) {
            revert CashTransferFailed(from, to, amount);
        }
    }
}
