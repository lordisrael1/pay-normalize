import { z } from "zod";

/**
 * How the money moved. 'unknown' is a legitimate value — bank statement rows
 * frequently do not disclose the channel, and guessing violates NOT_DOING.md §9.
 * 'pos' covers agent/terminal collections (OPay, PalmPay, Moniepoint territory).
 */
export const PaymentChannelSchema = z.enum([
  "card",
  "bank_transfer",
  "ussd",
  "qr",
  "wallet",
  "pos",
  "unknown",
]);
export type PaymentChannel = z.infer<typeof PaymentChannelSchema>;
