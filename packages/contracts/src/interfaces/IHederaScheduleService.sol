// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/**
 * @title IHederaScheduleService
 * @notice HIP-1215 scheduled contract calls, system contract 0x16b.
 * @dev Verified selectors: scheduleCall 0x6f5bfde8, hasScheduleCapacity 0xdfb4a999.
 *
 *      Two properties drive the whole {CouponScheduler} design:
 *      1. These calls **never revert**. A failure arrives as an `int64` response code, and 22
 *         (SUCCESS) is the only code that means the schedule was created.
 *      2. `expirySecond` must be **strictly greater** than the current consensus second, and a
 *         schedule cannot be placed more than 62 days out. Recurring coupons therefore have to
 *         re-arm themselves, and anything longer than the ceiling has to hop.
 */
interface IHederaScheduleService {
    function scheduleCall(
        address to,
        uint256 expirySecond,
        uint256 gasLimit,
        uint64 value,
        bytes calldata callData
    ) external returns (int64 responseCode, address scheduleAddress);

    function hasScheduleCapacity(uint256 expirySecond, uint256 gasLimit) external returns (bool);
}
