// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { Script } from "forge-std/Script.sol";
import { console } from "forge-std/console.sol";

/**
 * @notice Issues a real tokenised note through the Hedera Asset Tokenization Studio v8.0.0
 *         already deployed on testnet, and then proves that ATS refuses a transfer it should.
 *
 * @dev Nothing here deploys ATS. The factory and resolver are live testnet contracts and this
 *      script is a client of them, which is the point: Plimsoll trades notes issued by the real
 *      thing, not by a mock of it.
 *
 *      The note is deployed in blacklist mode (`isWhiteList: false`), so an address added to the
 *      control list is blocked rather than everyone else being blocked. That is what makes the
 *      denial demonstrable against one specific counterparty.
 */
interface IAtsFactory {
    struct ResolverProxyConfiguration {
        bytes32 key;
        uint256 version;
    }

    struct ERC20MetadataInfo {
        string name;
        string symbol;
        string isin;
        uint8 decimals;
    }

    struct Rbac {
        bytes32 role;
        address[] members;
    }

    struct SecurityData {
        address resolver;
        uint256 maxSupply;
        ResolverProxyConfiguration resolverProxyConfiguration;
        ERC20MetadataInfo erc20MetadataInfo;
        Rbac[] rbacs;
        address[] externalPauses;
        address[] externalControlLists;
        address[] externalKycLists;
        address compliance;
        address identityRegistry;
        bool arePartitionsProtected;
        bool isMultiPartition;
        bool isControllable;
        bool isWhiteList;
        bool clearingActive;
        bool internalKycActivated;
        bool erc20VotesActivated;
    }

    struct BondDetailsData {
        bytes3 currency;
        uint256 nominalValue;
        uint8 nominalValueDecimals;
        uint256 startingDate;
        uint256 maturityDate;
    }

    struct BondData {
        SecurityData security;
        BondDetailsData bondDetails;
        address[] proceedRecipients;
        bytes[] proceedRecipientsData;
    }

    struct AdditionalSecurityData {
        bool countriesControlListType;
        string listOfCountries;
        string info;
    }

    struct FactoryRegulationData {
        uint8 regulationType;
        uint8 regulationSubType;
        AdditionalSecurityData additionalSecurityData;
    }

    function deployBond(
        BondData calldata bondData,
        FactoryRegulationData calldata regulationData
    ) external returns (address bondAddress_);
}

interface IAtsNote {
    struct IssueData {
        bytes32 partition;
        address tokenHolder;
        uint256 value;
        bytes data;
    }

    struct BasicTransferInfo {
        address to;
        uint256 value;
    }

    function grantKyc(
        address account,
        string memory vcId,
        uint256 validFrom,
        uint256 validTo,
        address issuer
    ) external returns (bool);

    function issueByPartition(IssueData calldata issueData) external;

    function addIssuer(address issuer) external returns (bool);

    function grantRole(bytes32 role, address account) external returns (bool);

    function authorizeOperatorByPartition(bytes32 partition, address operator) external;

    function approve(address spender, uint256 value) external returns (bool);

    function transferByPartition(
        bytes32 partition,
        BasicTransferInfo calldata info,
        bytes memory data
    ) external returns (bytes32);

    function addToControlList(address account) external returns (bool);

    function balanceOfByPartition(bytes32 partition, address holder) external view returns (uint256);

    function canTransferByPartition(
        address from,
        address to,
        bytes32 partition,
        uint256 value,
        bytes calldata data,
        bytes calldata operatorData
    ) external view returns (bool status, bytes1 code, bytes32 reason);
}

