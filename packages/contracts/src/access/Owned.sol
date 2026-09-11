// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/**
 * @title Owned
 * @notice Two-step ownership for deployment-time administration.
 *
 * @dev Deliberately separate from the mandate path, and deliberately narrower than it sounds.
 *      The device mandate governs the load line - halting a market, resuming it, moving the
 *      threshold - because those are the decisions a human needs to read and approve. Wiring an
 *      oracle address or registering a note is deployment administration: it takes an address or
 *      a hash as its argument, and putting raw hex on a four-line device screen would produce a
 *      mandate nobody actually reads. So it is owner-gated, and the README says so rather than
 *      implying the device covers more than it does.
 *
 *      Transfer is two-step because a single-step transfer to a mistyped address is unrecoverable
 *      and would strand every administrative function in the system.
 */
abstract contract Owned {
    address public owner;
    address public pendingOwner;

    error NotOwner(address caller);
    error NotPendingOwner(address caller);
    error ZeroOwner();

    event OwnershipTransferStarted(address indexed from, address indexed to);
    event OwnershipTransferred(address indexed from, address indexed to);

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner(msg.sender);
        _;
    }

    constructor(address owner_) {
        if (owner_ == address(0)) revert ZeroOwner();
        owner = owner_;
        emit OwnershipTransferred(address(0), owner_);
    }

    function transferOwnership(address to) external onlyOwner {
        if (to == address(0)) revert ZeroOwner();
        pendingOwner = to;
        emit OwnershipTransferStarted(owner, to);
    }

    function acceptOwnership() external {
        if (msg.sender != pendingOwner) revert NotPendingOwner(msg.sender);
        emit OwnershipTransferred(owner, pendingOwner);
        owner = pendingOwner;
        pendingOwner = address(0);
    }
}
