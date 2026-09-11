// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title MandateVerifier
/// @notice The on-chain half of the Plimsoll authority. Halting a market, resuming it and moving
///         the load line are all gated on an EIP-191 personal-sign mandate produced by a Ledger,
///         which means gated on a human having pressed the button on a physical device.
/// @dev    This contract does not parse the mandate. It *formats* it, byte for byte, from typed
///         arguments and from state only it controls (`block.chainid`, `address(this)`), then
///         recovers over that. A caller therefore cannot show the device one string and hand the
///         chain another: the only string that verifies is the one this contract would have
///         written itself. `mandateText` is the single Solidity mirror of `formatMandate` in
///         `packages/authority/src/mandate.ts`; they are held together by tests that sign with a
///         real device and settle here.
contract MandateVerifier {
    enum Action {
        HALT,
        RESUME,
        SET_THRESHOLD
    }

    struct Mandate {
        Action action;
        /// @dev Uppercase alphanumeric with single interior hyphens, 1..24 characters.
        string market;
        /// @dev Measured coverage, basis points of par.
        uint32 coverageBps;
        /// @dev The load line in force after this mandate executes, basis points of par.
        uint32 loadLineBps;
        uint64 nonce;
        /// @dev Unix seconds, UTC.
        uint64 expiry;
    }

    struct MarketState {
        bool listed;
        bool halted;
        uint32 loadLineBps;
    }

    error InvalidAttestation();
    error MandateExpired(uint64 expiry, uint64 timestamp);
    error NonceUsed(uint64 nonce);
    error WrongAuthority(address recovered, address expected);
    error WrongAction(Action given, Action expected);
    error BadMarketCode();
    error UnknownMarket(bytes32 marketKey);
    error LoadLineMoved(uint32 stated, uint32 inForce);
    error CoverageBelowLine(uint32 coverageBps, uint32 loadLineBps);
    error MarketAlreadyHalted();
    error MarketNotHalted();
    error ValueOutOfRange();
    error NoAuthority();
    error NotGatekeeper(address caller);

    event MarketHalted(
        bytes32 indexed marketKey, string market, uint32 coverageBps, uint32 loadLineBps, uint64 nonce
    );
    event MarketResumed(
        bytes32 indexed marketKey, string market, uint32 coverageBps, uint32 loadLineBps, uint64 nonce
    );
    event CoverageThresholdSet(
        bytes32 indexed marketKey, string market, uint32 previousBps, uint32 loadLineBps, uint64 nonce
    );

    /// @notice The only key whose approval counts. Immutable: there is no path that escalates it.
    address public immutable authority;

    /// @notice The only contract allowed to execute a mandate: whoever deployed this verifier.
    /// @dev    Taken from `msg.sender` at construction rather than set afterwards, because a setter
    ///         left open between two transactions is itself something to race. In Plimsoll the
    ///         deployer is MandateVerifierAdapter, which accepts calls only from LoadLine, so the one
    ///         path that can consume a mandate is the one that also moves the load line, in the same
    ///         transaction. Without it, a signed mandate lifted in flight could be spent here
    ///         directly: its nonce burns, the market's own copy of the halt never changes, and the
    ///         legitimate submission reverts. The human halts; the market keeps trading.
    address public immutable gatekeeper;

    /// @notice Nonces are single-use across every market and every action.
    mapping(uint64 => bool) public nonceUsed;

    mapping(bytes32 => MarketState) private _markets;

    /// @dev Matches MIN_EXPIRY/MAX_EXPIRY in mandate.ts. Bounds the date formatter below and
    ///      keeps a nonsense far-future expiry from ever rendering on a device.
    uint64 private constant MIN_EXPIRY = 1_704_067_200; // 2024-01-01T00:00:00Z
    uint64 private constant MAX_EXPIRY = 4_133_980_799; // 2100-12-31T23:59:59Z

    uint32 private constant MAX_BPS = 99_999; // 999.99%
    uint256 private constant MAX_MARKET_LEN = 24;

    /// @dev secp256k1n / 2. Signatures in the upper half are rejected rather than normalised.
    uint256 private constant HALF_CURVE_ORDER =
        0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0;

    constructor(address authority_) {
        if (authority_ == address(0)) revert NoAuthority();
        authority = authority_;
        gatekeeper = msg.sender;
    }

    // --- privileged entrypoints -------------------------------------------------------------

    /// @notice Stop the market. Coupons stop settling; secondary transfers stop clearing.
    /// @dev `loadLineBps` must equal the line currently in force, so a halt approved against one
    ///      threshold cannot execute after somebody moved that threshold underneath it.
    function haltMarket(Mandate calldata mandate, bytes calldata signature) external {
        bytes32 key = _consume(mandate, Action.HALT, signature);
        MarketState storage state = _markets[key];
        if (!state.listed) revert UnknownMarket(key);
        if (state.halted) revert MarketAlreadyHalted();
        if (mandate.loadLineBps != state.loadLineBps) revert LoadLineMoved(mandate.loadLineBps, state.loadLineBps);

        state.halted = true;
        emit MarketHalted(key, mandate.market, mandate.coverageBps, mandate.loadLineBps, mandate.nonce);
    }

    /// @notice Restart the market.
    /// @dev A resume whose own numbers say the ship is still overloaded is refused even with a
    ///      valid signature. The human can approve a mistake; they cannot approve a contradiction.
    function resumeMarket(Mandate calldata mandate, bytes calldata signature) external {
        bytes32 key = _consume(mandate, Action.RESUME, signature);
        MarketState storage state = _markets[key];
        if (!state.listed) revert UnknownMarket(key);
        if (!state.halted) revert MarketNotHalted();
        if (mandate.loadLineBps != state.loadLineBps) revert LoadLineMoved(mandate.loadLineBps, state.loadLineBps);
        if (mandate.coverageBps < mandate.loadLineBps) {
            revert CoverageBelowLine(mandate.coverageBps, mandate.loadLineBps);
        }

        state.halted = false;
        emit MarketResumed(key, mandate.market, mandate.coverageBps, mandate.loadLineBps, mandate.nonce);
    }

    /// @notice Move the load line itself, and list the market on first use.
    function setCoverageThreshold(Mandate calldata mandate, bytes calldata signature) external {
        bytes32 key = _consume(mandate, Action.SET_THRESHOLD, signature);
        MarketState storage state = _markets[key];
        uint32 previous = state.loadLineBps;

        state.listed = true;
        state.loadLineBps = mandate.loadLineBps;
        emit CoverageThresholdSet(key, mandate.market, previous, mandate.loadLineBps, mandate.nonce);
    }

    // --- views ------------------------------------------------------------------------------

    function marketKey(string calldata market) external pure returns (bytes32) {
        _requireMarketCode(market);
        return keccak256(bytes(market));
    }

    function marketState(string calldata market) external view returns (MarketState memory) {
        return _markets[keccak256(bytes(market))];
    }

    function isHalted(string calldata market) external view returns (bool) {
        return _markets[keccak256(bytes(market))].halted;
    }

    /// @notice The exact bytes a Ledger must display for this mandate to be executable here.
    function mandateText(Mandate calldata mandate) public view returns (string memory) {
        _requireMarketCode(mandate.market);
        return string(
            abi.encodePacked(
                "PLIMSOLL MANDATE v1\n",
                "ACTION: ",
                _actionName(mandate.action),
                "\nMARKET: ",
                mandate.market,
                "\nCOVERAGE: ",
                _percent(mandate.coverageBps),
                "\nLOAD LINE: ",
                _percent(mandate.loadLineBps),
                "\nNONCE: ",
                _decimal(mandate.nonce),
                "\nEXPIRES: ",
                _timestamp(mandate.expiry),
                "\nCHAIN: ",
                _decimal(block.chainid),
                "\nVERIFIER: ",
                _hexAddress(address(this))
            )
        );
    }

    /// @notice EIP-191 personal-sign digest of `mandateText`.
    function mandateDigest(Mandate calldata mandate) public view returns (bytes32) {
        bytes memory text = bytes(mandateText(mandate));
        return keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n", _decimal(text.length), text));
    }

    // --- internals --------------------------------------------------------------------------

    function _consume(Mandate calldata mandate, Action expected, bytes calldata signature)
        private
        returns (bytes32 key)
    {
        // Before anything else: a valid signature presented through the wrong door is refused
        // without touching the nonce, so the approval survives to be used through the right one.
        if (msg.sender != gatekeeper) revert NotGatekeeper(msg.sender);
        if (mandate.action != expected) revert WrongAction(mandate.action, expected);
        // The expiry is a wall-clock deadline the human read off the device. block.timestamp is
        // the only clock available here and a few seconds of validator drift is meaningless
        // against a mandate that lives for minutes or hours.
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp > mandate.expiry) revert MandateExpired(mandate.expiry, uint64(block.timestamp));
        if (nonceUsed[mandate.nonce]) revert NonceUsed(mandate.nonce);

        address recovered = _recover(mandateDigest(mandate), signature);
        if (recovered != authority) revert WrongAuthority(recovered, authority);

        nonceUsed[mandate.nonce] = true;
        key = keccak256(bytes(mandate.market));
    }

    function _recover(bytes32 digest, bytes calldata signature) private pure returns (address) {
        if (signature.length != 65) revert InvalidAttestation();
        bytes32 r = bytes32(signature[0:32]);
        bytes32 s = bytes32(signature[32:64]);
        uint8 v = uint8(signature[64]);
        if (v != 27 && v != 28) revert InvalidAttestation();
        if (uint256(s) > HALF_CURVE_ORDER) revert InvalidAttestation();

        address recovered = ecrecover(digest, v, r, s);
        if (recovered == address(0)) revert InvalidAttestation();
        return recovered;
    }

    function _actionName(Action action) private pure returns (string memory) {
        if (action == Action.HALT) return "HALT";
        if (action == Action.RESUME) return "RESUME";
        return "SET-THRESHOLD";
    }

    /// @dev Enforces `^[A-Z0-9]+(-[A-Z0-9]+)*$`. The device reflows newlines into spaces, so a
    ///      market code carrying a space or a colon would render as extra mandate fields.
    function _requireMarketCode(string calldata market) private pure {
        bytes calldata raw = bytes(market);
        uint256 n = raw.length;
        if (n == 0 || n > MAX_MARKET_LEN) revert BadMarketCode();

        bool previousWasHyphen = true; // rejects a leading hyphen without a special case
        for (uint256 i = 0; i < n; ++i) {
            bytes1 c = raw[i];
            if ((c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x5a)) {
                previousWasHyphen = false;
                continue;
            }
            if (c != 0x2d || previousWasHyphen) revert BadMarketCode();
            previousWasHyphen = true;
        }
        if (previousWasHyphen) revert BadMarketCode();
    }

    /// @dev `9860` renders as `98.60%`. Exactly two decimals, no leading zeros, so the mapping
    ///      from basis points to rendered text is a bijection.
    function _percent(uint32 bps) private pure returns (string memory) {
        if (bps > MAX_BPS) revert ValueOutOfRange();
        return string(abi.encodePacked(_decimal(bps / 100), ".", _pad(bps % 100, 2), "%"));
    }

    function _timestamp(uint64 unixSeconds) private pure returns (string memory) {
        if (unixSeconds < MIN_EXPIRY || unixSeconds > MAX_EXPIRY) revert ValueOutOfRange();
        (uint256 year, uint256 month, uint256 day) = _civilFromDays(unixSeconds / 86_400);
        uint256 secondOfDay = unixSeconds % 86_400;
        return string(
            abi.encodePacked(
                _pad(year, 4),
                "-",
                _pad(month, 2),
                "-",
                _pad(day, 2),
                "T",
                _pad(secondOfDay / 3600, 2),
                ":",
                _pad((secondOfDay / 60) % 60, 2),
                ":",
                _pad(secondOfDay % 60, 2),
                "Z"
            )
        );
    }

    /// @dev Hinnant's civil-from-days, shifted to keep every intermediate unsigned. Valid for the
    ///      whole [MIN_EXPIRY, MAX_EXPIRY] window, which is what `_timestamp` enforces first.
    function _civilFromDays(uint256 daysSinceEpoch)
        private
        pure
        returns (uint256 year, uint256 month, uint256 day)
    {
        uint256 z = daysSinceEpoch + 719_468;
        uint256 era = z / 146_097;
        uint256 dayOfEra = z - era * 146_097; // [0, 146096]
        uint256 yearOfEra = (dayOfEra - dayOfEra / 1460 + dayOfEra / 36_524 - dayOfEra / 146_096) / 365; // [0, 399]
        uint256 dayOfYear = dayOfEra - (365 * yearOfEra + yearOfEra / 4 - yearOfEra / 100); // [0, 365]
        uint256 monthPrime = (5 * dayOfYear + 2) / 153; // [0, 11], March-based
        day = dayOfYear - (153 * monthPrime + 2) / 5 + 1;
        month = monthPrime < 10 ? monthPrime + 3 : monthPrime - 9;
        year = yearOfEra + era * 400 + (month <= 2 ? 1 : 0);
    }

    function _decimal(uint256 value) private pure returns (string memory) {
        if (value == 0) return "0";
        uint256 digits;
        for (uint256 v = value; v != 0; v /= 10) {
            ++digits;
        }
        bytes memory out = new bytes(digits);
        for (uint256 i = digits; i > 0; --i) {
            out[i - 1] = bytes1(uint8(48 + (value % 10)));
            value /= 10;
        }
        return string(out);
    }

    function _pad(uint256 value, uint256 width) private pure returns (bytes memory out) {
        out = new bytes(width);
        for (uint256 i = width; i > 0; --i) {
            out[i - 1] = bytes1(uint8(48 + (value % 10)));
            value /= 10;
        }
    }

    function _hexAddress(address account) private pure returns (string memory) {
        // Lowercase, not EIP-55. The checksum exists to catch a human retyping an address; this
        // string is generated on both sides and compared byte for byte, so the checksum would buy
        // nothing and cost bytecode on a chain that enforces EIP-170.
        bytes16 digits = "0123456789abcdef";
        bytes memory out = new bytes(42);
        out[0] = "0";
        out[1] = "x";
        uint160 value = uint160(account);
        for (uint256 i = 0; i < 20; ++i) {
            // forge-lint: disable-next-line(unsafe-typecast)
            uint8 b = uint8(value >> (8 * (19 - i))); // truncation is the point: one byte at a time
            out[2 + i * 2] = digits[b >> 4];
            out[3 + i * 2] = digits[b & 0x0f];
        }
        return string(out);
    }
}
