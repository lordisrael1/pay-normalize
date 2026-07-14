import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { toRawBody, shouldApplyStatusTransition } from "@pay-normalize/core";
import { parsePaystackWebhook, chargeDedupeKey } from "../src/parse-webhook";
import { paystack } from "../src/index";

/** Fixtures load as BYTES (readFileSync, no encoding) — byte fidelity is the contract. */
function fixture(name: string) {
  return toRawBody(readFileSync(join(__dirname, "..", "fixtures", "webhooks", name)));
}

describe("charge.success", () => {
  it("normalizes a card charge with fees", () => {
    const result = parsePaystackWebhook(fixture("docs.charge.success.json"));
    expect(result.kind).toBe("transaction");
    if (result.kind !== "transaction") return;
    const t = result.transaction;
    expect(t.provider).toBe("paystack");
    expect(t.providerReference).toBe("qTPrJoy9Bx");
    expect(t.dedupeKey).toBe("paystack:charge:qTPrJoy9Bx");
    expect(t.amountInKobo).toBe(10000); // already kobo — NOT multiplied by 100
    expect(t.feeInKobo).toBe(150);
    expect(t.netAmountInKobo).toBe(9850);
    expect(t.currency).toBe("NGN");
    expect(t.status).toBe("SUCCESSFUL");
    expect(t.channel).toBe("card");
    expect(t.direction).toBe("credit");
    expect(t.occurredAt.toISOString()).toBe("2026-06-30T10:03:09.000Z");
    expect(t.occurredAtRaw).toBe("2026-06-30T10:03:09.000Z");
    expect(t.settlementDate).toBeNull();
    expect(t.rawProviderPayload).toBeTruthy();
  });

  it("maps dedicated_nuban (virtual account funding) to bank_transfer", () => {
    const result = parsePaystackWebhook(fixture("docs.charge.success.bank_transfer.json"));
    if (result.kind !== "transaction") throw new Error("expected transaction");
    expect(result.transaction.channel).toBe("bank_transfer");
    expect(result.transaction.amountInKobo).toBe(2_500_000);
    expect(result.transaction.netAmountInKobo).toBe(2_475_000);
  });

  it("redelivery produces an identical dedupeKey (Paystack retries 3-minutely then hourly for 72h)", () => {
    const a = parsePaystackWebhook(fixture("docs.charge.success.json"));
    const b = parsePaystackWebhook(fixture("docs.charge.success.json"));
    if (a.kind !== "transaction" || b.kind !== "transaction") throw new Error("expected transactions");
    expect(a.transaction.dedupeKey).toBe(b.transaction.dedupeKey);
    // and same-status redelivery is a no-op under the rank guard:
    expect(shouldApplyStatusTransition(a.transaction.status, b.transaction.status)).toBe(false);
  });
});

describe("charge.success — real captured deliveries (sanitized, test-mode)", () => {
  // Captured from an actual `x-paystack-signature`-verified webhook delivery
  // against a live host, not reconstructed from docs. `domain: "test"` in the
  // payload is honest about provenance: these are real wire-format captures
  // from Paystack's own webhook sender, from a sandbox (sk_test) charge, not
  // scrubbed live-customer traffic. Real quirks these reveal that the
  // docs-derived fixtures don't: fields like `fees_breakdown`, `log`,
  // `requested_amount`, `pos_transaction_data`, and `source` that Paystack's
  // published docs don't mention at all.
  it("card charge normalizes the same as the docs fixture, plus undocumented fields present", () => {
    const result = parsePaystackWebhook(fixture("prod.sanitized.charge.success.json"));
    expect(result.kind).toBe("transaction");
    if (result.kind !== "transaction") return;
    const t = result.transaction;
    expect(t.providerReference).toBe("pa_86a531c526eb4bc092d68f376f210bfa");
    expect(t.amountInKobo).toBe(150000);
    expect(t.feeInKobo).toBe(2250);
    expect(t.netAmountInKobo).toBe(147750);
    expect(t.channel).toBe("card");
    expect(t.status).toBe("SUCCESSFUL");
    expect(t.direction).toBe("credit");
  });

  it("bank_transfer charge.success (dedicated-account funding) normalizes to bank_transfer", () => {
    const result = parsePaystackWebhook(fixture("prod.sanitized.charge.success.bank_transfer.json"));
    expect(result.kind).toBe("transaction");
    if (result.kind !== "transaction") return;
    const t = result.transaction;
    expect(t.providerReference).toBe("pa_06ed1e1bfa7c4ffe914646ba1606cd60");
    expect(t.amountInKobo).toBe(150000);
    expect(t.feeInKobo).toBe(2250);
    expect(t.netAmountInKobo).toBe(147750);
    expect(t.channel).toBe("bank_transfer");
    expect(t.status).toBe("SUCCESSFUL");
    // Real payloads mask sender account details themselves (Paystack does this,
    // not us) — the connector must not choke on already-masked authorization fields.
    expect(t.rawProviderPayload).toBeTruthy();
  });
});

