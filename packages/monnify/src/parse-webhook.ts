import { z } from "zod";
import {
  asKobo,
  composeDedupeKey,
  MalformedPayloadError,
  AmountParseError,
  parseNairaDecimalString,
  validateTransaction,
  type ParseResult,
  type RawBody,
} from "@pay-normalize/core";
import {
  mapCollectionStatus,
  mapDisbursementStatus,
  mapPaymentMethod,
  parseMonnifyTimestamp,
} from "./mapping";

export const PROVIDER = "monnify";

/**
 * Monnify webhooks: { eventType, eventData }. eventType routes; eventData shape
 * varies per event. Amounts are naira decimals as NUMBERS (`amountPaid: 3000`)
 * or STRINGS (`"1234.00"`, `settlementAmount: "2990.00"`) — parseNairaDecimalString
 * handles both.
 *
 * Money models, per event family:
 *  - Collection (SUCCESSFUL_TRANSACTION): amountPaid is gross in; settlementAmount
 *    is what the merchant receives (net). fee = amountPaid - settlementAmount.
 *  - Disbursement (SUCCESSFUL/FAILED_DISBURSEMENT): `amount` is the principal the
 *    recipient receives; `fee` is charged ON TOP. Total wallet debit = amount + fee.
 *    Modeled amountInKobo = amount + fee, feeInKobo = fee, netAmountInKobo = amount
 *    (same shape as Nomba payouts, so the schema invariant carries real meaning).
 *  - Settlement (SETTLEMENT): one credit into your bank/wallet for a batch of
 *    transactions; carries the first real settlementDate. The batch rides in raw.
 *  - Rejected (REJECTED_PAYMENT): a collection that was refused (e.g. UNDER_PAYMENT);
 *    FAILED credit, amount = what was actually paid.
 *
 * Operational events (MANDATE_UPDATE, ACCOUNT_ACTIVITY, LOW_BALANCE_ALERT) are
 * surfaced as unknown_event — real notifications, but not customer money movement
 * this schema models. Never swallowed.
 */

const EnvelopeSchema = z.object({
  eventType: z.string().min(1),
  eventData: z.record(z.string(), z.unknown()),
});

const COLLECTION_EVENT = "SUCCESSFUL_TRANSACTION";
const SETTLEMENT_EVENT = "SETTLEMENT";
const REJECTED_EVENT = "REJECTED_PAYMENT";
const DISBURSEMENT_EVENTS: Record<string, "SUCCESSFUL" | "FAILED"> = {
  SUCCESSFUL_DISBURSEMENT: "SUCCESSFUL",
  FAILED_DISBURSEMENT: "FAILED",
};

export function transactionDedupeKey(transactionReference: string): string {
  return composeDedupeKey(PROVIDER, `transaction:${transactionReference}`);
}
export function disbursementDedupeKey(transactionReference: string): string {
  return composeDedupeKey(PROVIDER, `disbursement:${transactionReference}`);
}
export function settlementDedupeKey(settlementReference: string): string {
  return composeDedupeKey(PROVIDER, `settlement:${settlementReference}`);
}

export function parseMonnifyWebhook(rawBody: RawBody): ParseResult {
  let json: unknown;
  try {
    json = JSON.parse(rawBody.toString("utf8"));
  } catch {
    return parseError("payload is not valid JSON", rawBody.toString("utf8"));
  }

  const envelope = EnvelopeSchema.safeParse(json);
  if (!envelope.success) {
    return parseError("payload missing { eventType, eventData } envelope", json);
  }
  const { eventType, eventData } = envelope.data;

  try {
    if (eventType === COLLECTION_EVENT) return parseCollection(eventData, json);
    if (eventType in DISBURSEMENT_EVENTS) {
      return parseDisbursement(DISBURSEMENT_EVENTS[eventType]!, eventData, json);
    }
    if (eventType === SETTLEMENT_EVENT) return parseSettlement(eventData, json);
    if (eventType === REJECTED_EVENT) return parseRejected(eventData, json);
    // MANDATE_UPDATE, ACCOUNT_ACTIVITY, LOW_BALANCE_ALERT, future types.
    return { kind: "unknown_event", provider: PROVIDER, eventType, raw: json };
  } catch (e) {
    if (e instanceof MalformedPayloadError || e instanceof AmountParseError) {
      return { kind: "parse_error", provider: PROVIDER, error: e, raw: json };
    }
    return parseError(e instanceof Error ? e.message : "unexpected parse failure", json);
  }
}

