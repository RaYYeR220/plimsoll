// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { Coverage } from "./libraries/Coverage.sol";
import { HederaResponse } from "./libraries/HederaResponse.sol";
import { ILoadLine } from "./interfaces/IPlimsoll.sol";
import { Owned } from "./access/Owned.sol";
import { IHederaTokenService } from "./interfaces/IHederaTokenService.sol";

/**
 * @title CashLegController
 * @notice Creates the cash token and holds its freeze key, so that a coverage breach stops
 *         payment at consensus rather than in our code.
 *
 * @dev Where the line actually falls, since this is the one place in Plimsoll where it matters:
 *
 *      **EVM, this contract.** Creating the token, choosing its keys, deciding *when* to freeze,
 *      and calling 0x167 to do it. All of that is Solidity, all of it is our logic, and all of it
 *      can be wrong or unavailable.
 *
 *      **Native, the network.** The freeze flag itself. Once an account is frozen for this token,
 *      Hedera rejects every transfer of it by that account - a CryptoTransfer signed by the
 *      account's own key, an ERC-20 `transferFrom` through the token's facade, a HIP-1215
 *      scheduled call, a contract with an allowance. No contract is consulted; consensus refuses.
 *      That is the property worth building on: with our attestor offline, our scheduler dead and
 *      this contract never called again, a frozen payer still cannot pay a coupon.
 *
 *      The freeze key is a contract-ID key naming this contract, so the only way to flip it is
 *      through {tripBreaker} and {resetBreaker} - and those are permissionless, because they do
 *      not decide anything. They read {ILoadLine} and make the ledger agree with it. Anyone may
 *      push that button; nobody may choose the answer.
 *
 *      The token is created with **no admin key**, deliberately. An admin key could rotate the
 *      freeze key away and disarm the breaker, which would undo the whole point. The cost is
 *      genuine and permanent: this controller can never be replaced for a token it created, and
 *      the token's memo, expiry and keys can never be changed. If that trade is wrong for a
 *      given deployment, the token has to be created differently - it cannot be fixed later.
 *
 *      What Solidity **cannot** do here, stated plainly rather than faked:
 *      - It cannot associate a third party with the token. Every counterparty must associate
 *        itself (HIP-719 `associate()` on the token address, or an SDK TokenAssociate). A
 *        contract can only associate *itself*, which is what {associateSelf} is for.
 *      - It cannot create the token for free. HTS charges an HBAR fee for `createFungibleToken`,
 *        so {createCashToken} is payable and this contract must be funded.
 *      - It cannot freeze an account that never associated - there is nothing to freeze. An
 *        unassociated payer already cannot receive or send the token, which fails in the same
 *        direction, but {tripBreaker} will report a Hedera response code rather than succeeding.
 */
