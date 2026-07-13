import { z } from "zod";
import { parseNairaDecimalString, type PaymentChannel, type TransactionStatus } from "@pay-normalize/core";

/**
 * Flutterwave's typed fee array — appears on settlements AND on retrieve/verify
 * charge responses (stamp_duty, charge_fee, vat, app, merchant, ...). Shared so
 * both parsers sum fees identically, with string/BigInt math (never float).
 */
export const FlwFeeSchema = z.object({
  type: z.string().nullish(),
  amount: z.union([z.number(), z.string()]),
});

export function sumFlwFees(
  fees: ReadonlyArray<z.infer<typeof FlwFeeSchema>> | null | undefined
): number {
  let total = 0;
  for (const f of fees ?? []) total += parseNairaDecimalString(f.amount);
  return total;
}

/**
 * Flutterwave v4 charge status vocabulary — the FOURTH status dialect in this
 * library ('succeeded' here; 'success' at Paystack; 'SUCCESS' at OPay/Nomba).
 */
const CHARGE_STATUS_MAP: Record<string, TransactionStatus> = {
  succeeded: "SUCCESSFUL",
  successful: "SUCCESSFUL", // tolerated: v3 vocabulary, in case of mixed-era payloads
  failed: "FAILED",
  pending: "PENDING",
  processing: "PENDING",
};

export function mapChargeStatus(raw: unknown): TransactionStatus | undefined {
  if (typeof raw !== "string") return undefined;
  return CHARGE_STATUS_MAP[raw.toLowerCase()];
}

/**
 * Settlement statuses — the full v4 vocabulary (retrieve-settlement enum):
 *   disburse-pending pending reviewed approved completed completed-offline
 *   failed flagged processing on-hold
 * Only the two terminal 'completed*' states mean the money has landed
 * (SUCCESSFUL). Everything pre-terminal maps to PENDING — the money hasn't
 * arrived and hasn't definitively failed — so the STATUS_RANK guard lets a
 * later 'completed' overwrite it. 'flagged'/'on-hold' (funds withheld pending
 * review) are PENDING, not FAILED, for the same reason: honest, and reversible.
 */
const SETTLEMENT_STATUS_MAP: Record<string, TransactionStatus> = {
  completed: "SUCCESSFUL",
  "completed-offline": "SUCCESSFUL",
  successful: "SUCCESSFUL",
  "disburse-pending": "PENDING",
  pending: "PENDING",
  reviewed: "PENDING",
  approved: "PENDING",
  processing: "PENDING",
  flagged: "PENDING",
  "on-hold": "PENDING",
  failed: "FAILED",
};

export function mapSettlementStatus(raw: unknown): TransactionStatus | undefined {
  if (typeof raw !== "string") return undefined;
  return SETTLEMENT_STATUS_MAP[raw.toLowerCase()];
}

/** payment_method.type -> channel. */
const METHOD_CHANNEL_MAP: Record<string, PaymentChannel> = {
  card: "card",
  bank_transfer: "bank_transfer",
  bank_account: "bank_transfer",
  ussd: "ussd",
  mobile_money: "wallet",
  opay: "wallet",
  qr: "qr",
  pos: "pos",
};

export function mapPaymentMethodType(raw: unknown): PaymentChannel {
  if (typeof raw !== "string") return "unknown";
  return METHOD_CHANNEL_MAP[raw.toLowerCase()] ?? "unknown";
}

/**
 * Flutterwave's created_datetime changes TYPE between their own documented
 * samples: ISO-8601 string in one ("2025-02-13T14:24:43.133Z"), float epoch
 * SECONDS in another (1735116842.116) — while the envelope `timestamp` is
 * integer epoch MILLISECONDS (1735116884019). One provider, three time
 * encodings. Resolution rule, explicit and tested (not vibes):
 *   - string  -> Date.parse (ISO)
 *   - number >= 1e12 -> epoch milliseconds
 *   - number  < 1e12 -> epoch seconds (possibly fractional)
 * The magnitude split is unambiguous for any date between 1971 and 33658 AD.
 */
export function resolveFlwTimestamp(
  raw: unknown
): { date: Date; raw: string } | undefined {
  if (typeof raw === "string" && raw.length > 0) {
    const d = new Date(raw);
    return Number.isNaN(d.getTime()) ? undefined : { date: d, raw };
  }
  if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) {
    const ms = raw >= 1e12 ? raw : raw * 1000;
    const d = new Date(Math.round(ms));
    return Number.isNaN(d.getTime()) ? undefined : { date: d, raw: String(raw) };
  }
  return undefined;
}
