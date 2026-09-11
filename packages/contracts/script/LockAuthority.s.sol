// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { Script } from "forge-std/Script.sol";
import { console } from "forge-std/console.sol";

import { MandateVerifier } from "../src/authority/MandateVerifier.sol";
import { MandateVerifierAdapter } from "../src/authority/MandateVerifierAdapter.sol";
import { LoadLine } from "../src/LoadLine.sol";
import { IMandateAuthority } from "../src/interfaces/IMandateAuthority.sol";

/**
 * @notice Puts a locked authority in front of the LoadLine that is already deployed.
 *
 * @dev LoadLine is kept, which keeps CashLegController and the cash token whose freeze key it holds.
 *      The new adapter is built around LoadLine's existing address and creates its own verifier, so
 *      both hops are locked from the moment they exist. LoadLine is then repointed through its
 *      existing owner-gated setter. Nothing here is a setter left open between transactions.
 */
contract LockAuthority is Script {
    function run() external {
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(deployerKey);
        address deviceSigner = vm.envAddress("MANDATE_AUTHORITY_SIGNER");
        LoadLine loadLine = LoadLine(vm.envAddress("LOAD_LINE"));
        string memory market = vm.envString("NOTE_MARKET");
        require(loadLine.owner() == deployer, "only LoadLine's owner can repoint its authority");

        vm.startBroadcast(deployerKey);
        MandateVerifierAdapter adapter = new MandateVerifierAdapter(deviceSigner, address(loadLine));
        bytes32 noteId = adapter.registerMarket(market);
        loadLine.setMandateAuthority(IMandateAuthority(address(adapter)));
        vm.stopBroadcast();

        MandateVerifier verifier = adapter.verifier();
        require(verifier.gatekeeper() == address(adapter), "verifier is not locked to its adapter");
        require(verifier.authority() == deviceSigner, "verifier trusts the wrong key");
        require(adapter.loadLine() == address(loadLine), "adapter is not locked to LoadLine");
        require(address(loadLine.mandateAuthority()) == address(adapter), "LoadLine was not repointed");

        console.log("MANDATE_ADAPTER=%s", address(adapter));
        console.log("MANDATE_VERIFIER=%s", address(verifier));
        console.log("LOAD_LINE=%s", address(loadLine));
        console.log("NOTE_ID=%s", vm.toString(noteId));
    }
}