contract CashLegController is Owned {
    IHederaTokenService public constant HTS = IHederaTokenService(address(0x167));

    /// @dev HTS key-type bit flags.
    uint256 private constant KEY_TYPE_FREEZE = 4;
    uint256 private constant KEY_TYPE_SUPPLY = 16;

    /// @dev 90 days, the usual auto-renew period for an HTS entity.
    int64 private constant AUTO_RENEW_PERIOD = 7776000;


    ILoadLine public immutable loadLine;

    /// @notice The HTS token, as an EVM address. Zero until {createCashToken} succeeds.
    address public cashToken;

    /// @notice The account that funds coupons for a note. This is what the breaker freezes.
    mapping(bytes32 => address) public payerOf;

    error ZeroAddress();
    error CashTokenAlreadyCreated();
    error CashTokenNotCreated();
    error NoPayer(bytes32 noteId);
    error LineIsClear(bytes32 noteId);
    error LineIsNotClear(bytes32 noteId, Coverage.Reason reason);

    event CashTokenCreated(address token, int32 decimals, int64 initialSupply);
    event PayerSet(bytes32 indexed noteId, address previous, address current);
    event BreakerTripped(bytes32 indexed noteId, address payer, Coverage.Reason reason);
    event BreakerReset(bytes32 indexed noteId, address payer);
    event CashMinted(int64 amount, int64 newTotalSupply);

    constructor(ILoadLine loadLine_, address owner_) Owned(owner_) {
        if (address(loadLine_) == address(0)) revert ZeroAddress();
        loadLine = loadLine_;
    }

    /// @dev Needed so the contract can be funded for the HTS create fee and auto-renew.
    receive() external payable {}

    // ---------------------------------------------------------------------------------------
    // Token creation
    // ---------------------------------------------------------------------------------------

    /**
     * @notice Creates the HTS cash token with this contract as treasury and freeze-key holder.
     * @dev `freezeDefault` is false: accounts trade freely until the breaker says otherwise.
     *      Setting it true would freeze every new holder on association and make the venue
     *      permissioned by default, which is a different product.
     */
    function createCashToken(
        string calldata name,
        string calldata symbol,
        string calldata memo,
        int32 decimals,
        int64 initialSupply,
        int64 maxSupply
    ) external payable onlyOwner returns (address token) {
        if (cashToken != address(0)) revert CashTokenAlreadyCreated();

        IHederaTokenService.TokenKey[] memory keys = new IHederaTokenService.TokenKey[](2);
        keys[0] = _contractKey(KEY_TYPE_FREEZE);
        keys[1] = _contractKey(KEY_TYPE_SUPPLY);

        IHederaTokenService.HederaToken memory spec = IHederaTokenService.HederaToken({
            name: name,
            symbol: symbol,
            treasury: address(this),
            memo: memo,
            tokenSupplyType: true,
            maxSupply: maxSupply,
            freezeDefault: false,
            tokenKeys: keys,
            expiry: IHederaTokenService.Expiry({
                second: 0,
                autoRenewAccount: address(this),
                autoRenewPeriod: AUTO_RENEW_PERIOD
            })
        });

        (int64 responseCode, address created) = HTS.createFungibleToken{ value: msg.value }(
            spec,
            initialSupply,
            decimals
        );
        HederaResponse.check(responseCode);

        cashToken = created;
        emit CashTokenCreated(created, decimals, initialSupply);
        return created;
    }

    function mintCash(int64 amount) external onlyOwner returns (int64 newTotalSupply) {
        address token = cashToken;
        if (token == address(0)) revert CashTokenNotCreated();

        // solhint-disable-next-line avoid-low-level-calls
        (bool sent, bytes memory data) = address(HTS).call(
            abi.encodeWithSignature("mintToken(address,int64,bytes[])", token, amount, new bytes[](0))
        );
        if (!sent || data.length < 96) revert HederaResponse.HederaCallFailed(0);

        int64 responseCode;
        (responseCode, newTotalSupply) = abi.decode(data, (int64, int64));
        HederaResponse.check(responseCode);
        emit CashMinted(amount, newTotalSupply);
    }

    /// @notice Associates this contract with an arbitrary token. A contract may only ever
    ///         associate itself; third parties must do their own.
    function associateSelf(address token) external {
        HederaResponse.check(HTS.associateToken(address(this), token));
    }

    // ---------------------------------------------------------------------------------------
    // The circuit breaker
    // ---------------------------------------------------------------------------------------

    /**
     * @notice Freezes a note's payer because its load line is not clear.
     * @dev Permissionless by design. This does not exercise judgement - it copies {ILoadLine}'s
     *      answer onto the ledger. Requiring a mandate to enforce a rule the mandate already set
     *      would only add a way for enforcement to be late.
     */
    function tripBreaker(bytes32 noteId) external {
        address payer = payerOf[noteId];
        if (payer == address(0)) revert NoPayer(noteId);
        address token = cashToken;
        if (token == address(0)) revert CashTokenNotCreated();

        (bool clear, , Coverage.Reason reason, , ) = loadLine.status(noteId);
        if (clear) revert LineIsClear(noteId);

        HederaResponse.check(HTS.freezeToken(token, payer));
        emit BreakerTripped(noteId, payer, reason);
    }

    /// @notice Unfreezes a note's payer once its load line is clear again.
    function resetBreaker(bytes32 noteId) external {
        address payer = payerOf[noteId];
        if (payer == address(0)) revert NoPayer(noteId);
        address token = cashToken;
        if (token == address(0)) revert CashTokenNotCreated();

        (bool clear, , Coverage.Reason reason, , ) = loadLine.status(noteId);
        if (!clear) revert LineIsNotClear(noteId, reason);

        HederaResponse.check(HTS.unfreezeToken(token, payer));
        emit BreakerReset(noteId, payer);
    }

    function setPayer(bytes32 noteId, address payer) external onlyOwner {
        if (payer == address(0)) revert ZeroAddress();
        emit PayerSet(noteId, payerOf[noteId], payer);
        payerOf[noteId] = payer;
    }

    /// @notice Reads the payer's freeze state straight off the ledger.
    function isPayerFrozen(bytes32 noteId) external returns (bool frozen) {
        address payer = payerOf[noteId];
        if (payer == address(0)) revert NoPayer(noteId);
        address token = cashToken;
        if (token == address(0)) revert CashTokenNotCreated();

        int64 responseCode;
        (responseCode, frozen) = HTS.isFrozen(token, payer);
        HederaResponse.check(responseCode);
    }

    function _contractKey(uint256 keyType) private view returns (IHederaTokenService.TokenKey memory) {
        return
            IHederaTokenService.TokenKey({
                keyType: keyType,
                key: IHederaTokenService.KeyValue({
                    inheritAccountKey: false,
                    contractId: address(this),
                    ed25519: "",
                    ECDSA_secp256k1: "",
                    delegatableContractId: address(0)
                })
            });
    }
}