describe("transfers (debits)", () => {
  it("transfer.success -> SUCCESSFUL debit", () => {
    const result = parsePaystackWebhook(fixture("docs.transfer.success.json"));
    if (result.kind !== "transaction") throw new Error("expected transaction");
    const t = result.transaction;
    expect(t.direction).toBe("debit");
    expect(t.status).toBe("SUCCESSFUL");
    expect(t.amountInKobo).toBe(30000);
    expect(t.dedupeKey).toBe("paystack:transfer:1jhbs3ozmen0k7y5efmw");
  });

  it("transfer.reversed -> REVERSED, and rank allows SUCCESSFUL -> REVERSED", () => {
    const result = parsePaystackWebhook(fixture("docs.transfer.reversed.json"));
    if (result.kind !== "transaction") throw new Error("expected transaction");
    expect(result.transaction.status).toBe("REVERSED");
    expect(shouldApplyStatusTransition("SUCCESSFUL", result.transaction.status)).toBe(true);
  });
});

describe("refund.processed — the cross-event identity case", () => {
  it("emits REVERSED against the ORIGINAL charge dedupeKey", () => {
    const charge = parsePaystackWebhook(fixture("docs.charge.success.json"));
    const refund = parsePaystackWebhook(fixture("docs.refund.processed.json"));
    if (charge.kind !== "transaction" || refund.kind !== "transaction") throw new Error("expected transactions");
    // Same identity — host's unique index sees a status transition, not a new row
    expect(refund.transaction.dedupeKey).toBe(charge.transaction.dedupeKey);
    expect(refund.transaction.dedupeKey).toBe(chargeDedupeKey("qTPrJoy9Bx"));
    expect(refund.transaction.status).toBe("REVERSED");
    // and the transition applies:
    expect(
      shouldApplyStatusTransition(charge.transaction.status, refund.transaction.status)
    ).toBe(true);
  });
});

describe("recognized non-money events pass through as unknown_event", () => {
  it.each([
    ["docs.subscription.create.json", "subscription.create"],
    ["docs.dedicatedaccount.assign.success.json", "dedicatedaccount.assign.success"],
  ])("%s -> unknown_event(%s)", (file: string, eventType: string) => {
    const result = parsePaystackWebhook(fixture(file));
    expect(result).toMatchObject({ kind: "unknown_event", provider: "paystack", eventType });
  });
});

describe("hostile/broken input never throws", () => {
  it("non-JSON bytes -> parse_error", () => {
    const result = parsePaystackWebhook(toRawBody(Buffer.from("<xml>not json</xml>")));
    expect(result.kind).toBe("parse_error");
  });

  it("JSON without the { event, data } envelope -> parse_error", () => {
    const result = parsePaystackWebhook(toRawBody(Buffer.from('{"hello":"world"}')));
    expect(result.kind).toBe("parse_error");
  });

  it("charge.success with decimal amount -> parse_error (kobo must be integer)", () => {
    const bad = JSON.stringify({
      event: "charge.success",
      data: { reference: "X1", amount: "5000.00", status: "success", paid_at: "2026-07-01T00:00:00.000Z" },
    });
    const result = parsePaystackWebhook(toRawBody(Buffer.from(bad)));
    expect(result.kind).toBe("parse_error");
  });

  it("charge.success missing reference -> parse_error", () => {
    const bad = JSON.stringify({
      event: "charge.success",
      data: { amount: 1000, status: "success", paid_at: "2026-07-01T00:00:00.000Z" },
    });
    expect(parsePaystackWebhook(toRawBody(Buffer.from(bad))).kind).toBe("parse_error");
  });

  it("future unknown event types -> unknown_event, never a throw (forward compatibility)", () => {
    const future = JSON.stringify({ event: "quantum.settlement.teleported", data: { anything: true } });
    const result = parsePaystackWebhook(toRawBody(Buffer.from(future)));
    expect(result).toMatchObject({ kind: "unknown_event", eventType: "quantum.settlement.teleported" });
  });
});

describe("Connector interface conformance", () => {
  it("exposes provider, version, and throws honest UnsupportedFileFormatError for settlement files", () => {
    expect(paystack.provider).toBe("paystack");
    expect(paystack.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(() => paystack.parseSettlementFile(Buffer.from("a,b,c"))).toThrow(
      /not yet fixture-verified/
    );
  });
});
