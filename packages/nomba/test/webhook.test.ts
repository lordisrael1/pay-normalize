import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { toRawBody, shouldApplyStatusTransition } from "@pay-normalize/core";
import { parseNombaWebhook } from "../src/parse-webhook";
import { parseNombaTransactionRecord } from "../src/parse-transaction-record";

function fixture(dir: string, name: string) {
  return readFileSync(join(__dirname, "..", "fixtures", dir, name));
}

describe("payment_success (VA funding — the Owoore case)", () => {
  it("normalizes naira-decimal amounts without float drift", () => {
    const result = parseNombaWebhook(toRawBody(fixture("webhooks", "docs.payment_success.va_funding.json")));
    expect(result.kind).toBe("transaction");
    if (result.kind !== "transaction") return;
    const t = result.transaction;
    expect(t.provider).toBe("nomba");
    expect(t.amountInKobo).toBe(12000); // 120 naira
    expect(t.feeInKobo).toBe(60); // 0.6 naira — the sub-naira decimal case
    expect(t.netAmountInKobo).toBe(11940);
    expect(t.status).toBe("SUCCESSFUL");
    expect(t.direction).toBe("credit");
    expect(t.channel).toBe("bank_transfer"); // vact_transfer
    expect(t.providerEventId).toBe("49e11b44-909b-4f83-82b4-9a83a0000001"); // requestId = delivery id
    expect(t.dedupeKey).toBe(
      "nomba:transaction:API-VACT_TRA-613BB-eeae578a-cdd4-459c-8bd5-000001"
    );
  });
});

describe("event family routing", () => {
  it("payout_success -> SUCCESSFUL debit", () => {
    const result = parseNombaWebhook(toRawBody(fixture("webhooks", "docs.payout_success.json")));
    if (result.kind !== "transaction") throw new Error("expected transaction");
    expect(result.transaction.direction).toBe("debit");
    expect(result.transaction.status).toBe("SUCCESSFUL");
    expect(result.transaction.amountInKobo).toBe(10000); // 100 naira
    expect(result.transaction.feeInKobo).toBe(2000); // 20 naira
  });

  it("payment_reversal -> REVERSED on the SAME dedupeKey as the original payment", () => {
    const original = parseNombaWebhook(toRawBody(fixture("webhooks", "docs.payment_success.va_funding.json")));
    const reversal = parseNombaWebhook(toRawBody(fixture("webhooks", "docs.payment_reversal.json")));
    if (original.kind !== "transaction" || reversal.kind !== "transaction") {
      throw new Error("expected transactions");
    }
    expect(reversal.transaction.status).toBe("REVERSED");
    expect(reversal.transaction.dedupeKey).toBe(original.transaction.dedupeKey);
    expect(
      shouldApplyStatusTransition(original.transaction.status, reversal.transaction.status)
    ).toBe(true);
  });

  it("unpublished event types -> unknown_event (Nomba adds events over time)", () => {
    const future = JSON.stringify({ event_type: "loan_disbursed", requestId: "r1", data: {} });
    expect(parseNombaWebhook(toRawBody(Buffer.from(future)))).toMatchObject({
      kind: "unknown_event",
      eventType: "loan_disbursed",
    });
  });
});

describe("retry semantics (5 redeliveries at 2m/5m/11m/24m/53m)", () => {
  it("redelivery -> identical dedupeKey, no-op transition", () => {
    const a = parseNombaWebhook(toRawBody(fixture("webhooks", "docs.payment_success.json")));
    const b = parseNombaWebhook(toRawBody(fixture("webhooks", "docs.payment_success.json")));
    if (a.kind !== "transaction" || b.kind !== "transaction") throw new Error("expected transactions");
    expect(a.transaction.dedupeKey).toBe(b.transaction.dedupeKey);
    expect(shouldApplyStatusTransition(a.transaction.status, b.transaction.status)).toBe(false);
  });
});

describe("transaction records (prod.sanitized — real Owoore shape)", () => {
  it("models amountCharged = amount + fixedCharge: gross out, fee, net principal", () => {
    const record = JSON.parse(
      fixture("transaction-records", "prod.sanitized.payout.transfer.json").toString("utf8")
    );
    const result = parseNombaTransactionRecord(record);
    expect(result.kind).toBe("transaction");
    if (result.kind !== "transaction") return;
    const t = result.transaction;
    expect(t.amountInKobo).toBe(12000); // amountCharged "120.0" — total wallet debit
    expect(t.feeInKobo).toBe(2000); // fixedCharge "20.0"
    expect(t.netAmountInKobo).toBe(10000); // amount "100.0" — principal delivered
    expect(t.direction).toBe("debit"); // entryType DEBIT
    expect(t.status).toBe("SUCCESSFUL");
    expect(t.channel).toBe("bank_transfer");
    expect(t.providerReference).toBe("API-TRANSFER-1A28E-3aa1a344-e4a0-49a3-87e0-cd99bc946a2c");
    expect(t.occurredAtRaw).toBe("2026-07-05T06:22:29.603000Z"); // timeCompleted wins
    expect(t.currency).toBe("NGN");
  });

  it("record identity lives in the SAME space as webhook identity (record.id == webhook transactionId)", () => {
    const record = JSON.parse(
      fixture("transaction-records", "prod.sanitized.payout.transfer.json").toString("utf8")
    );
    const result = parseNombaTransactionRecord(record);
    if (result.kind !== "transaction") throw new Error("expected transaction");
    expect(result.transaction.dedupeKey).toBe(
      "nomba:transaction:API-TRANSFER-1A28E-3aa1a344-e4a0-49a3-87e0-cd99bc946a2c"
    );
    // -> a webhook-sourced row and a record-sourced row for the same transaction
    //    upsert into one row. That is recon collapsing into a unique index.
  });

  it("REFUSES records whose money fields disagree (no guessing which is authoritative)", () => {
    const record = JSON.parse(
      fixture("transaction-records", "prod.sanitized.payout.transfer.json").toString("utf8")
    );
    record.amountCharged = "125.0"; // now amount(100) + fixedCharge(20) != 125
    const result = parseNombaTransactionRecord(record);
    expect(result.kind).toBe("parse_error");
    if (result.kind !== "parse_error") return;
    expect(result.error.message).toContain("disagree");
  });

  it("computes amountCharged when absent (amount + fixedCharge)", () => {
    const record = JSON.parse(
      fixture("transaction-records", "prod.sanitized.payout.transfer.json").toString("utf8")
    );
    delete record.amountCharged;
    const result = parseNombaTransactionRecord(record);
    if (result.kind !== "transaction") throw new Error("expected transaction");
    expect(result.transaction.amountInKobo).toBe(12000);
  });
});

describe("hostile input", () => {
  it("non-JSON, missing envelope, unparseable amounts -> parse_error, never throws", () => {
    expect(parseNombaWebhook(toRawBody(Buffer.from("nope"))).kind).toBe("parse_error");
    expect(parseNombaWebhook(toRawBody(Buffer.from('{"a":1}'))).kind).toBe("parse_error");
    const badAmount = JSON.stringify({
      event_type: "payment_success",
      requestId: "r",
      data: {
        transaction: {
          transactionId: "T1",
          transactionAmount: "12.345", // 3dp — no such money
          type: "vact_transfer",
          time: "2026-07-01T00:00:00Z",
        },
      },
    });
    expect(parseNombaWebhook(toRawBody(Buffer.from(badAmount))).kind).toBe("parse_error");
  });
});
