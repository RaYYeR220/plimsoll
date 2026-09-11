// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/**
 * @title IHederaTokenService
 * @notice The slice of the HTS system contract at 0x167 used by the cash leg.
 * @dev Every function here returns an `int64` Hedera response code and **does not revert on
 *      failure**. Treating a call as successful because it did not revert is the single easiest
 *      way to get this wrong, so all call sites run through {HederaResponse.check}.
 *
 *      Verified selectors: createFungibleToken 0x0fb65bf3, freezeToken 0x5b8f8584,
 *      unfreezeToken 0x52f91387, isFrozen 0x46de0fb1, isKyc 0xf2c31ff4,
 *      associateToken 0x49146bde, getTokenKey 0x3c4dd32e.
 */
interface IHederaTokenService {
    struct KeyValue {
        bool inheritAccountKey;
        address contractId;
        bytes ed25519;
        bytes ECDSA_secp256k1;
        address delegatableContractId;
    }

    struct TokenKey {
        /// @dev Bit flags: 1 admin, 2 kyc, 4 freeze, 8 wipe, 16 supply, 32 fee, 64 pause.
        uint256 keyType;
        KeyValue key;
    }

    struct Expiry {
        int64 second;
        address autoRenewAccount;
        int64 autoRenewPeriod;
    }

    struct HederaToken {
        string name;
        string symbol;
        address treasury;
        string memo;
        bool tokenSupplyType;
        int64 maxSupply;
        /// @dev When true every account is frozen on association until explicitly unfrozen.
        bool freezeDefault;
        TokenKey[] tokenKeys;
        Expiry expiry;
    }

    function createFungibleToken(
        HederaToken memory token,
        int64 initialTotalSupply,
        int32 decimals
    ) external payable returns (int64 responseCode, address tokenAddress);

    function freezeToken(address token, address account) external returns (int64 responseCode);

    function unfreezeToken(address token, address account) external returns (int64 responseCode);

    function isFrozen(address token, address account) external returns (int64 responseCode, bool frozen);

    function isKyc(address token, address account) external returns (int64 responseCode, bool kycGranted);

    function associateToken(address account, address token) external returns (int64 responseCode);
}
