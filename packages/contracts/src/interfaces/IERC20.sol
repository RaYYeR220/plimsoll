// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/**
 * @notice Minimal ERC-20 surface for the cash leg.
 * @dev On Hedera the cash token is a native HTS token reached through its ERC-20 facade, so this
 *      interface describes an EVM view of something the network enforces natively.
 */
interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);

    function transferFrom(address from, address to, uint256 amount) external returns (bool);

    function approve(address spender, uint256 amount) external returns (bool);

    function balanceOf(address account) external view returns (uint256);

    function allowance(address owner, address spender) external view returns (uint256);

    function decimals() external view returns (uint8);
}
