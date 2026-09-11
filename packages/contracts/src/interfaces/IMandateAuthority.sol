// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/**
 * @title IMandateAuthority
 * @notice The seam between the on-chain rules and the humans allowed to change them.
 * @dev Implemented outside this package (packages/authority). Every privileged mutation in
 *      Plimsoll routes through `requireMandate` and holds no owner or admin role of its own, so
 *      the set of people who can move a load line is exactly the set the authority recognises.
 *
 *      Deliberately non-`view`: a mandate is expected to be single-use, so the implementation
 *      needs to burn a nonce. The cost of that choice is that no `view` function in this package
 *      can check a mandate — every mandate-gated entry point is a transaction.
 */
interface IMandateAuthority {
    /**
     * @notice Reverts unless `proof` authorises `action` over `subject` for `msg.sender`.
     * @param action  Domain-separated identifier of the operation being attempted.
     * @param subject The thing being acted on, usually a note id.
     * @param proof   Opaque authorisation material; its shape belongs to the implementation.
     */
    function requireMandate(bytes32 action, bytes32 subject, bytes calldata proof) external;
}
