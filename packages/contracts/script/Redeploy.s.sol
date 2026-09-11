// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { Script } from "forge-std/Script.sol";
import { console } from "forge-std/console.sol";

import { MandateVerifier } from "../src/authority/MandateVerifier.sol";
import { MandateVerifierAdapter } from "../src/authority/MandateVerifierAdapter.sol";
import { CoverageOracle } from "../src/CoverageOracle.sol";
import { LoadLine } from "../src/LoadLine.sol";
import { CashLegController } from "../src/CashLegController.sol";
import { ICoverageOracle, ILoadLine } from "../src/interfaces/IPlimsoll.sol";
import { IMandateAuthority } from "../src/interfaces/IMandateAuthority.sol";

/**
 * @notice Replaces the authority stack while keeping the oracle and the note registered on it.
 *
 * @dev The verifier's `authority` is immutable, so trusting a different device means a new
 *      verifier, and the adapter's `verifier` is immutable too. LoadLine has to be replaced as well:
 *      binding the written threshold to the mandate changed how it calls the authority. And
 *      CashLegController reads an immutable LoadLine, so it goes with it - which in turn means a
 *      new cash token, because the old token's freeze key belongs to the old controller forever.
 *
 *      The CoverageOracle survives because its load line is an owner-settable pointer; keeping it
 *      preserves the registered note and its attestor, which the attestor service depends on.
 *      Run CreateCashToken (via cast send) and DeployVenue after this.
 */
contract RedeployAuthority is Script {
    function run() external {
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(deployerKey);
        address owner = vm.envOr("OWNER", deployer);
        require(owner == deployer, "rewiring the kept oracle needs the owner's key");

        address deviceSigner = vm.envAddress("MANDATE_AUTHORITY_SIGNER");
        CoverageOracle oracle = CoverageOracle(vm.envAddress("COVERAGE_ORACLE"));
        string memory market = vm.envString("NOTE_MARKET");

        address predictedLoadLine = vm.computeCreateAddress(deployer, vm.getNonce(deployer) + 1);

        vm.startBroadcast(deployerKey);

        MandateVerifierAdapter adapter = new MandateVerifierAdapter(deviceSigner, predictedLoadLine);
        MandateVerifier verifier = adapter.verifier();
        LoadLine loadLine = new LoadLine(IMandateAuthority(address(adapter)), owner);
        require(address(loadLine) == predictedLoadLine, "LoadLine landed where the adapter does not look");
        CashLegController cashController = new CashLegController(ILoadLine(address(loadLine)), owner);

        oracle.setLoadLine(ILoadLine(address(loadLine)));
        loadLine.setOracle(ICoverageOracle(address(oracle)));
        bytes32 noteId = adapter.registerMarket(market);

        vm.stopBroadcast();

        // The note id every contract keys on is the hash of the string the human reads; if the
        // kept oracle does not know it, the stack is wired to the wrong note.
        require(oracle.noteOf(noteId).registered, "kept oracle does not know this market's note");

        console.log("MANDATE_VERIFIER=%s", address(verifier));
        console.log("MANDATE_ADAPTER=%s", address(adapter));
        console.log("LOAD_LINE=%s", address(loadLine));
        console.log("CASH_CONTROLLER=%s", address(cashController));
        console.log("NOTE_ID=%s", vm.toString(noteId));
        console.log("DEVICE_SIGNER=%s", deviceSigner);
    }
}
