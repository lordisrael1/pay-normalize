import { z } from "zod";
import {
  asKobo,
  composeDedupeKey,
  MalformedPayloadError,
  AmountParseError,
  parseNairaDecimalString,
  validateTransaction,
  type ParseResult,
} from "@pay-normalize/core";
import { mapNombaType, mapRecordStatus } from "./mapping";
import { PROVIDER } from "./parse-webhook";

/**
 * Nomba TRANSACTION RECORDS — the objects returned by Nomba's transaction
 * list/lookup APIs (data.results[]). Not webhooks: richer, and the shape the
 * recon side of the world actually consumes. The HOST fetches these (its API
 * call, its credentials — NOT_DOING.md bans polling from this library); this
 * function normalizes what the host fetched. Fixture provenance: sanitized
 * REAL records from Owoore production traffic — the corpus's first prod.*.
 *
 * Money model, from observed records (this is the part that makes payouts
 * reconcile correctly):
 *
 *   amount       "100.0"  = principal (what the recipient receives)
 *   fixedCharge  "20.0"   = Nomba's fee, charged ON TOP
 *   amountCharged "120.0" = amount + fixedCharge = total wallet debit
 *
 * Mapped so the schema invariant carries real meaning in both directions:
 *   amountInKobo = amountCharged when present (total money movement)
 *   feeInKobo    = fixedCharge
 *   netAmountInKobo = amount - i.e. the principal that reached the other side
 *
 * For DEBIT records: wallet impact = amountInKobo, recipient got net. ✔
 * For CREDIT records: gross in = amountInKobo, merchant kept net. ✔
 *
 * All three money fields are naira-decimal STRINGS ("100.0") — a fourth
 * amount convention (Paystack kobo-int, OPay kobo-string, Nomba-webhook
 * naira-number, Nomba-record naira-string). One provider, two conventions.
 * This is the connector-catalog moat in a single comment.
 */

const RecordSchema = z
  .object({
    id: z.string().min(1),
    status: z.string().min(1),
    amount: z.union([z.string(), z.number()]),
    fixedCharge: z.union([z.string(), z.number()]).nullish(),
    amountCharged: z.union([z.string(), z.number()]).nullish(),
    type: z.unknown(),
    entryType: z.string().nullish(), // "DEBIT" | "CREDIT"
    timeCreated: z.string().nullish(),
    timeUpdated: z.string().nullish(),
    timeCompleted: z.string().nullish(),
    walletCurrency: z.string().nullish(),
    currency: z.string().nullish(),
    merchantTxRef: z.string().nullish(), // host-side ref (Owoore's payout_<uuid>) — preserved in raw
    rrn: z.string().nullish(),
    sessionId: z.string().nullish(),
  })
  .passthrough();

export function parseNombaTransactionRecord(record: unknown): ParseResult {
  const parsed = RecordSchema.safeParse(record);
  if (!parsed.success) {
    return {
      kind: "parse_error",
      provider: PROVIDER,
      error: new MalformedPayloadError(
        `transaction record malformed: ${parsed.error.issues[0]?.message ?? ""} at ${parsed.error.issues[0]?.path.join(".") ?? "?"}`,
        record
      ),
      raw: record,
    };
  }
  const r = parsed.data;

  try {
    const status = mapRecordStatus(r.status);
    if (!status) {
      return {
        kind: "parse_error",
        provider: PROVIDER,
        error: new MalformedPayloadError(`unmapped record status: ${r.status}`, record),
        raw: record,
      };
    }

    const principal = parseNairaDecimalString(r.amount);
    const feeInKobo =
      r.fixedCharge != null && r.fixedCharge !== ""
        ? parseNairaDecimalString(r.fixedCharge)
        : asKobo(0);
    const amountInKobo =
      r.amountCharged != null && r.amountCharged !== ""
        ? parseNairaDecimalString(r.amountCharged)
        : asKobo(principal + feeInKobo);

    // Consistency check, not inference: if all three are present they must agree.
    if (amountInKobo !== principal + feeInKobo) {
      return {
        kind: "parse_error",
        provider: PROVIDER,
        error: new AmountParseError(
          `record money fields disagree: amountCharged(${amountInKobo}) != amount(${principal}) + fixedCharge(${feeInKobo}) — refusing to guess which is authoritative`,
          record
        ),
        raw: record,
      };
    }

    const direction =
      r.entryType?.toUpperCase() === "DEBIT"
        ? ("debit" as const)
        : r.entryType?.toUpperCase() === "CREDIT"
          ? ("credit" as const)
          : ("credit" as const); // absent entryType observed only on credit-side lookups; raw preserved

    const ts = firstTimestamp([r.timeCompleted, r.timeUpdated, r.timeCreated]);
    if (!ts) {
      return {
        kind: "parse_error",
        provider: PROVIDER,
        error: new MalformedPayloadError("record has no parseable time* field", record),
        raw: record,
      };
    }

    const transaction = validateTransaction({
      // Same identity space as webhooks: record.id IS the webhook's transactionId,
      // so a record-sourced row reconciles/upserts against its webhook-sourced twin.
      dedupeKey: composeDedupeKey(PROVIDER, `transaction:${r.id}`),
      provider: PROVIDER,
      providerReference: r.id,
      amountInKobo,
      feeInKobo,
      netAmountInKobo: principal,
      currency: (r.walletCurrency ?? r.currency ?? "NGN").toUpperCase(),
      status,
      channel: mapNombaType(r.type),
      direction,
      occurredAt: ts.date,
      occurredAtRaw: ts.raw,
      settlementDate: null,
      rawProviderPayload: record,
    });
    return { kind: "transaction", transaction };
  } catch (e) {
    if (e instanceof MalformedPayloadError || e instanceof AmountParseError) {
      return { kind: "parse_error", provider: PROVIDER, error: e, raw: record };
    }
    return {
      kind: "parse_error",
      provider: PROVIDER,
      error: new MalformedPayloadError(
        e instanceof Error ? e.message : "unexpected record parse failure",
        record
      ),
      raw: record,
    };
  }
}

function firstTimestamp(
  candidates: Array<string | null | undefined>
): { date: Date; raw: string } | undefined {
  for (const c of candidates) {
    if (!c) continue;
    const parsed = new Date(c);
    if (!Number.isNaN(parsed.getTime())) return { date: parsed, raw: c };
  }
  return undefined;
}
