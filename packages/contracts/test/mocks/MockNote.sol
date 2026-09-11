// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { IAtsHold, IAtsOperator } from "../../src/interfaces/IAts.sol";

/**
 * @title MockNote
 * @notice A stand-in for an ATS-issued bond, modelling only the behaviours Plimsoll depends on.
 *
 * @dev Faithfulness matters more than completeness here, because these are the rules the market's
 *      correctness is argued from. The four that are modelled exactly, from the v8.0.0 sources:
 *
 *      - `createHoldFromByPartition` spends an ERC-20 allowance the holder granted the caller, and
 *        moves balance from available into held. Operator rights do not substitute for it: real ATS
 *        refuses a third-party hold without allowance (`InsufficientAllowance`, via
 *        `decreaseAllowedBalanceForHold`), which a fork dry-run against the live note confirmed.
 *        An earlier version of this mock gated it on operator rights, and every ask test passed
 *        against a rule ATS does not have.
 *      - `executeHoldByPartition` requires the caller to be the recorded escrow, refuses once the
 *        hold has expired, and accepts any destination when the hold recorded `to == address(0)`.
 *      - `releaseHoldByPartition` is legal only before expiry; `reclaimHoldByPartition` only after.
 *      - `canTransferByPartition` reports rather than reverts, and its reason codes are the real
 *        ATS error selectors: AccountIsBlocked 0x796c1f0d, InvalidKycStatus 0xfc855b1b,
 *        ComplianceNotAllowed 0x66eb1b54, IsPaused 0x1309a563.
 *
 *      Held balance is deliberately tracked separately from available balance so a test can prove
 *      an escrowed order cannot be spent out from under a taker.
 */