contract IssueNote is Script {
    bytes32 private constant DEFAULT_PARTITION = bytes32(uint256(1));

    bytes32 private constant DEFAULT_ADMIN_ROLE = 0x00;
    bytes32 private constant ROLE_ISSUER = 0x5eeaf5602c75bf26e73b5206d0bd6ee82f621166255e5fd73cc06bc7bd84a95f;
    bytes32 private constant ROLE_KYC = 0x754f499f9fdfbb089d12bdec817a6863d593d8a3ea7f546c00a5cafd20957bfc;
    bytes32 private constant ROLE_KYC_MANAGER = 0xec811504e835acf29535b5b62307b08000468f0c61ca6163ed6f17a03629b91e;
    bytes32 private constant ROLE_INTERNAL_KYC_MANAGER =
        0xdd78fdcd1b38a5360405cef8d91e758ad0f42bf2ced681b803b3c2704b0a32a7;
    bytes32 private constant ROLE_CONTROLLER = 0xb4d2b850c3ed8a234d390d5c157bbb1824883213c335ffe2a0f0761bb168713e;
    bytes32 private constant ROLE_CONTROL_LIST =
        0x6ed9a91e996c6475ecdc28ecbdbe9bd1122fc62b30cdbe6da8271884b51ec74d;
    bytes32 private constant ROLE_KPI_MANAGER = 0x7895574f0552ac1a42245f5d7ea23bea04d0cfbc73df53282d588fdaa00f7fb3;
    bytes32 private constant ROLE_PAUSER = 0x3cb8b459fdb6e7dc3d2a2aa529e530f885d45e03584adb438423209c86a2731f;
    bytes32 private constant ROLE_SSI_MANAGER =
        0x3120494a82251fe85b0403877539486dbfcf0f94c20741a3229cfad31f625ee1;

    function run() external {
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(deployerKey);
        IAtsFactory factory = IAtsFactory(vm.envAddress("ATS_FACTORY"));
        address resolver = vm.envAddress("ATS_RESOLVER");

        IAtsFactory.Rbac[] memory rbacs = _rbacs(deployer);

        IAtsFactory.SecurityData memory security = IAtsFactory.SecurityData({
            resolver: resolver,
            // Defaults reproduce PLIM-A; a series is otherwise described entirely by the environment.
            maxSupply: vm.envOr("NOTE_MAX_SUPPLY", uint256(1_000_000_00)),
            resolverProxyConfiguration: IAtsFactory.ResolverProxyConfiguration({
                key: vm.envBytes32("ATS_BOND_CONFIG_ID"),
                version: vm.envUint("ATS_BOND_CONFIG_VERSION")
            }),
            erc20MetadataInfo: IAtsFactory.ERC20MetadataInfo({
                name: vm.envOr("NOTE_NAME", string("Plimsoll Note Series A")),
                symbol: vm.envOr("NOTE_MARKET", string("PLIM-A")),
                isin: vm.envOr("NOTE_ISIN", string("US0000PLIMA6")),
                decimals: 2
            }),
            rbacs: rbacs,
            externalPauses: new address[](0),
            externalControlLists: new address[](0),
            externalKycLists: new address[](0),
            compliance: address(0),
            identityRegistry: address(0),
            arePartitionsProtected: false,
            isMultiPartition: false,
            isControllable: true,
            // Blacklist mode. A listed address is blocked; everyone else trades. This is what
            // makes a denial demonstrable against one named counterparty.
            isWhiteList: false,
            clearingActive: false,
            internalKycActivated: true,
            erc20VotesActivated: false
        });

        IAtsFactory.BondData memory bond = IAtsFactory.BondData({
            security: security,
            bondDetails: IAtsFactory.BondDetailsData({
                currency: 0x555344, // "USD"
                // ATS stores par as an integer plus its own decimals: 100_00 at 2 decimals is 100.00.
                nominalValue: vm.envOr("NOTE_NOMINAL_VALUE", uint256(100_00)),
                nominalValueDecimals: 2,
                startingDate: block.timestamp + 60,
                maturityDate: block.timestamp + 365 days
            }),
            proceedRecipients: new address[](0),
            proceedRecipientsData: new bytes[](0)
        });

        IAtsFactory.FactoryRegulationData memory reg = IAtsFactory.FactoryRegulationData({
            regulationType: 1, // REG_S
            regulationSubType: 0, // must be NONE for REG_S
            additionalSecurityData: IAtsFactory.AdditionalSecurityData({
                countriesControlListType: true,
                listOfCountries: "",
                info: "Plimsoll tokenised note backed by ERC-4626 vault positions"
            })
        });

        vm.startBroadcast(deployerKey);
        address note = factory.deployBond(bond, reg);
        vm.stopBroadcast();

        console.log("ATS_NOTE=%s", note);
    }

    function _rbacs(address deployer) private pure returns (IAtsFactory.Rbac[] memory rbacs) {
        bytes32[10] memory roles = [
            DEFAULT_ADMIN_ROLE,
            ROLE_ISSUER,
            ROLE_KYC,
            ROLE_KYC_MANAGER,
            ROLE_INTERNAL_KYC_MANAGER,
            ROLE_CONTROLLER,
            ROLE_CONTROL_LIST,
            ROLE_KPI_MANAGER,
            ROLE_PAUSER,
            // ATS will not accept a KYC grant from an address it does not recognise as an
            // issuer, and only the SSI manager can add one. Without this the note is deployed
            // but nobody can ever be KYC'd on it.
            ROLE_SSI_MANAGER
        ];
        rbacs = new IAtsFactory.Rbac[](roles.length);
        for (uint256 i; i < roles.length; ++i) {
            address[] memory members = new address[](1);
            members[0] = deployer;
            rbacs[i] = IAtsFactory.Rbac({ role: roles[i], members: members });
        }
    }
}

