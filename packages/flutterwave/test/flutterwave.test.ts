import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { rawBodyFromString, toRawBody } from "@pay-normalize/core";
import { flutterwave } from "../src/index";
import { parseFlutterwaveWebhook, chargeDedupeKey } from "../src/parse-webhook";
import { parseFlutterwaveCharge, parseFlutterwaveChargeAt } from "../src/parse-charge";
import {
  parseFlutterwaveSettlement,
  parseFlutterwaveSettlementList,
} from "../src/parse-settlement";
import { resolveFlwTimestamp } from "../src/mapping";

const SECRET = "flw_test_secret_hash_not_real";
const fx = (dir: string, name: string) =>
  readFileSync(join(__dirname, "..", "fixtures", dir, name));

describe("signature (documented HMAC-SHA256-base64 scheme)", () => {
  const body = fx("webhooks", "docs.charge.completed.card.json").toString("utf8");
  const sign = (b: string, s = SECRET) =>
    createHmac("sha256", s).update(Buffer.from(b, "utf8")).digest("base64");

  it("accepts a correctly signed payload (case-insensitive header)", () => {
    expect(
      flutterwave.verifyWebhookSignature({
        headers: { "Flutterwave-Signature": sign(body) },
        rawBody: rawBodyFromString(body),
        secret: SECRET,
      })
    ).toBe(true);
  });

  it("rejects tampered body / wrong secret / missing header", () => {
    expect(
      flutterwave.verifyWebhookSignature({
        headers: { "flutterwave-signature": sign(body) },
        rawBody: rawBodyFromString(body.replace('"amount":2000', '"amount":2001')),
        secret: SECRET,
      })
    ).toBe(false);
    expect(
      flutterwave.verifyWebhookSignature({
        headers: { "flutterwave-signature": sign(body, "wrong") },
        rawBody: rawBodyFromString(body),
        secret: SECRET,
      })
    ).toBe(false);
    expect(
      flutterwave.verifyWebhookSignature({
        headers: {},
        rawBody: rawBodyFromString(body),
        secret: SECRET,
      })
    ).toBe(false);
  });

  it("PINS THE DOCS CONTRADICTION: the plain-secret comparison from their Examples section does NOT verify under the documented HMAC scheme", () => {
    // Their Examples section does: signature === secretHash (no HMAC).
    // Under the documented scheme, a header containing the bare secret fails:
    expect(
      flutterwave.verifyWebhookSignature({
        headers: { "flutterwave-signature": SECRET },
        rawBody: rawBodyFromString(body),
        secret: SECRET,
      })
    ).toBe(false);
    // First sanitized prod capture (WITH headers) arbitrates which is real.
  });
});

describe("charge.completed — both documented samples", () => {
  it("card sample: ISO-string created_datetime, wbk delivery id (webhook_id field), NGN decimals", () => {
    const result = parseFlutterwaveWebhook(toRawBody(fx("webhooks", "docs.charge.completed.card.json")));
    expect(result.kind).toBe("transaction");
    if (result.kind !== "transaction") return;
    const t = result.transaction;
    expect(t.provider).toBe("flutterwave");
    expect(t.providerReference).toBe("chg_zam88NgLb7");
    expect(t.dedupeKey).toBe("flutterwave:charge:chg_zam88NgLb7");
    expect(t.amountInKobo).toBe(200000); // 2000 NGN main units -> kobo
    expect(t.status).toBe("SUCCESSFUL"); // 'succeeded' dialect
    expect(t.channel).toBe("card");
    expect(t.occurredAtRaw).toBe("2025-02-13T14:24:43.133Z");
    // Card deliveries carry the delivery id as `webhook_id`, not `id` — must still be captured.
    expect(t.providerEventId).toBe("wbk_yXvsB4LzWSwhUCpAPCBR");
  });

  it("bank_transfer (PWBT) sample: webhook_id delivery id, bank_transfer channel, nanosecond timestamp", () => {
    const result = parseFlutterwaveWebhook(toRawBody(fx("webhooks", "docs.charge.completed.bank_transfer.json")));
    expect(result.kind).toBe("transaction");
    if (result.kind !== "transaction") return;
    const t = result.transaction;
    expect(t.providerReference).toBe("chg_zH0BLoNltt");
    expect(t.amountInKobo).toBe(17500); // 175 NGN -> kobo
    expect(t.channel).toBe("bank_transfer");
    expect(t.providerEventId).toBe("wbk_xCBGoxP44NzL74hcCJiV"); // webhook_id field
    // created_datetime carries nanosecond precision; Date truncates to ms cleanly.
    expect(t.occurredAt.getTime()).toBe(Date.parse("2025-06-02T07:47:02.537Z"));
  });

  it("mobile_money sample: FLOAT-EPOCH created_datetime, KES passthrough, wallet channel", () => {
    const result = parseFlutterwaveWebhook(toRawBody(fx("webhooks", "docs.charge.completed.mobile_money.json")));
    if (result.kind !== "transaction") throw new Error("expected transaction");
    const t = result.transaction;
    expect(t.currency).toBe("KES"); // tagged, passed through — no FX
    expect(t.amountInKobo).toBe(250000); // 2500 KES -> minor units
    expect(t.channel).toBe("wallet"); // mobile_money
    expect(t.providerEventId).toBe("wbk_W5p6ktwU0jQ8RO4By860");
    // created_datetime 1735116842.116 (epoch SECONDS, float) -> exact ms preserved:
    expect(t.occurredAt.toISOString()).toBe("2024-12-25T08:54:02.116Z");
    expect(t.occurredAt.getTime()).toBe(1735116842116);
  });

  it("SAME FIELD, TWO TYPES: created_datetime is ISO-string in one doc sample, float-epoch in the other — both resolve", () => {
    const iso = resolveFlwTimestamp("2025-02-13T14:24:43.133Z");
    const epochSeconds = resolveFlwTimestamp(1735116842.116);
    const epochMs = resolveFlwTimestamp(1735116884019);
    expect(iso?.date.getTime()).toBe(Date.parse("2025-02-13T14:24:43.133Z"));
    expect(epochSeconds?.date.getTime()).toBe(1735116842116);
    expect(epochMs?.date.getTime()).toBe(1735116884019);
  });

  it("non-charge event types -> unknown_event", () => {
    const other = JSON.stringify({ type: "transfer.completed", id: "wbk_x", timestamp: 1, data: { id: "trf_1" } });
    expect(parseFlutterwaveWebhook(toRawBody(Buffer.from(other)))).toMatchObject({
      kind: "unknown_event",
      eventType: "transfer.completed",
    });
  });
});