const CollectionSchema = z
  .object({
    transactionReference: z.string().min(1),
    amountPaid: z.union([z.number(), z.string()]),
    settlementAmount: z.union([z.number(), z.string()]).nullish(),
    paymentStatus: z.unknown(),
    paymentMethod: z.unknown(),
    currency: z.string().min(1).nullish(),
    paidOn: z.string().nullish(),
  })
  .passthrough();

function parseCollection(data: Record<string, unknown>, raw: unknown): ParseResult {
  const d = CollectionSchema.safeParse(data);
  if (!d.success) {
    return parseError(`${COLLECTION_EVENT} data malformed: ${issue(d)}`, raw);
  }
  const status = mapCollectionStatus(d.data.paymentStatus);
  if (!status) return parseError(`unmapped paymentStatus: ${String(d.data.paymentStatus)}`, raw);

  const amountInKobo = parseNairaDecimalString(d.data.amountPaid);
  const netAmountInKobo =
    d.data.settlementAmount != null && d.data.settlementAmount !== ""
      ? parseNairaDecimalString(d.data.settlementAmount)
      : amountInKobo;
  // fee = gross - net. asKobo refuses a negative (settlement > amountPaid), which
  // is an inconsistent payload -> parse_error, not a silent wrong number.
  const feeInKobo = asKobo(amountInKobo - netAmountInKobo);

  const occurred = parseMonnifyTimestamp(d.data.paidOn);
  if (!occurred) return parseError(`${COLLECTION_EVENT} has unparseable paidOn`, raw);

  const transaction = validateTransaction({
    dedupeKey: transactionDedupeKey(d.data.transactionReference),
    provider: PROVIDER,
    providerReference: d.data.transactionReference,
    amountInKobo,
    feeInKobo,
    netAmountInKobo,
    currency: (d.data.currency ?? "NGN").toUpperCase(),
    status,
    channel: mapPaymentMethod(d.data.paymentMethod),
    direction: "credit",
    occurredAt: occurred.date,
    occurredAtRaw: occurred.raw,
    settlementDate: null,
    rawProviderPayload: raw,
  });
  return { kind: "transaction", transaction };
}

const DisbursementSchema = z
  .object({
    transactionReference: z.string().min(1),
    amount: z.union([z.number(), z.string()]),
    fee: z.union([z.number(), z.string()]).nullish(),
    status: z.unknown(),
    currency: z.string().min(1).nullish(),
    createdOn: z.string().nullish(),
    completedOn: z.string().nullish(),
  })
  .passthrough();

function parseDisbursement(
  eventStatus: "SUCCESSFUL" | "FAILED",
  data: Record<string, unknown>,
  raw: unknown
): ParseResult {
  const d = DisbursementSchema.safeParse(data);
  if (!d.success) {
    return parseError(`disbursement data malformed: ${issue(d)}`, raw);
  }
  // The event name is authoritative for status; the field is cross-checked so a
  // contradiction surfaces rather than being trusted blindly.
  const fieldStatus = mapDisbursementStatus(d.data.status);
  if (fieldStatus && fieldStatus !== eventStatus) {
    return parseError(
      `disbursement status field (${String(d.data.status)}) contradicts event (${eventStatus})`,
      raw
    );
  }

  const principal = parseNairaDecimalString(d.data.amount);
  const feeInKobo =
    d.data.fee != null && d.data.fee !== "" ? parseNairaDecimalString(d.data.fee) : asKobo(0);
  const amountInKobo = asKobo(principal + feeInKobo); // total wallet debit

  const occurred = parseMonnifyTimestamp(d.data.completedOn) ?? parseMonnifyTimestamp(d.data.createdOn);
  if (!occurred) return parseError("disbursement has no parseable createdOn/completedOn", raw);

  const transaction = validateTransaction({
    dedupeKey: disbursementDedupeKey(d.data.transactionReference),
    provider: PROVIDER,
    providerReference: d.data.transactionReference,
    amountInKobo,
    feeInKobo,
    netAmountInKobo: principal,
    currency: (d.data.currency ?? "NGN").toUpperCase(),
    status: eventStatus,
    channel: "bank_transfer", // disbursements go to a bank account
    direction: "debit",
    occurredAt: occurred.date,
    occurredAtRaw: occurred.raw,
    settlementDate: null,
    rawProviderPayload: raw,
  });
  return { kind: "transaction", transaction };
}