/// @notice Grants KYC, issues notes, and moves some to a second holder.
contract ActivateNote is Script {
    bytes32 private constant DEFAULT_PARTITION = bytes32(uint256(1));

    function run() external {
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(deployerKey);
        IAtsNote note = IAtsNote(vm.envAddress("ATS_NOTE"));
        address buyer = vm.envAddress("BUYER_EVM_ADDRESS");

        vm.startBroadcast(deployerKey);
        // Register ourselves as a credential issuer before issuing any credentials.
        note.addIssuer(deployer);
        note.grantKyc(deployer, "plimsoll-vc-1", block.timestamp, block.timestamp + 365 days, deployer);
        note.grantKyc(buyer, "plimsoll-vc-2", block.timestamp, block.timestamp + 365 days, deployer);

        note.issueByPartition(
            IAtsNote.IssueData({
                partition: DEFAULT_PARTITION,
                tokenHolder: deployer,
                value: vm.envOr("NOTE_ISSUE_AMOUNT", uint256(10_000_00)),
                data: ""
            })
        );

        // PLIM-A moved part of its issue to a second holder; a series may instead stay with the issuer.
        uint256 toBuyer = vm.envOr("NOTE_TRANSFER_AMOUNT", uint256(1_000_00));
        if (toBuyer != 0) {
            note.transferByPartition(DEFAULT_PARTITION, IAtsNote.BasicTransferInfo({ to: buyer, value: toBuyer }), "");
        }
        vm.stopBroadcast();

        console.log("issuer balance  %s", note.balanceOfByPartition(DEFAULT_PARTITION, deployer));
        console.log("buyer  balance  %s", note.balanceOfByPartition(DEFAULT_PARTITION, buyer));
    }
}

/**
 * @notice Blocks a counterparty and records the refusal, both ways ATS can express it.
 * @dev Two artifacts come out of this. The pre-flight `canTransferByPartition` returns
 *      `(false, code, reason)` without reverting - the call Plimsoll's matching engine makes
 *      before it books anything. The transfer itself then reverts with `AccountIsBlocked(address)`
 *      (`0x796c1f0d`) - what would have happened to a venue that skipped the pre-flight.
 */
contract BlockAndProve is Script {
    bytes32 private constant DEFAULT_PARTITION = bytes32(uint256(1));

    function run() external {
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(deployerKey);
        IAtsNote note = IAtsNote(vm.envAddress("ATS_NOTE"));
        address subject = vm.envAddress("SUBJECT_EVM_ADDRESS");
        address buyer = vm.envAddress("BUYER_EVM_ADDRESS");

        vm.startBroadcast(deployerKey);
        note.grantKyc(subject, "plimsoll-vc-3", block.timestamp, block.timestamp + 365 days, deployer);
        note.addToControlList(subject);
        vm.stopBroadcast();

        (bool blockedOk, bytes1 blockedCode, bytes32 blockedReason) = note.canTransferByPartition(
            deployer,
            subject,
            DEFAULT_PARTITION,
            100,
            "",
            ""
        );
        console.log("preflight to BLOCKED  status=%s", blockedOk);
        console.log("  code   %s", vm.toString(blockedCode));
        console.log("  reason %s", vm.toString(blockedReason));

        (bool allowedOk, bytes1 allowedCode, bytes32 allowedReason) = note.canTransferByPartition(
            deployer,
            buyer,
            DEFAULT_PARTITION,
            100,
            "",
            ""
        );
        console.log("preflight to ALLOWED  status=%s", allowedOk);
        console.log("  code   %s", vm.toString(allowedCode));
        console.log("  reason %s", vm.toString(allowedReason));
    }
}

