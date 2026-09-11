// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/**
 * @title IMandateAuthority
 * @notice The seam between the on-chain rules and the humans allowed to change them.
 * @dev Every load-line change in Plimsoll routes through `requireMandate`, and the contract that
 *      changes the line holds no authority of its own, so the set of people who can move a load
 *      line is exactly the set this authority recognises.
 *
 *      Deliberately non-`view`: a mandate is single-use, so the implementation burns a nonce. The
 *      cost is that no `view` function can check a mandate - every gated entry point is a
 *      transaction.
 */
interface IMandateAuthority {
    /**
     * @notice Reverts unless `proof` authorises `action` over `subject` - and, where the action
     *         writes a number, authorises exactly `value`.
     * @dev    `value` exists because approving an action is not the same as approving what it
     *         writes. A human who read "LOAD LINE: 95.00%" on a device has approved 95.00%, not
     *         "some new line". The caller passes the number it is about to write, and the
     *         authority must revert unless the mandate names that same number, before anything
     *         is written. Actions that write no number pass zero.
     * @param action  Domain-separated identifier of the operation being attempted.
     * @param subject The thing being acted on, usually a note id.
     * @param value   The number the caller will write if this returns, or zero.
     * @param proof   Opaque authorisation material; its shape belongs to the implementation.
     */
    function requireMandate(bytes32 action, bytes32 subject, uint256 value, bytes calldata proof) external;
}
