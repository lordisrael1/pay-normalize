import type { PaymentChannel, TransactionStatus } from "@pay-normalize/core";

/**
 * Collection (`SUCCESSFUL_TRANSACTION`) and verify-API `paymentStatus`
 * vocabulary. Explicit table only — no inference (NOT_DOING.md §9). Unmapped
 * statuses become a parse_error upstream, never a guess.
 */
const COLLECTION_STATUS_MAP: Record<string, TransactionStatus> = {
  PAID: "SUCCESSFUL",
  OVERPAID: "SUCCESSFUL",
  PARTIALLY_PAID: "SUCCESSFUL", // money did move; under/over is reflected in amount vs. expected
  PENDING: "PENDING",
  FAILED: "FAILED",
  EXPIRED: "FAILED",
  CANCELLED: "FAILED",
};

export function mapCollectionStatus(raw: unknown): TransactionStatus | undefined {
  if (typeof raw !== "string") return undefined;
  return COLLECTION_STATUS_MAP[raw.toUpperCase()];
}

/**
 * Disbursement (`SUCCESSFUL_DISBURSEMENT` / `FAILED_DISBURSEMENT`) `status`
 * vocabulary. The event name is authoritative over the field, but we map the
 * field so a mismatch surfaces rather than being silently trusted.
 */
const DISBURSEMENT_STATUS_MAP: Record<string, TransactionStatus> = {
  SUCCESS: "SUCCESSFUL",
  SUCCESSFUL: "SUCCESSFUL",
  FAILED: "FAILED",
  PENDING: "PENDING",
  REVERSED: "REVERSED",
};

export function mapDisbursementStatus(raw: unknown): TransactionStatus | undefined {
  if (typeof raw !== "string") return undefined;
  return DISBURSEMENT_STATUS_MAP[raw.toUpperCase()];
}

/** paymentMethod -> channel. Unmapped normalizes to 'unknown', raw preserved. */
const METHOD_CHANNEL_MAP: Record<string, PaymentChannel> = {
  ACCOUNT_TRANSFER: "bank_transfer",
  DIRECT_DEBIT: "bank_transfer",
  CARD: "card",
  USSD: "ussd",
  PHONE_NUMBER: "wallet",
  QR: "qr",
  CASH: "unknown", // offline agent cash — no on-us rail; preserved in raw
};

export function mapPaymentMethod(raw: unknown): PaymentChannel {
  if (typeof raw !== "string") return "unknown";
  return METHOD_CHANNEL_MAP[raw.toUpperCase()] ?? "unknown";
}

/**
 * Monnify timestamps arrive in THREE formats across events, mostly UNLABELED:
 *   1. ISO-8601 with explicit zone:  "2025-09-01T23:13:19Z", "2022-07-20T21:01:06.000+0000"
 *   2. "YYYY-MM-DD HH:mm:ss(.SSS)":   "2021-11-17 11:28:42.615", "2023-06-26 17:53:55.0"
 *   3. "DD/MM/YYYY h:mm:ss AM/PM":    "17/11/2021 3:48:10 PM", "17/03/2021 3:23:32 AM"
 *
 * Formats 2 and 3 carry NO timezone. Monnify is a Lagos-based Nigerian
 * provider; the explicit rule (per NOT_DOING.md §9 "no timezone guessing" —
 * this IS the explicit per-provider rule) is that unlabeled timestamps are
 * WAT (UTC+01:00, no DST). The original string is preserved verbatim in
 * `occurredAtRaw`, and hosts must never order on `occurredAt` (that is what
 * STATUS_RANK is for). NEEDS CONFIRMATION against real captures.
 */
const WAT_OFFSET_MS = 60 * 60 * 1000; // UTC+01:00

export function parseMonnifyTimestamp(
  raw: unknown
): { date: Date; raw: string } | undefined {
  if (typeof raw !== "string" || raw.length === 0) return undefined;
  const s = raw.trim();

  // Format 1: explicit zone (Z or ±hhmm / ±hh:mm) -> trust it.
  if (/(?:z|[+-]\d{2}:?\d{2})$/i.test(s)) {
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? undefined : { date: d, raw };
  }

  // Format 2: "YYYY-MM-DD HH:mm:ss(.SSS)" — treat as WAT.
  const iso = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?$/.exec(s);
  if (iso) {
    const [, y, mo, d, hh, mm, ss, frac] = iso;
    const ms = frac ? Number(frac.slice(0, 3).padEnd(3, "0")) : 0;
    return fromWat(+y!, +mo!, +d!, +hh!, +mm!, +ss!, ms, raw);
  }

  // Format 3: "DD/MM/YYYY h:mm:ss AM/PM" — treat as WAT.
  const dmy = /^(\d{2})\/(\d{2})\/(\d{4})\s+(\d{1,2}):(\d{2}):(\d{2})\s*(AM|PM)$/i.exec(s);
  if (dmy) {
    const [, d, mo, y, h12, mm, ss, mer] = dmy;
    let hh = +h12!;
    const isPm = mer!.toUpperCase() === "PM";
    if (isPm && hh !== 12) hh += 12;
    if (!isPm && hh === 12) hh = 0;
    return fromWat(+y!, +mo!, +d!, hh, +mm!, +ss!, 0, raw);
  }

  return undefined;
}

function fromWat(
  y: number, mo: number, d: number, hh: number, mm: number, ss: number, ms: number, raw: string
): { date: Date; raw: string } | undefined {
  // Range-check before constructing: Date.UTC silently rolls over out-of-range
  // fields (month 13 -> next year, day 32 -> next month), which would accept a
  // malformed timestamp. Reject rather than normalize.
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || hh > 23 || mm > 59 || ss > 59) return undefined;
  const wallClock = Date.UTC(y, mo - 1, d, hh, mm, ss, ms);
  const check = new Date(wallClock);
  if (
    check.getUTCFullYear() !== y || check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d
  ) {
    return undefined; // e.g. 31/02 rolled into March — invalid date
  }
  return { date: new Date(wallClock - WAT_OFFSET_MS), raw };
}
