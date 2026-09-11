// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/**
 * @title Preflight
 * @notice Asks both legs of a trade whether they would settle, without attempting the trade.
 *
 * @dev The point of a pre-flight is that a compliance-enforced venue must never book a match it
 *      cannot settle. A refused transfer discovered inside settlement is a reverted transaction
 *      and a confused counterparty; a refused transfer discovered before booking is a reason code
 *      the UI can show.
 *
 *      The note leg is the authoritative half. ATS exposes a non-reverting eligibility check that
 *      returns an EIP-1066 status byte and a reason code, and this library probes for both shapes
 *      it ships in: the four-value `isAbleToTransferFromByPartition` and the three-value
 *      `canTransferByPartition` actually reachable through the v8.0.0 diamond. Whichever answers,
 *      the reason code is surfaced verbatim - it is an ATS error selector, so the UI can decode
 *      `AccountIsBlocked`, `InvalidKycStatus`, `ComplianceNotAllowed` or `IsPaused` from it
 *      without a translation table on our side.
 *
 *      If neither shape answers, this reports a refusal rather than a pass. A venue that treats
 *      "the compliance check did not respond" as "the compliance check said yes" is worse than a
 *      venue with no compliance check at all, because it looks like it has one.
 *
 *      The cash leg is advisory and says so. Cash is an HTS native token, and its freeze state is
 *      enforced at consensus - a frozen account's transfer fails whatever this library concluded.
 *      Probing 0x167 here does not add enforcement, it makes the refusal legible instead of
 *      arriving as an opaque revert. When the probe cannot run (a non-HTS cash token, a non-Hedera
 *      chain) the freeze check is skipped and the balance and allowance checks still stand.
 */
library Preflight {
    /// @dev Reported when no eligibility check could be reached at all.
    bytes32 internal constant REASON_UNREACHABLE = keccak256("PLIMSOLL_PREFLIGHT_UNREACHABLE");
    bytes32 internal constant REASON_CASH_FROZEN = keccak256("PLIMSOLL_CASH_ACCOUNT_FROZEN");
    bytes32 internal constant REASON_CASH_BALANCE = keccak256("PLIMSOLL_CASH_INSUFFICIENT_BALANCE");
    bytes32 internal constant REASON_CASH_ALLOWANCE = keccak256("PLIMSOLL_CASH_INSUFFICIENT_ALLOWANCE");

    /// @dev EIP-1066 "disallowed / stop".
    bytes1 internal constant EIP1066_DISALLOWED = 0x10;

    address internal constant HTS_PRECOMPILE = address(0x167);

    struct Result {
        bool allowed;
        bytes1 statusCode;
        bytes32 reasonCode;
    }

    /**
     * @notice Would `value` notes move from `from` to `to` on `partition` right now?
     * @dev Never reverts and never propagates a revert from the token.
     */
    function noteLeg(
        address note,
        address from,
        address to,
        bytes32 partition,
        uint256 value
    ) internal view returns (Result memory result) {
        // The four-value form first: when present it carries ABI-encoded details alongside the
        // reason code, which is strictly more information for the same call.
        bytes memory payload = abi.encodeWithSignature(
            "isAbleToTransferFromByPartition(address,address,bytes32,uint256,bytes,bytes)",
            from,
            to,
            partition,
            value,
            "",
            ""
        );
        (bool hit, bytes memory data) = _probe(note, payload);
        if (hit && data.length >= 128) {
            (bool allowed, bytes1 code, bytes32 reason, ) = abi.decode(data, (bool, bytes1, bytes32, bytes));
            return Result(allowed, code, reason);
        }

        payload = abi.encodeWithSignature(
            "canTransferByPartition(address,address,bytes32,uint256,bytes,bytes)",
            from,
            to,
            partition,
            value,
            "",
            ""
        );
        (hit, data) = _probe(note, payload);
        if (hit && data.length >= 96) {
            (bool allowed, bytes1 code, bytes32 reason) = abi.decode(data, (bool, bytes1, bytes32));
            return Result(allowed, code, reason);
        }

        return Result(false, EIP1066_DISALLOWED, REASON_UNREACHABLE);
    }

    /**
     * @notice Would `payer` be able to hand `amount` of `cash` to `spender`'s pull right now?
     * @dev Advisory. Consensus, not this function, is what actually stops a frozen account.
     */
    function cashLeg(
        address cash,
        address payer,
        address spender,
        uint256 amount
    ) internal view returns (Result memory result) {
        (bool hit, bytes memory data) = _probe(
            HTS_PRECOMPILE,
            abi.encodeWithSignature("isFrozen(address,address)", cash, payer)
        );
        if (hit && data.length >= 64) {
            (int64 responseCode, bool frozen) = abi.decode(data, (int64, bool));
            // Only a successful response carries a meaningful flag; anything else is no answer.
            if (responseCode == 22 && frozen) {
                return Result(false, EIP1066_DISALLOWED, REASON_CASH_FROZEN);
            }
        }

        (hit, data) = _probe(cash, abi.encodeWithSignature("balanceOf(address)", payer));
        if (hit && data.length >= 32 && abi.decode(data, (uint256)) < amount) {
            return Result(false, EIP1066_DISALLOWED, REASON_CASH_BALANCE);
        }

        (hit, data) = _probe(cash, abi.encodeWithSignature("allowance(address,address)", payer, spender));
        if (hit && data.length >= 32 && abi.decode(data, (uint256)) < amount) {
            return Result(false, EIP1066_DISALLOWED, REASON_CASH_ALLOWANCE);
        }

        return Result(true, 0x01, bytes32(0));
    }

    /**
     * @dev No `extcodesize` guard here on purpose. Hedera's system contracts report empty code
     *      the way Ethereum precompiles do, so guarding on code size would silently skip every
     *      HTS probe on the one network this is built for. A call into an address with no code
     *      returns success and empty data, which the length checks at every call site already
     *      treat as "no answer".
     */
    function _probe(address target, bytes memory payload) private view returns (bool hit, bytes memory data) {
        // solhint-disable-next-line avoid-low-level-calls
        (hit, data) = target.staticcall(payload);
    }
}
