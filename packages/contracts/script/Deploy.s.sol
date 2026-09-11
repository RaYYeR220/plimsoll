// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { Script } from "forge-std/Script.sol";
import { console } from "forge-std/console.sol";

import { MandateVerifier } from "../src/authority/MandateVerifier.sol";
import { MandateVerifierAdapter } from "../src/authority/MandateVerifierAdapter.sol";
import { CoverageOracle } from "../src/CoverageOracle.sol";
import { LoadLine } from "../src/LoadLine.sol";
import { CashLegController } from "../src/CashLegController.sol";
import { BerthMarket } from "../src/BerthMarket.sol";
import { CouponScheduler } from "../src/CouponScheduler.sol";
import { ICoverageOracle, ILoadLine } from "../src/interfaces/IPlimsoll.sol";
import { IMandateAuthority } from "../src/interfaces/IMandateAuthority.sol";
import { IERC20 } from "../src/interfaces/IERC20.sol";

/**
 * @notice Deploys the authority, the oracle and the load line, and wires them together.
 * @dev Split from the venue because the cash leg is an HTS token that has to exist before
 *      {BerthMarket} and {CouponScheduler} can take its address as an immutable. Run this, then
 *      CreateCashToken, then DeployVenue. Every input comes from the environment; no key and no
 *      address is hardcoded here.
 */
contract DeployCore is Script {
    function run() external {
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(deployerKey);
        address owner = vm.envOr("OWNER", deployer);
        address authoritySigner = vm.envAddress("MANDATE_AUTHORITY_SIGNER");

        vm.startBroadcast(deployerKey);

        MandateVerifier verifier = new MandateVerifier(authoritySigner);
        MandateVerifierAdapter adapter = new MandateVerifierAdapter(verifier);
        CoverageOracle oracle = new CoverageOracle(owner);
        LoadLine loadLine = new LoadLine(IMandateAuthority(address(adapter)), owner);
        CashLegController cashController = new CashLegController(ILoadLine(address(loadLine)), owner);

        // Only the owner may wire these, so this works only while the deployer still is the owner.
        if (owner == deployer) {
            oracle.setLoadLine(ILoadLine(address(loadLine)));
            loadLine.setOracle(ICoverageOracle(address(oracle)));
        }

        vm.stopBroadcast();

        console.log("MANDATE_VERIFIER=%s", address(verifier));
        console.log("MANDATE_ADAPTER=%s", address(adapter));
        console.log("COVERAGE_ORACLE=%s", address(oracle));
        console.log("LOAD_LINE=%s", address(loadLine));
        console.log("CASH_CONTROLLER=%s", address(cashController));
        if (owner != deployer) {
            console.log("owner is not the deployer: call setLoadLine and setOracle as %s", owner);
        }
    }
}

/**
 * @notice Creates the HTS cash token whose freeze key is the circuit breaker.
 * @dev Payable: HTS charges an HBAR fee for `createFungibleToken`, so the controller has to be
 *      funded first. The token is created with no admin key, which makes the freeze key
 *      permanent and this controller irreplaceable for it. That is deliberate and irreversible.
 */
contract CreateCashToken is Script {
    function run() external {
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        CashLegController controller = CashLegController(payable(vm.envAddress("CASH_CONTROLLER")));
        uint256 fee = vm.envUint("CASH_CREATE_FEE_WEI");

        vm.startBroadcast(deployerKey);

        // The HTS fee is paid by the contract, so it needs the HBAR before the call.
        (bool funded, ) = address(controller).call{ value: fee }("");
        require(funded, "could not fund the controller for the HTS create fee");

        address token = controller.createCashToken(
            vm.envString("CASH_NAME"),
            vm.envString("CASH_SYMBOL"),
            "Plimsoll cash leg",
            int32(uint32(vm.envUint("CASH_DECIMALS"))),
            0,
            int64(uint64(vm.envUint("CASH_MAX_SUPPLY")))
        );

        vm.stopBroadcast();
        console.log("CASH_TOKEN=%s", token);
    }
}

/// @notice Deploys the venue over an existing cash token.
contract DeployVenue is Script {
    function run() external {
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        address owner = vm.envOr("OWNER", vm.addr(deployerKey));

        ILoadLine loadLine = ILoadLine(vm.envAddress("LOAD_LINE"));
        ICoverageOracle oracle = ICoverageOracle(vm.envAddress("COVERAGE_ORACLE"));
        IERC20 cash = IERC20(vm.envAddress("CASH_TOKEN"));

        vm.startBroadcast(deployerKey);
        BerthMarket market = new BerthMarket(loadLine, cash);
        CouponScheduler scheduler = new CouponScheduler(loadLine, oracle, cash, owner);
        vm.stopBroadcast();

        console.log("BERTH_MARKET=%s", address(market));
        console.log("COUPON_SCHEDULER=%s", address(scheduler));
    }
}

/**
 * @notice Registers the note: its market code, its attestor, its backing set and its load line.
 * @dev The market code is registered on the adapter first, because the note id every other
 *      contract keys on is the hash of that exact string - the one a human reads on the device.
 *      Deriving it any other way would let the chain and the screen disagree.
 *
 *      The opening load line is NOT set here. Moving a load line requires a device mandate, so
 *      it is set by submitting a signed mandate to LoadLine.setThreshold; this script prints the
 *      note id that mandate has to name.
 */
contract ConfigureNote is Script {
    function run() external {
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        MandateVerifierAdapter adapter = MandateVerifierAdapter(vm.envAddress("MANDATE_ADAPTER"));
        CoverageOracle oracle = CoverageOracle(vm.envAddress("COVERAGE_ORACLE"));

        string memory market = vm.envString("NOTE_MARKET");
        address attestor = vm.envAddress("ATTESTOR");
        bytes32 vaultSetHash = vm.envBytes32("VAULT_SET_HASH");
        uint64 maxAge = uint64(vm.envUint("MAX_AGE_SECONDS"));

        vm.startBroadcast(deployerKey);
        bytes32 noteId = adapter.registerMarket(market);
        oracle.registerNote(noteId, attestor, vaultSetHash, maxAge);
        vm.stopBroadcast();

        console.log("NOTE_MARKET=%s", market);
        console.log("NOTE_ID=%s", vm.toString(noteId));
        console.log("Set the opening load line with a signed mandate naming this market.");
    }
}
