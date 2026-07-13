import type { PaymentChannel, TransactionStatus } from "@pay-normalize/core";

/**
 * Nomba encodes BOTH status and direction in the event name — the cleanest
 * scheme of the three providers. All six published events, explicitly:
 *
 *   payment_*  = money toward your Nomba account  (credit)
 *   payout_*   = money leaving your Nomba account (debit)
 *   *_reversal / *_refund = the money came back    (REVERSED, rank 3 —
 *     overwrites a stored SUCCESSFUL via the rank guard)
 */
export const EVENT_MAP: Readonly<
  Record<string, { status: TransactionStatus; direction: "credit" | "debit" }>
> = Object.freeze({
  payment_success: { status: "SUCCESSFUL", direction: "credit" },
  payment_failed: { status: "FAILED", direction: "credit" },
  payment_reversal: { status: "REVERSED", direction: "credit" },
  payout_success: { status: "SUCCESSFUL", direction: "debit" },
  payout_failed: { status: "FAILED", direction: "debit" },
  payout_refund: { status: "REVERSED", direction: "debit" },
});

/**
 * transaction.type -> channel. vact_transfer (virtual account funding — the
 * Owoore case) is the founding member. Unmapped types normalize to 'unknown'
 * with the raw payload preserved; each new type observed in production gets a
 * fixture and a row here.
 */
const TYPE_CHANNEL_MAP: Record<string, PaymentChannel> = {
  vact_transfer: "bank_transfer",
  transfer: "bank_transfer",
  card_transaction: "card",
  card: "card",
  pos: "pos",
  ussd: "ussd",
  qr: "qr",
  wallet: "wallet",
};

export function mapNombaType(raw: unknown): PaymentChannel {
  if (typeof raw !== "string") return "unknown";
  return TYPE_CHANNEL_MAP[raw.toLowerCase()] ?? "unknown";
}

/** Statuses appearing in Nomba's transaction-record API (list/lookup responses). */
const RECORD_STATUS_MAP: Record<string, TransactionStatus> = {
  SUCCESS: "SUCCESSFUL",
  SUCCESSFUL: "SUCCESSFUL",
  FAILED: "FAILED",
  FAIL: "FAILED",
  PENDING: "PENDING",
  PROCESSING: "PENDING",
  REVERSED: "REVERSED",
  REFUNDED: "REVERSED",
};

export function mapRecordStatus(raw: unknown): TransactionStatus | undefined {
  if (typeof raw !== "string") return undefined;
  return RECORD_STATUS_MAP[raw.toUpperCase()];
}
