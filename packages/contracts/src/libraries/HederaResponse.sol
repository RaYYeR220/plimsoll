// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/**
 * @title HederaResponse
 * @notice Response-code handling for the Hedera system contracts.
 * @dev The system contracts signal failure by returning a code, not by reverting, so an
 *      unchecked call silently succeeds forever. Everything in this package that touches 0x167
 *      or 0x16b goes through here.
 */
library HederaResponse {
    /// @dev Hedera `ResponseCodeEnum.SUCCESS`.
    int64 internal constant SUCCESS = 22;

    error HederaCallFailed(int64 responseCode);

    function ok(int64 responseCode) internal pure returns (bool) {
        return responseCode == SUCCESS;
    }

    function check(int64 responseCode) internal pure {
        if (responseCode != SUCCESS) revert HederaCallFailed(responseCode);
    }
}
