// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { IMandateAuthority } from "../../src/interfaces/IMandateAuthority.sol";

/**
 * @notice Stands in for the real mandate authority built in packages/authority.
 * @dev Denies by default. A test that wants a privileged action to succeed has to say so, which
 *      keeps "I forgot to gate this" from passing as "the gate allowed it".
 */
contract MockMandateAuthority is IMandateAuthority {
    error MandateRefused(bytes32 action, bytes32 subject, address caller);

    bool public allowAll;
    mapping(bytes32 => bool) private _granted;
    uint256 public callCount;

    function setAllowAll(bool value) external {
        allowAll = value;
    }

    function grant(bytes32 action, bytes32 subject, address caller) external {
        _granted[keccak256(abi.encode(action, subject, caller))] = true;
    }

    function revoke(bytes32 action, bytes32 subject, address caller) external {
        _granted[keccak256(abi.encode(action, subject, caller))] = false;
    }

    function requireMandate(bytes32 action, bytes32 subject, uint256, bytes calldata) external {
        callCount++;
        if (allowAll) return;
        if (!_granted[keccak256(abi.encode(action, subject, msg.sender))]) {
            revert MandateRefused(action, subject, msg.sender);
        }
    }
}

/**
 * @notice An ERC-20 whose transfers consult a freeze registry the way an HTS token consults
 *         consensus.
 * @dev The point of modelling it this way is that {MockHts} and this token share one registry, so
 *      a test can freeze an account through the system-contract path and watch a transfer fail
 *      without the token contract ever being told directly. That is the property the real cash
 *      leg relies on, and testing it against a token that merely checks a local flag would prove
 *      nothing about it.
 */
contract MockCash {
    error Frozen(address account);

    string public constant name = "Mock Cash";
    string public constant symbol = "mCASH";
    uint8 public constant decimals = 6;

    FreezeRegistry public immutable registry;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    constructor(FreezeRegistry registry_) {
        registry = registry_;
    }

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
        totalSupply += amount;
        emit Transfer(address(0), to, amount);
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        _move(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        if (allowed != type(uint256).max) {
            require(allowed >= amount, "allowance");
            allowance[from][msg.sender] = allowed - amount;
        }
        _move(from, to, amount);
        return true;
    }

    function _move(address from, address to, uint256 amount) private {
        // Consensus, not the caller, is what refuses here.
        if (registry.frozen(address(this), from)) revert Frozen(from);
        if (registry.frozen(address(this), to)) revert Frozen(to);
        require(balanceOf[from] >= amount, "balance");
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
    }
}

/// @notice Shared freeze state, so the token and the HTS mock cannot disagree.
contract FreezeRegistry {
    mapping(address => mapping(address => bool)) public frozen;

    function set(address token, address account, bool value) external {
        frozen[token][account] = value;
    }
}

/**
 * @notice Stands in for the HTS system contract at 0x167.
 * @dev Etched over 0x167 in tests. Returns Hedera response codes rather than reverting, exactly
 *      like the real thing, so a test can prove the production code checks them.
 */
contract MockHts {
    int64 private constant SUCCESS = 22;

    FreezeRegistry public registry;
    address public createdToken;
    int64 public nextResponseCode = SUCCESS;

    function setRegistry(FreezeRegistry registry_) external {
        registry = registry_;
    }

    function setCreatedToken(address token) external {
        createdToken = token;
    }

    /// @dev Forces the next state-changing call to report a failure code without reverting.
    function setNextResponseCode(int64 code) external {
        nextResponseCode = code;
    }

    function freezeToken(address token, address account) external returns (int64) {
        if (nextResponseCode != SUCCESS) return _consume();
        registry.set(token, account, true);
        return SUCCESS;
    }

    function unfreezeToken(address token, address account) external returns (int64) {
        if (nextResponseCode != SUCCESS) return _consume();
        registry.set(token, account, false);
        return SUCCESS;
    }

    function isFrozen(address token, address account) external view returns (int64, bool) {
        return (SUCCESS, registry.frozen(token, account));
    }

    function isKyc(address, address) external pure returns (int64, bool) {
        return (SUCCESS, true);
    }

    function associateToken(address, address) external pure returns (int64) {
        return SUCCESS;
    }

    /// @dev Signature-compatible with the real `createFungibleToken`; the struct is ignored.
    // solhint-disable-next-line no-complex-fallback
    fallback(bytes calldata data) external payable returns (bytes memory) {
        bytes4 selector = bytes4(data[:4]);
        if (selector == 0x0fb65bf3) {
            if (nextResponseCode != SUCCESS) return abi.encode(_consume(), address(0));
            return abi.encode(SUCCESS, createdToken);
        }
        if (selector == 0xe0f4059a) {
            // mintToken(address,int64,bytes[]) -> (int64, int64, int64[])
            if (nextResponseCode != SUCCESS) return abi.encode(_consume(), int64(0), new int64[](0));
            return abi.encode(SUCCESS, int64(1_000_000), new int64[](0));
        }
        revert("MockHts: unknown selector");
    }

    receive() external payable {}

    function _consume() private returns (int64 code) {
        code = nextResponseCode;
        nextResponseCode = SUCCESS;
    }
}

/**
 * @notice Stands in for the HIP-1215 schedule service at 0x16b.
 * @dev Records what was booked instead of executing it, so a test drives the coupon loop
 *      deliberately, one wake-up at a time, and can assert on the exact `expirySecond` the
 *      scheduler asked for. Also able to report a non-22 response code without reverting, which
 *      is the failure the production code has to notice on its own.
 */
contract MockScheduleService {
    int64 private constant SUCCESS = 22;

    struct Booking {
        address to;
        uint256 expirySecond;
        uint256 gasLimit;
        bytes callData;
        bool executed;
    }

    Booking[] public bookings;
    int64 public nextResponseCode = SUCCESS;
    bool public capacity = true;
    uint256 public scheduleCallCount;

    function setNextResponseCode(int64 code) external {
        nextResponseCode = code;
    }

    function setCapacity(bool value) external {
        capacity = value;
    }

    function hasScheduleCapacity(uint256, uint256) external view returns (bool) {
        return capacity;
    }

    function scheduleCall(
        address to,
        uint256 expirySecond,
        uint256 gasLimit,
        uint64,
        bytes calldata callData
    ) external returns (int64 responseCode, address scheduleAddress) {
        scheduleCallCount++;
        if (nextResponseCode != SUCCESS) {
            responseCode = nextResponseCode;
            nextResponseCode = SUCCESS;
            return (responseCode, address(0));
        }
        bookings.push(
            Booking({ to: to, expirySecond: expirySecond, gasLimit: gasLimit, callData: callData, executed: false })
        );
        return (SUCCESS, address(uint160(0xBEEF0000 + bookings.length)));
    }

    function bookingCount() external view returns (uint256) {
        return bookings.length;
    }

    function lastBooking() external view returns (Booking memory) {
        return bookings[bookings.length - 1];
    }

    /// @notice Fires a booked call, as the ledger would at its expiry second.
    function fire(uint256 index) external returns (bool ok, bytes memory ret) {
        Booking storage b = bookings[index];
        require(!b.executed, "already fired");
        b.executed = true;
        // solhint-disable-next-line avoid-low-level-calls
        (ok, ret) = b.to.call(b.callData);
    }
}