contract MockNote {
    error AccountIsBlocked(address account);
    error NotOperator(address operator, address holder);
    error InsufficientBalance(address holder, uint256 available, uint256 requested);
    error WrongHoldId();
    error IsNotEscrow();
    error HoldExpirationReached();
    error HoldExpirationNotReached();
    error InvalidDestinationAddress(address holdDestination, address to);
    error InsufficientAllowance(address spender, address from);
    error KpiDataAlreadyExists(uint256 date);

    bytes1 private constant EIP1066_DISALLOWED = 0x10;
    bytes1 private constant EIP1066_SUCCESS = 0x01;

    struct Hold {
        uint256 amount;
        uint256 expirationTimestamp;
        address escrow;
        address to;
        bool exists;
    }

    mapping(bytes32 => mapping(address => uint256)) public balanceOfByPartition;
    mapping(bytes32 => mapping(address => uint256)) public heldOfByPartition;
    mapping(bytes32 => mapping(address => mapping(address => bool))) private _operators;
    mapping(address => mapping(address => uint256)) public allowance;
    mapping(bytes32 => mapping(address => mapping(uint256 => Hold))) private _holds;
    mapping(bytes32 => mapping(address => uint256)) private _nextHoldId;

    mapping(address => bool) public blocked;
    mapping(address => bool) public kycGranted;
    bool public paused;
    /// @dev Blanket refusal, for exercising the compliance branch independently of the others.
    bool public complianceRefuses;

    mapping(address => mapping(uint256 => uint256)) private _kpi;
    mapping(address => uint256[]) private _kpiDates;

    // ------------------------------------------------------------------------ test setup

    function mint(bytes32 partition, address to, uint256 amount) external {
        balanceOfByPartition[partition][to] += amount;
        kycGranted[to] = true;
    }

    function setBlocked(address account, bool value) external {
        blocked[account] = value;
    }

    function setKyc(address account, bool value) external {
        kycGranted[account] = value;
    }

    function setPaused(bool value) external {
        paused = value;
    }

    function setComplianceRefuses(bool value) external {
        complianceRefuses = value;
    }

    function approve(address spender, uint256 value) external returns (bool) {
        allowance[msg.sender][spender] = value;
        return true;
    }

    function authorizeOperatorByPartition(bytes32 partition, address operator) external {
        _operators[partition][msg.sender][operator] = true;
    }

    function revokeOperatorByPartition(bytes32 partition, address operator) external {
        _operators[partition][msg.sender][operator] = false;
    }

    function isOperatorForPartition(
        bytes32 partition,
        address operator,
        address holder
    ) external view returns (bool) {
        return _operators[partition][holder][operator];
    }

    // ------------------------------------------------------------------------ pre-flight

    /// @dev Non-reverting by contract. Every branch returns rather than throws.
    function canTransferByPartition(
        address from,
        address to,
        bytes32 partition,
        uint256 value,
        bytes calldata,
        bytes calldata
    ) external view returns (bool status, bytes1 code, bytes32 reason) {
        if (paused) return (false, EIP1066_DISALLOWED, bytes32(bytes4(0x1309a563)));
        if (blocked[from] || blocked[to]) return (false, EIP1066_DISALLOWED, bytes32(bytes4(0x796c1f0d)));
        if (!kycGranted[from] || !kycGranted[to]) {
            return (false, EIP1066_DISALLOWED, bytes32(bytes4(0xfc855b1b)));
        }
        if (complianceRefuses) return (false, EIP1066_DISALLOWED, bytes32(bytes4(0x66eb1b54)));
        if (balanceOfByPartition[partition][from] < value) {
            return (false, EIP1066_DISALLOWED, bytes32(bytes4(0x66eb1b54)));
        }
        return (true, EIP1066_SUCCESS, bytes32(0));
    }

    // ------------------------------------------------------------------------ holds

    function createHoldFromByPartition(
        bytes32 partition,
        address from,
        IAtsHold.Hold calldata hold,
        bytes calldata
    ) external returns (bool success_, uint256 holdId_) {
        uint256 allowed = allowance[from][msg.sender];
        if (allowed < hold.amount) revert InsufficientAllowance(msg.sender, from);
        if (blocked[from]) revert AccountIsBlocked(from);

        uint256 available = balanceOfByPartition[partition][from];
        if (available < hold.amount) revert InsufficientBalance(from, available, hold.amount);
        allowance[from][msg.sender] = allowed - hold.amount;

        balanceOfByPartition[partition][from] = available - hold.amount;
        heldOfByPartition[partition][from] += hold.amount;

        holdId_ = ++_nextHoldId[partition][from];
        _holds[partition][from][holdId_] = Hold({
            amount: hold.amount,
            expirationTimestamp: hold.expirationTimestamp,
            escrow: hold.escrow,
            to: hold.to,
            exists: true
        });
        return (true, holdId_);
    }

    function executeHoldByPartition(
        IAtsHold.HoldIdentifier calldata id,
        address to,
        uint256 amount
    ) external returns (bool success_, bytes32 partition_) {
        Hold storage hold = _holds[id.partition][id.tokenHolder][id.holdId];
        if (!hold.exists) revert WrongHoldId();
        if (blocked[id.tokenHolder]) revert AccountIsBlocked(id.tokenHolder);
        // Zero destination means the hold did not fix a recipient at creation.
        if (hold.to != address(0) && to != hold.to) revert InvalidDestinationAddress(hold.to, to);
        if (block.timestamp >= hold.expirationTimestamp) revert HoldExpirationReached();
        if (msg.sender != hold.escrow) revert IsNotEscrow();
        if (hold.amount < amount) revert InsufficientBalance(id.tokenHolder, hold.amount, amount);

        hold.amount -= amount;
        heldOfByPartition[id.partition][id.tokenHolder] -= amount;
        balanceOfByPartition[id.partition][to] += amount;
        return (true, id.partition);
    }

    function releaseHoldByPartition(
        IAtsHold.HoldIdentifier calldata id,
        uint256 amount
    ) external returns (bool) {
        Hold storage hold = _holds[id.partition][id.tokenHolder][id.holdId];
        if (!hold.exists) revert WrongHoldId();
        if (block.timestamp >= hold.expirationTimestamp) revert HoldExpirationReached();
        if (msg.sender != hold.escrow) revert IsNotEscrow();
        if (hold.amount < amount) revert InsufficientBalance(id.tokenHolder, hold.amount, amount);

        hold.amount -= amount;
        heldOfByPartition[id.partition][id.tokenHolder] -= amount;
        balanceOfByPartition[id.partition][id.tokenHolder] += amount;
        return true;
    }

    function reclaimHoldByPartition(IAtsHold.HoldIdentifier calldata id) external returns (bool) {
        Hold storage hold = _holds[id.partition][id.tokenHolder][id.holdId];
        if (!hold.exists) revert WrongHoldId();
        if (block.timestamp < hold.expirationTimestamp) revert HoldExpirationNotReached();

        uint256 amount = hold.amount;
        hold.amount = 0;
        heldOfByPartition[id.partition][id.tokenHolder] -= amount;
        balanceOfByPartition[id.partition][id.tokenHolder] += amount;
        return true;
    }

    function getHeldAmountForByPartition(bytes32 partition, address holder) external view returns (uint256) {
        return heldOfByPartition[partition][holder];
    }

    // ------------------------------------------------------------------------ operator transfer

    function operatorTransferByPartition(
        IAtsOperator.OperatorTransferData calldata d
    ) external returns (bytes32) {
        if (!_operators[d.partition][d.from][msg.sender]) revert NotOperator(msg.sender, d.from);
        if (blocked[d.from] || blocked[d.to]) revert AccountIsBlocked(blocked[d.from] ? d.from : d.to);

        uint256 available = balanceOfByPartition[d.partition][d.from];
        if (available < d.value) revert InsufficientBalance(d.from, available, d.value);

        balanceOfByPartition[d.partition][d.from] = available - d.value;
        balanceOfByPartition[d.partition][d.to] += d.value;
        return d.partition;
    }

    // ------------------------------------------------------------------------ KPI ingress

    function addKpiData(uint256 date, uint256 value, address project) external {
        if (_kpi[project][date] != 0) revert KpiDataAlreadyExists(date);
        _kpi[project][date] = value;
        _kpiDates[project].push(date);
    }

    function getLatestKpiData(
        uint256 from,
        uint256 to,
        address project
    ) external view returns (uint256 value_, bool exists_) {
        uint256[] storage dates = _kpiDates[project];
        uint256 best;
        for (uint256 i; i < dates.length; ++i) {
            uint256 d = dates[i];
            if (d >= from && d <= to && d >= best) {
                best = d;
                value_ = _kpi[project][d];
                exists_ = true;
            }
        }
    }

    function kpiAt(address project, uint256 date) external view returns (uint256) {
        return _kpi[project][date];
    }

    function kpiCount(address project) external view returns (uint256) {
        return _kpiDates[project].length;
    }
}