const SettlementSchema = z
  .object({
    settlementReference: z.string().min(1),
    amount: z.union([z.number(), z.string()]),
    settlementTime: z.string().nullish(),
    currency: z.string().min(1).nullish(),
  })
  .passthrough();

function parseSettlement(data: Record<string, unknown>, raw: unknown): ParseResult {
  const d = SettlementSchema.safeParse(data);
  if (!d.success) {
    return parseError(`${SETTLEMENT_EVENT} data malformed: ${issue(d)}`, raw);
  }
  const amountInKobo = parseNairaDecimalString(d.data.amount);
  const occurred = parseMonnifyTimestamp(d.data.settlementTime);
  if (!occurred) return parseError(`${SETTLEMENT_EVENT} has unparseable settlementTime`, raw);

  const transaction = validateTransaction({
    dedupeKey: settlementDedupeKey(d.data.settlementReference),
    provider: PROVIDER,
    providerReference: d.data.settlementReference,
    amountInKobo,
    feeInKobo: asKobo(0), // per-transaction fees already applied; settlement is net movement
    netAmountInKobo: amountInKobo,
    currency: (d.data.currency ?? "NGN").toUpperCase(),
    status: "SUCCESSFUL",
    channel: "unknown", // a settlement batch spans payment methods
    direction: "credit",
    occurredAt: occurred.date,
    occurredAtRaw: occurred.raw,
    settlementDate: occurred.date, // finally, a real settlement date
    rawProviderPayload: raw,
  });
  return { kind: "transaction", transaction };
}

const RejectedSchema = z
  .object({
    transactionReference: z.string().min(1),
    paymentSourceInformation: z
      .object({ amountPaid: z.union([z.number(), z.string()]).nullish() })
      .passthrough()
      .nullish(),
    currency: z.string().min(1).nullish(),
    created_on: z.string().nullish(),
  })
  .passthrough();

function parseRejected(data: Record<string, unknown>, raw: unknown): ParseResult {
  const d = RejectedSchema.safeParse(data);
  const paid = d.success ? d.data.paymentSourceInformation?.amountPaid : undefined;
  if (!d.success || paid == null || paid === "") {
    return parseError(`${REJECTED_EVENT} missing paymentSourceInformation.amountPaid`, raw);
  }
  const amountInKobo = parseNairaDecimalString(paid);
  const occurred = parseMonnifyTimestamp(d.data.created_on);
  if (!occurred) return parseError(`${REJECTED_EVENT} has unparseable created_on`, raw);

  const transaction = validateTransaction({
    dedupeKey: transactionDedupeKey(d.data.transactionReference),
    provider: PROVIDER,
    providerReference: d.data.transactionReference,
    amountInKobo,
    feeInKobo: asKobo(0),
    netAmountInKobo: amountInKobo,
    currency: (d.data.currency ?? "NGN").toUpperCase(),
    status: "FAILED", // rejected = value not given
    channel: "unknown",
    direction: "credit",
    occurredAt: occurred.date,
    occurredAtRaw: occurred.raw,
    settlementDate: null,
    rawProviderPayload: raw,
  });
  return { kind: "transaction", transaction };
}

function issue(r: { error: z.ZodError }): string {
  const i = r.error.issues[0];
  return `${i?.message ?? ""} at ${i?.path.join(".") ?? "?"}`;
}

function parseError(message: string, raw: unknown): ParseResult {
  return {
    kind: "parse_error",
    provider: PROVIDER,
    error: new MalformedPayloadError(message, raw),
    raw,
  };
}
