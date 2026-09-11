// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { Script } from "forge-std/Script.sol";
import { console } from "forge-std/console.sol";
import { IAtsHold, IAtsPreflight, IAtsBalance } from "../src/interfaces/IAts.sol";

interface INoteAllowance {
    function approve(address spender, uint256 amount) external returns (bool);
    function allowance(address owner, address spender) external view returns (uint256);
}

/// @notice Dry-runs, against live chain state, the ATS calls BerthMarket makes to list and settle an ask.
/// @dev Run with --fork-url and without --broadcast; nothing is sent. A plain eth_call cannot answer
///      this on Hedera, because the relay does not honour a contract as `from`. The probe first tries
///      the hold with operator rights only, then again after the holder approves the market for the
///      exact amount, then executes that hold to the taker - the whole ask path, on real ATS logic.
contract ProbeEscrow is Script {
    bytes32 private constant PARTITION = bytes32(uint256(1));
    uint256 private constant AMOUNT = 100;

    function run() external {
        address note = vm.envAddress("ATS_NOTE");
        address market = vm.envAddress("BERTH_MARKET");
        address holder = vm.envAddress("PROBE_HOLDER");
        address taker = vm.envAddress("PROBE_TAKER");

        vm.prank(market);
        (bool ok, bytes1 code, ) = IAtsPreflight(note).canTransferByPartition(holder, taker, PARTITION, AMOUNT, "", "");
        console.log("1 preflight as market, allowed:", ok);
        console.logBytes1(code);

        console.log("2 hold with operator rights only:");
        _tryHold(note, market, holder, taker, false);

        vm.prank(holder);
        INoteAllowance(note).approve(market, AMOUNT);
        console.log("3 hold after the holder approves the market for", AMOUNT);
        console.log("  allowance before:", INoteAllowance(note).allowance(holder, market));
        _tryHold(note, market, holder, taker, true);
        console.log("  allowance after: ", INoteAllowance(note).allowance(holder, market));
    }

    function _tryHold(address note, address market, address holder, address taker, bool settle) private {
        vm.prank(market);
        try IAtsHold(note).createHoldFromByPartition(
            PARTITION,
            holder,
            IAtsHold.Hold({ amount: AMOUNT, expirationTimestamp: block.timestamp + 1 days, escrow: market, to: address(0), data: "" }),
            ""
        ) returns (bool created, uint256 holdId) {
            console.log("  created:", created, "holdId:", holdId);
            if (!settle) return;
            uint256 before = IAtsBalance(note).balanceOfByPartition(PARTITION, taker);
            vm.prank(market);
            try IAtsHold(note).executeHoldByPartition(
                IAtsHold.HoldIdentifier({ partition: PARTITION, tokenHolder: holder, holdId: holdId }), taker, AMOUNT
            ) returns (bool done, bytes32) {
                console.log("  4 market executes hold to taker:", done);
                console.log("    taker balance", before, "->", IAtsBalance(note).balanceOfByPartition(PARTITION, taker));
            } catch (bytes memory err) {
                console.log("  4 execute REVERTED");
                console.logBytes(err);
            }
        } catch (bytes memory err) {
            console.log("  REVERTED");
            console.logBytes(err);
        }
    }
}