describe("retrieve charge (verify-before-value)", () => {
  it("string-envelope quirk: { status: 'success' } (Paystack uses boolean true — same concept, different type)", () => {
    // Their retrieve sample has no created_datetime -> host supplies fetch time.
    const result = parseFlutterwaveChargeAt(
      JSON.parse(fx("charges", "docs.retrieve.charge.json").toString("utf8")),
      new Date("2026-07-05T10:00:00.000Z")
    );
    expect(result.kind).toBe("transaction");
    if (result.kind !== "transaction") return;
    expect(result.transaction.amountInKobo).toBe(150025); // 1500.25 -> BigInt path, no float drift
    expect(result.transaction.dedupeKey).toBe(chargeDedupeKey("chg_VoUhmFMhmF"));
    expect(result.transaction.status).toBe("SUCCESSFUL");
  });

  it("without a timestamp and without fetchedAt -> honest parse_error directing to the overload", () => {
    const result = parseFlutterwaveCharge(
      JSON.parse(fx("charges", "docs.retrieve.charge.json").toString("utf8"))
    );
    expect(result.kind).toBe("parse_error");
    if (result.kind !== "parse_error") return;
    expect(result.error.code).toBe("ERR_TIMESTAMP_MISSING"); // routable, not string-matched
  });

  it("PWBT verify: typed fees[] array is summed — net = amount - Σfees (zeros here)", () => {
    const result = parseFlutterwaveChargeAt(
      JSON.parse(fx("charges", "docs.retrieve.charge.bank_transfer.json").toString("utf8")),
      new Date("2025-06-02T07:47:03.000Z")
    );
    expect(result.kind).toBe("transaction");
    if (result.kind !== "transaction") return;
    expect(result.transaction.amountInKobo).toBe(17500); // 175 NGN
    expect(result.transaction.feeInKobo).toBe(0); // vat+app+merchant+stamp_duty all 0
    expect(result.transaction.netAmountInKobo).toBe(17500);
    expect(result.transaction.channel).toBe("bank_transfer");
  });

  it("charge fees flow through when nonzero: net = amount - Σfees, no float drift", () => {
    const base = JSON.parse(fx("charges", "docs.retrieve.charge.bank_transfer.json").toString("utf8"));
    base.data.fees = [
      { type: "vat", amount: 1.5 },
      { type: "stamp_duty", amount: 0.5 },
      { type: "merchant", amount: 2.25 },
    ]; // 4.25 NGN total
    const result = parseFlutterwaveChargeAt(base, new Date("2025-06-02T07:47:03.000Z"));
    if (result.kind !== "transaction") throw new Error(`expected transaction, got ${result.kind}`);
    expect(result.transaction.feeInKobo).toBe(425); // 4.25 NGN -> kobo
    expect(result.transaction.netAmountInKobo).toBe(17075); // 17500 - 425
  });

  it("API-failure envelope -> parse_error with the message", () => {
    const result = parseFlutterwaveCharge({ status: "error", message: "Charge not found", data: null });
    expect(result.kind).toBe("parse_error");
    if (result.kind !== "parse_error") return;
    expect(result.error.message).toContain("Charge not found");
  });
});

