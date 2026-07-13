/**
 * @scope/core public API. Explicit exports only — anything not listed here is
 * internal and refactorable. Everything listed here is a semver commitment.
 * Keep this file under ~15 exports; growth pressure here is scope creep
 * knocking (see NOT_DOING.md).
 */

// Schema — the contract
export {
  StandardizedTransactionSchema,
  validateTransaction,
  type StandardizedTransaction,
} from "./schema/transaction";
export {
  TransactionStatusSchema,
  STATUS_RANK,
  statusRank,
  shouldApplyStatusTransition,
  type TransactionStatus,
} from "./schema/status";
export { PaymentChannelSchema, type PaymentChannel } from "./schema/channel";

// Money — the only way amounts enter the system
export {
  asKobo,
  parseKoboInteger,
  parseNairaDecimalString,
  koboToNairaString,
  type Kobo,
} from "./schema/money";

// Connector contract
export type { Connector } from "./connector/interface";
export {
  summarizeRows,
  type ParseResult,
  type SettlementFileParseResult,
} from "./connector/result";

// Utilities connectors and hosts share
export { toRawBody, rawBodyFromString, type RawBody } from "./util/raw-body";
export { composeDedupeKey } from "./util/dedupe";

// Errors
export {
  type NormalizationErrorCode,
  NormalizationError,
  SignatureVerificationError,
  MalformedPayloadError,
  AmountParseError,
  UnsupportedFileFormatError,
} from "./errors";
