// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { Test } from "forge-std/Test.sol";
import { console } from "forge-std/console.sol";
import { Base } from "./Base.t.sol";
import { MandateVerifier } from "../src/authority/MandateVerifier.sol";
import { MandateVerifierAdapter } from "../src/authority/MandateVerifierAdapter.sol";

/**
 * @notice EIP-170, enforced as a test so it fails the build rather than the deploy.
 * @dev Hedera enforces the 24,576-byte runtime limit, and ATS v8.0.0 already sits at 97% of it in
 *      places. A contract that fits today and not next week is a deployment that fails on
 *      submission day, so the ceiling is asserted here with a margin rather than measured by eye
 *      in `forge build --sizes`.
 */
contract BytecodeSizeTest is Base {
    uint256 internal constant EIP170_LIMIT = 24_576;
    /// @dev The margin is the point. Passing at 24,500 bytes is not passing.
    uint256 internal constant COMFORT_CEILING = 20_000;

    function _check(string memory label, address target) internal view {
        uint256 size = target.code.length;
        assertGt(size, 0, string.concat(label, ": nothing deployed"));
        assertLt(size, EIP170_LIMIT, string.concat(label, ": over the EIP-170 limit"));
        assertLt(size, COMFORT_CEILING, string.concat(label, ": past the comfort ceiling"));
    }

    function test_EveryDeployedContractFitsUnderEip170() public {
        MandateVerifierAdapter adapter = new MandateVerifierAdapter(address(this), address(loadLine));
        _check("MandateVerifier", address(adapter.verifier()));
        _check("MandateVerifierAdapter", address(adapter));
        _check("CoverageOracle", address(oracle));
        _check("LoadLine", address(loadLine));
        _check("BerthMarket", address(market));
        _check("CouponScheduler", address(scheduler));
        _check("CashLegController", address(cashController));
    }

    function test_ReportSizes() public {
        MandateVerifierAdapter adapter = new MandateVerifierAdapter(address(this), address(loadLine));
        console_log("MandateVerifier", address(adapter.verifier()).code.length);
        console_log("MandateVerifierAdapter", address(adapter).code.length);
        console_log("CoverageOracle", address(oracle).code.length);
        console_log("LoadLine", address(loadLine).code.length);
        console_log("BerthMarket", address(market).code.length);
        console_log("CouponScheduler", address(scheduler).code.length);
        console_log("CashLegController", address(cashController).code.length);
    }

    function console_log(string memory label, uint256 size) private pure {
        // solhint-disable-next-line no-console
        console.log("%s: %s bytes (limit 24576)", label, size);
    }
}