describe("settlements — first real settlementDate + typed fees", () => {
  it("normalizes a settlement with the net = gross - Σfees invariant holding", () => {
    const result = parseFlutterwaveSettlement(
      JSON.parse(fx("settlements", "docs.settlement.single.json").toString("utf8"))
    );
    expect(result.kind).toBe("transaction");
    if (result.kind !== "transaction") return;
    const t = result.transaction;
    expect(t.providerReference).toBe("stm_xpNivHNWmP");
    expect(t.amountInKobo).toBe(15000); // gross 150 -> minor units
    expect(t.feeInKobo).toBe(0); // stamp_duty 0 + charge_fee 0
    expect(t.netAmountInKobo).toBe(15000);
    expect(t.settlementDate?.toISOString()).toBe("2024-12-25T22:00:00.011Z"); // due_datetime
    expect(t.currency).toBe("USD"); // passthrough
    expect(t.status).toBe("SUCCESSFUL"); // 'completed'
  });

  it("REFUSES settlements whose money fields disagree", () => {
    const s = JSON.parse(fx("settlements", "docs.settlement.single.json").toString("utf8"));
    s.fees = [{ type: "charge_fee", amount: 10 }]; // now net(150) != gross(150) - 10
    const result = parseFlutterwaveSettlement(s);
    expect(result.kind).toBe("parse_error");
    if (result.kind !== "parse_error") return;
    expect(result.error.message).toContain("disagree");
  });

  it("nonzero fees flow through when the arithmetic holds", () => {
    const s = JSON.parse(fx("settlements", "docs.settlement.single.json").toString("utf8"));
    s.gross_amount = 150;
    s.fees = [{ type: "stamp_duty", amount: 0.5 }, { type: "charge_fee", amount: 2.25 }];
    s.net_amount = 147.25;
    const result = parseFlutterwaveSettlement(s);
    if (result.kind !== "transaction") throw new Error(`expected transaction, got ${result.kind}`);
    expect(result.transaction.feeInKobo).toBe(275);
    expect(result.transaction.netAmountInKobo).toBe(14725);
  });

  it("parses a full list response row-isolated, with the multi-charge batch preserved", () => {
    const result = parseFlutterwaveSettlementList(
      JSON.parse(fx("settlements", "docs.settlement.list.json").toString("utf8"))
    );
    expect(result.summary).toEqual({ transactions: 3, unknown: 0, errors: 0 });
    const batch = result.rows.find(
      (r) => r.kind === "transaction" && r.transaction.providerReference === "stm_TIrjYoJE8V"
    );
    expect(batch).toBeTruthy(); // charge_count "2" — a batch, one money movement
  });

  it("retrieve response: chargeback + refund are deducted alongside fees; net = gross - Σall", () => {
    // The host unwraps the { status, message, data } envelope and passes data.
    const s = JSON.parse(fx("settlements", "docs.settlement.retrieve.json").toString("utf8")).data;
    const result = parseFlutterwaveSettlement(s);
    expect(result.kind).toBe("transaction");
    if (result.kind !== "transaction") return;
    const t = result.transaction;
    expect(t.amountInKobo).toBe(1000000); // gross 10000
    // fees 200 + chargeback 100 + refund 50 = 350 main units -> 35000 kobo
    expect(t.feeInKobo).toBe(35000);
    expect(t.netAmountInKobo).toBe(965000); // net 9650
    expect(t.status).toBe("PENDING"); // 'processing'
    expect(t.settlementDate?.toISOString()).toBe("2026-01-15T22:00:00.000Z"); // due_datetime
    expect(t.occurredAt.toISOString()).toBe("2026-01-14T09:12:33.482Z"); // transaction_datetime preferred
  });

  it("REFUSES when the chargeback/refund breakdown doesn't reconcile to gross - net", () => {
    const s = JSON.parse(fx("settlements", "docs.settlement.retrieve.json").toString("utf8")).data;
    s.chargeback = 999; // no longer reconciles
    const result = parseFlutterwaveSettlement(s);
    expect(result.kind).toBe("parse_error");
    if (result.kind !== "parse_error") return;
    expect(result.error.message).toContain("disagree");
  });

  it("maps the full v4 status vocabulary (pre-terminal -> PENDING, completed* -> SUCCESSFUL)", () => {
    const base = JSON.parse(fx("settlements", "docs.settlement.single.json").toString("utf8"));
    const statusOf = (status: string) => {
      const r = parseFlutterwaveSettlement({ ...base, status });
      return r.kind === "transaction" ? r.transaction.status : `parse_error`;
    };
    for (const s of ["disburse-pending", "reviewed", "approved", "processing", "on-hold", "flagged"]) {
      expect(statusOf(s)).toBe("PENDING");
    }
    expect(statusOf("completed-offline")).toBe("SUCCESSFUL");
    expect(statusOf("failed")).toBe("FAILED");
    expect(statusOf("teleported")).toBe("parse_error"); // still loud on the unknown
  });
});

describe("hostile input", () => {
  it("never throws", () => {
    expect(parseFlutterwaveWebhook(toRawBody(Buffer.from("junk"))).kind).toBe("parse_error");
    expect(parseFlutterwaveWebhook(toRawBody(Buffer.from('{"no":"type"}'))).kind).toBe("parse_error");
    expect(parseFlutterwaveSettlement("not an object").kind).toBe("parse_error");
    expect(parseFlutterwaveCharge(null).kind).toBe("parse_error");
  });
});
