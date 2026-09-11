// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/**
 * @title Ecdsa
 * @notice Minimal signature recovery with the two checks `ecrecover` does not do for you.
 * @dev Rolled by hand rather than pulled from a library because the attestation path is the whole
 *      trust boundary of this protocol and it is worth being able to read every branch of it.
 */
library Ecdsa {
    error MalformedSignature();

    /// @dev secp256k1n / 2. Signatures with `s` above this are the mirror of a valid one (EIP-2).
    bytes32 private constant HALF_ORDER = 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0;

    /**
     * @notice Recovers the signer of `digest`, or `address(0)` if the signature is unusable.
     * @dev Returns zero rather than reverting on a failed recovery so callers can turn it into
     *      their own domain error. Reverts only on a structurally malformed signature, which is a
     *      caller bug rather than a rejected attestation.
     */
    function recover(bytes32 digest, bytes memory signature) internal pure returns (address) {
        if (signature.length != 65) revert MalformedSignature();

        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := mload(add(signature, 0x20))
            s := mload(add(signature, 0x40))
            v := byte(0, mload(add(signature, 0x60)))
        }

        // Reject the malleable twin so a relayer cannot resubmit the same attestation under a
        // different signature and pass a naive replay filter keyed on the signature bytes.
        if (uint256(s) > uint256(HALF_ORDER)) return address(0);
        if (v != 27 && v != 28) return address(0);

        return ecrecover(digest, v, r, s);
    }
}