interface ICouponScheduler {
    struct ScheduleParams {
        address note;
        address project;
        address payer;
        address paymentAgent;
        uint128 couponAmount;
        uint64 firstPaymentAt;
        uint64 period;
        uint64 maturity;
        uint64 gasLimit;
        uint32 maxPeriods;
    }

    function createSchedule(bytes32 noteId, ScheduleParams calldata p) external;
}

/**
 * @notice Connects an issued note to the venue: coupon KPI rights, market escrow rights, a schedule.
 * @dev The scheduler writes coverage into the note's KPI series, which ATS gates on
 *      ROLE_KPI_MANAGER. The issuer authorises BerthMarket as operator (what a bid needs) and, if
 *      NOTE_LIST_AMOUNT is set, approves it an allowance (what an ask's escrow needs), so an order
 *      can be placed the moment coverage is proven - placing it now would be refused, correctly,
 *      because nothing has attested this note yet. The schedule is created but not armed for the same
 *      reason: arming requires a clear load line.
 */
contract ConnectNote is Script {
    bytes32 private constant DEFAULT_PARTITION = bytes32(uint256(1));
    bytes32 private constant ROLE_KPI_MANAGER = 0x7895574f0552ac1a42245f5d7ea23bea04d0cfbc73df53282d588fdaa00f7fb3;

    function run() external {
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        address issuer = vm.addr(deployerKey);
        IAtsNote note = IAtsNote(vm.envAddress("ATS_NOTE"));
        address scheduler = vm.envAddress("COUPON_SCHEDULER");
        address market = vm.envAddress("BERTH_MARKET");
        bytes32 noteId = keccak256(bytes(vm.envString("NOTE_MARKET")));

        ICouponScheduler.ScheduleParams memory p = ICouponScheduler.ScheduleParams({
            note: address(note),
            project: issuer,
            payer: issuer,
            paymentAgent: vm.envAddress("COUPON_PAYMENT_AGENT"),
            couponAmount: uint128(vm.envUint("COUPON_AMOUNT")),
            firstPaymentAt: uint64(block.timestamp + vm.envUint("COUPON_FIRST_IN_SECONDS")),
            period: uint64(vm.envUint("COUPON_PERIOD_SECONDS")),
            maturity: uint64(block.timestamp + vm.envUint("COUPON_MATURITY_IN_SECONDS")),
            gasLimit: uint64(vm.envUint("COUPON_GAS_LIMIT")),
            maxPeriods: uint32(vm.envUint("COUPON_MAX_PERIODS"))
        });

        vm.startBroadcast(deployerKey);
        note.grantRole(ROLE_KPI_MANAGER, scheduler);
        note.authorizeOperatorByPartition(DEFAULT_PARTITION, market);
        // Asks are escrowed with createHoldFromByPartition, which ATS funds from an ERC-20 allowance;
        // operator rights alone are refused with InsufficientAllowance. The operator grant above is
        // what bids need.
        uint256 listAmount = vm.envOr("NOTE_LIST_AMOUNT", uint256(0));
        if (listAmount != 0) note.approve(market, listAmount);
        ICouponScheduler(scheduler).createSchedule(noteId, p);
        vm.stopBroadcast();

        console.log("NOTE_ID=%s", vm.toString(noteId));
        console.log("firstPaymentAt=%s maturity=%s", p.firstPaymentAt, p.maturity);
    }
}
