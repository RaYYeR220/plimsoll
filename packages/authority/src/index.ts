/**
 * Public surface of the Plimsoll authority.
 *
 * `src/screen.ts` is intentionally absent: it drives the Speculos emulator's buttons and has no
 * business anywhere near a caller that is about to halt a market.
 */

export {
  MANDATE_ACTIONS,
  MANDATE_HEADER,
  MANDATE_KEYS,
  MAX_EXPIRY,
  MIN_EXPIRY,
  MandateFormatError,
  formatBasisPoints,
  formatExpiry,
  formatMandate,
  hashMandate,
  hashMandateText,
  isExpired,
  normalizeAddress,
  packSignature,
  parseBasisPoints,
  parseExpiry,
  parseMandate,
  recoverMandateSigner,
  type Mandate,
  type MandateAction,
} from "./mandate";

export {
  DEFAULT_DERIVATION_PATH,
  DEFAULT_TRANSPORT_URL,
  DeviceAuthority,
  SPECULOS_TEST_ADDRESS,
  SW_CONDITIONS_NOT_SATISFIED,
  classifyDeviceError,
  configFromEnv,
  type AddressResult,
  type DeviceAuthorityConfig,
  type LedgerModel,
  type MandateAttestation,
  type RefusalReason,
  type SignResult,
} from "./device";
