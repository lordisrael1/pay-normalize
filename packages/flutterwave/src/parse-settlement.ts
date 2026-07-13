import { z } from "zod";
import {
  asKobo,
  composeDedupeKey,
  MalformedPayloadError,
  AmountParseError,
  parseNairaDecimalString,
  summarizeRows,
  validateTransaction,
  type ParseResult,
  type SettlementFileParseResult,
} from "@pay-normalize/core";
import { FlwFeeSchema, mapSettlementStatus, resolveFlwTimestamp, sumFlwFees } from "./mapping";
import { PROVIDER } from "./parse-webhook";

/**
 * Normalize settlement records from GET /settlements (list) or
 * GET /settlements/:id — the records the HOST fetched (its API call).
 *
 * This is the library's FIRST source of a real settlementDate (due_datetime)
 * and the first TYPED fee breakdown:
 *
 *   { "fees": [ { "type": "stamp_duty", "amount": 0 },
 *               { "type": "charge_fee", "amount": 0 } ] }
 *
 * stamp_duty is the Nigerian EMT levy line item — regulatory fees as data.
 * The full typed breakdown is preserved in rawProviderPayload; the schema
 * carries the sum.
 *
 * Money model with a CHECKABLE invariant (like Nomba's records):
 *   amountInKobo    = gross_amount   (what the charges summed to)
 *   feeInKobo       = Σ fees[].amount
 *   netAmountInKobo = net_amount     (what actually lands in bank/wallet)
 * and we REFUSE records where net_amount != gross_amount - Σfees — money
 * fields that disagree are a parse_error, never a guess.
 *
 * MODELING NOTE: a settlement is a BATCH (charge_count can be > 1). It still
 * normalizes cleanly as one credit transaction: it is one money movement into
 * your bank/wallet, with its own provider identity (stm_*). Recon then diffs
 * Σ(charges due on date D) against the settlement row for D — which is
 * exactly the recon primitive. charge_count and the charges[] array (when
 * fetched by id) ride along in raw.
 */

const SettlementSchema = z
  .object({
    id: z.string().min(1),
    gross_amount: z.union([z.number(), z.string()]),
    net_amount: z.union([z.number(), z.string()]),
    currency: z.string().min(1),
    status: z.unknown(),
    fees: z.array(FlwFeeSchema).nullish(),
    // Chargebacks and refunds are deducted from gross BEFORE settlement,
    // alongside fees. Omitting them from the money invariant would falsely
    // reject any settlement carrying one.
    chargeback: z.union([z.number(), z.string()]).nullish(),
    refund: z.union([z.number(), z.string()]).nullish(),
    due_datetime: z.union([z.string(), z.number()]).nullish(),
    transaction_datetime: z.union([z.string(), z.number()]).nullish(),
    created_datetime: z.union([z.string(), z.number()]).nullish(),
    settlement_account: z.string().nullish(),
    destination: z.string().nullish(),
    charge_count: z.union([z.string(), z.number()]).nullish(),
  })
  .passthrough();

export function parseFlutterwaveSettlement(record: unknown): ParseResult {
  const parsed = SettlementSchema.safeParse(record);
  if (!parsed.success) {
    return err(
      `settlement record malformed: ${parsed.error.issues[0]?.message ?? ""} at ${parsed.error.issues[0]?.path.join(".") ?? "?"}`,
      record
    );
  }
  const s = parsed.data;

  try {
    const status = mapSettlementStatus(s.status);
    if (!status) return err(`unmapped settlement status: ${String(s.status)}`, record);

    const gross = parseNairaDecimalString(s.gross_amount);
    const net = parseNairaDecimalString(s.net_amount);
    const feeSum = sumFlwFees(s.fees);
    const chargeback = s.chargeback != null && s.chargeback !== "" ? parseNairaDecimalString(s.chargeback) : 0;
    const refund = s.refund != null && s.refund !== "" ? parseNairaDecimalString(s.refund) : 0;
    // Everything withheld from gross before the merchant is paid.
    const totalDeductions = feeSum + chargeback + refund;

    if (net !== gross - totalDeductions) {
      return {
        kind: "parse_error",
        provider: PROVIDER,
        error: new AmountParseError(
          `settlement money fields disagree: net_amount(${net}) != gross_amount(${gross}) - Σfees(${feeSum}) - chargeback(${chargeback}) - refund(${refund}) — refusing to guess`,
          record
        ),
        raw: record,
      };
    }

    const settlement = resolveFlwTimestamp(s.due_datetime);
    // transaction_datetime is when the underlying transaction was created;
    // prefer it as occurredAt, falling back to created_datetime then the
    // settlement's own due date.
    const occurred =
      resolveFlwTimestamp(s.transaction_datetime) ??
      resolveFlwTimestamp(s.created_datetime) ??
      settlement;
    if (!occurred) return err("settlement has no resolvable datetime", record);

    const transaction = validateTransaction({
      dedupeKey: composeDedupeKey(PROVIDER, `settlement:${s.id}`),
      provider: PROVIDER,
      providerReference: s.id,
      amountInKobo: gross,
      // feeInKobo aggregates ALL pre-settlement deductions (fees + chargebacks +
      // refunds) so the schema invariant net = gross - fee holds; the typed
      // breakdown is preserved verbatim in rawProviderPayload.
      feeInKobo: asKobo(totalDeductions),
      netAmountInKobo: net,
      currency: s.currency.toUpperCase(),
      status,
      channel: "unknown", // a settlement batch spans channels
      direction: "credit",
      occurredAt: occurred.date,
      occurredAtRaw: occurred.raw,
      settlementDate: settlement?.date ?? null, // due_datetime — finally, a real one
      rawProviderPayload: record,
    });
    return { kind: "transaction", transaction };
  } catch (e) {
    if (e instanceof MalformedPayloadError || e instanceof AmountParseError) {
      return { kind: "parse_error", provider: PROVIDER, error: e, raw: record };
    }
    return err(e instanceof Error ? e.message : "unexpected settlement parse failure", record);
  }
}

/**
 * Normalize a full GET /settlements list response. Row-isolated like file
 * parsing: one bad record doesn't sink the page.
 */
export function parseFlutterwaveSettlementList(response: unknown): SettlementFileParseResult {
  const envelope = z
    .object({ status: z.string(), data: z.array(z.unknown()) })
    .safeParse(response);
  if (!envelope.success || envelope.data.status.toLowerCase() !== "success") {
    const rows: ParseResult[] = [err("settlement list envelope malformed or unsuccessful", response)];
    return { provider: PROVIDER, format: "flutterwave-settlements-api-v4", rows, summary: summarizeRows(rows) };
  }
  const rows = envelope.data.data.map(parseFlutterwaveSettlement);
  return {
    provider: PROVIDER,
    format: "flutterwave-settlements-api-v4",
    rows,
    summary: summarizeRows(rows),
  };
}

function err(message: string, raw: unknown): ParseResult {
  return {
    kind: "parse_error",
    provider: PROVIDER,
    error: new MalformedPayloadError(message, raw),
    raw,
  };
}
