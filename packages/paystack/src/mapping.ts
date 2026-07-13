import type { PaymentChannel, TransactionStatus } from "@pay-normalize/core";

/**
 * Explicit mapping tables — NOT_DOING.md §9 bans status/channel inference.
 * Every value Paystack can send is either in a table or the payload becomes
 * an unknown/parse_error result. No `default: SUCCESSFUL` anywhere, ever.
 */

/** Channels observed in charge payloads. Unmapped values normalize to 'unknown', preserved in raw. */
const CHANNEL_MAP: Record<string, PaymentChannel> = {
  card: "card",
  bank: "bank_transfer", // Paystack "Pay with Bank" (direct debit rails)
  bank_transfer: "bank_transfer",
  dedicated_nuban: "bank_transfer",
  ussd: "ussd",
  qr: "qr",
  mobile_money: "wallet",
  eft: "bank_transfer",
  pos: "pos",
};

export function mapChannel(raw: unknown): PaymentChannel {
  if (typeof raw !== "string") return "unknown";
  return CHANNEL_MAP[raw.toLowerCase()] ?? "unknown";
}

/**
 * The AUTHORITATIVE Paystack transaction status vocabulary (all 8 documented
 * statuses), used by charge webhooks and the verify-transaction API:
 *
 *   success    -> SUCCESSFUL  ("successfully processed")
 *   failed     -> FAILED      ("transaction failed"; details in gateway_response)
 *   abandoned  -> FAILED      ("customer hasn't completed the transaction" —
 *                 the customer walked away. Money never moved, so FAILED; and
 *                 because STATUS_RANK allows FAILED(1) -> SUCCESSFUL(2), the
 *                 known Paystack pattern of an abandoned pay-with-transfer
 *                 completing LATE still applies cleanly when success arrives.)
 *   reversed   -> REVERSED    ("refunded, or a chargeback was successfully logged")
 *   pending    -> PENDING     ("currently in progress")
 *   processing -> PENDING     ("same as pending, but for direct debit")
 *   queued     -> PENDING     ("queued to be processed later" — bulk charges only)
 *   ongoing    -> PENDING     ("waiting on the customer" — OTP entry, or the
 *                 customer making the transfer in pay-with-transfer)
 *
 * Anything outside this table -> undefined -> parse_error upstream. Loud, not guessed.
 */
const CHARGE_STATUS_MAP: Record<string, TransactionStatus> = {
  success: "SUCCESSFUL",
  failed: "FAILED",
  abandoned: "FAILED",
  reversed: "REVERSED",
  pending: "PENDING",
  processing: "PENDING",
  queued: "PENDING",
  ongoing: "PENDING",
};

export function mapChargeStatus(raw: unknown): TransactionStatus | undefined {
  if (typeof raw !== "string") return undefined;
  return CHARGE_STATUS_MAP[raw.toLowerCase()];
}

/** Transfer events encode status in the event name — authoritative over data.status. */
export const TRANSFER_EVENT_STATUS: Record<string, TransactionStatus> = {
  "transfer.success": "SUCCESSFUL",
  "transfer.failed": "FAILED",
  "transfer.reversed": "REVERSED",
};
