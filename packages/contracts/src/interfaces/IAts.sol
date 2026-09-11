// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/**
 * @notice The slice of Hedera Asset Tokenization Studio v8.0.0 that Plimsoll actually calls.
 * @dev Declared locally rather than imported so this package builds without the ATS monorepo and
 *      so the exact surface we depend on is auditable in one screen. Selectors are ABI-identical
 *      to the deployed facets; anything not listed here we do not touch.
 */

/// @notice ERC-1410 hold lifecycle. This is the escrow — we do not write our own.
interface IAtsHold {
    struct Hold {
        uint256 amount;
        uint256 expirationTimestamp;
        address escrow;
        /// @dev `address(0)` means the destination is not fixed at creation and is chosen on
        ///      execute. That is what lets a resting order be escrowed before a taker exists.
        address to;
        bytes data;
    }

    struct HoldIdentifier {
        bytes32 partition;
        address tokenHolder;
        uint256 holdId;
    }

    function createHoldFromByPartition(
        bytes32 _partition,
        address _from,
        Hold calldata _hold,
        bytes calldata _operatorData
    ) external returns (bool success_, uint256 holdId_);

    function executeHoldByPartition(
        HoldIdentifier calldata _holdIdentifier,
        address _to,
        uint256 _amount
    ) external returns (bool success_, bytes32 partition_);

    function releaseHoldByPartition(
        HoldIdentifier calldata _holdIdentifier,
        uint256 _amount
    ) external returns (bool success_);

    function reclaimHoldByPartition(HoldIdentifier calldata _holdIdentifier) external returns (bool success_);

    function getHeldAmountForByPartition(
        bytes32 _partition,
        address _tokenHolder
    ) external view returns (uint256 amount_);
}

/// @notice ERC-1410 operator transfer, used to move an unescrowed leg.
interface IAtsOperator {
    struct OperatorTransferData {
        bytes32 partition;
        address from;
        address to;
        uint256 value;
        bytes data;
        bytes operatorData;
    }

    function operatorTransferByPartition(
        OperatorTransferData calldata _operatorTransferData
    ) external returns (bytes32);

    function isOperatorForPartition(
        bytes32 _partition,
        address _operator,
        address _tokenHolder
    ) external view returns (bool);

    function authorizeOperatorByPartition(bytes32 _partition, address _operator) external;
}

/// @notice Partition balances.
interface IAtsBalance {
    function balanceOfByPartition(bytes32 _partition, address _tokenHolder) external view returns (uint256);

    function totalSupplyByPartition(bytes32 _partition) external view returns (uint256);
}

/**
 * @notice The non-reverting transfer pre-flight.
 * @dev ATS ships two shapes of this check. `canTransferByPartition` is the one actually exposed
 *      by the `ComplianceByPartition` facet and returns three values. The four-value
 *      `isAbleToTransferFromByPartition` — which additionally returns ABI-encoded `details` —
 *      lives in an internal library in the v8.0.0 sources and is not reachable through the
 *      diamond. {Preflight} probes for it anyway and falls back, so the market keeps working
 *      whichever shape the deployed resolver exposes. Neither reverts: they report.
 */
interface IAtsPreflight {
    function canTransferByPartition(
        address _from,
        address _to,
        bytes32 _partition,
        uint256 _value,
        bytes calldata _data,
        bytes calldata _operatorData
    ) external view returns (bool status, bytes1 code, bytes32 reason);

    function isAbleToTransferFromByPartition(
        address _from,
        address _to,
        bytes32 _partition,
        uint256 _value,
        bytes calldata _data,
        bytes calldata _operatorData
    ) external view returns (bool status, bytes1 code, bytes32 reason, bytes memory details);
}

/**
 * @notice ATS's permissioned external-data ingress.
 * @dev `KpiLinkedRateLib` reads these points at coupon fixing time, so writing coverage here is
 *      what makes the coupon rate a function of coverage inside ATS's own architecture rather
 *      than a number we bolt on beside it. Requires ROLE_KPI_MANAGER on the token.
 */
interface IAtsKpis {
    function addKpiData(uint256 _date, uint256 _value, address _project) external;

    function getLatestKpiData(
        uint256 _from,
        uint256 _to,
        address _project
    ) external view returns (uint256 value_, bool exists_);
}
