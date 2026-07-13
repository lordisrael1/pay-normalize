import { describe, it, expect, beforeEach } from "vitest";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { chargeDedupeKey } from "@pay-normalize/paystack";
import { InMemoryLedger } from "../ledger";
import { handlePaystackWebhook } from "../handle-webhook";

/**
 * Executable proof that the Paystack pieces connect end-to-end:
 * raw bytes -> verify -> parse -> idempotent ledger, with real fixtures and
 * real HMAC-SHA512 signing. This is docs/INTEGRATION.md, running.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const fx = (name: string) =>
  readFileSync(join(HERE, "..", "..", "..", "packages", "paystack", "fixtures", "webhooks", name));

const SECRET = "sk_test_ledger_example_not_real";
const sign = (buf: Buffer, s = SECRET) =>
  createHmac("sha512", s).update(buf).digest("hex");
const post = (ledger: InMemoryLedger, buf: Buffer, sig = sign(buf)) =>
  handlePaystackWebhook(buf, { "x-paystack-signature": sig }, SECRET, ledger);

const CHARGE = fx("docs.charge.success.json");
const REFUND = fx("docs.refund.processed.json");
const SUBSCRIPTION = fx("docs.subscription.create.json");
const DEDUPE = chargeDedupeKey("qTPrJoy9Bx"); // charge and its refund share this key

describe("Paystack -> idempotent ledger integration", () => {
  let ledger: InMemoryLedger;
  beforeEach(() => {
    ledger = new InMemoryLedger();
  });

  it("verifies, parses, and inserts a charge as one SUCCESSFUL row", () => {
    const r = post(ledger, CHARGE);
    expect(r).toMatchObject({ status: 200, kind: "transaction", outcome: "inserted", dedupeKey: DEDUPE });
    expect(ledger.get(DEDUPE)?.status).toBe("SUCCESSFUL");
    expect(ledger.size).toBe(1);
  });

  it("is idempotent: a redelivered charge is ignored, not double-recorded", () => {
    post(ledger, CHARGE);
    const again = post(ledger, CHARGE); // provider retried the exact same event
    expect(again.outcome).toBe("ignored");
    expect(ledger.size).toBe(1); // still one row
  });

  it("applies the cross-event refund as SUCCESSFUL -> REVERSED on the SAME row", () => {
    post(ledger, CHARGE);
    const refund = post(ledger, REFUND);
    expect(refund).toMatchObject({ kind: "transaction", outcome: "updated", dedupeKey: DEDUPE });
    expect(ledger.get(DEDUPE)?.status).toBe("REVERSED");
    expect(ledger.size).toBe(1); // refund is a transition, not a new row
  });

  it("resists out-of-order delivery: a charge arriving AFTER its refund cannot un-reverse it", () => {
    post(ledger, REFUND); // refund lands first (REVERSED)
    const late = post(ledger, CHARGE); // the success webhook arrives late
    expect(late.outcome).toBe("ignored"); // SUCCESSFUL(2) does not outrank REVERSED(3)
    expect(ledger.get(DEDUPE)?.status).toBe("REVERSED");
  });

  it("surfaces a non-money event as unknown_event without touching the ledger", () => {
    const r = post(ledger, SUBSCRIPTION);
    expect(r).toMatchObject({ status: 200, kind: "unknown_event", detail: "subscription.create" });
    expect(ledger.size).toBe(0);
  });

  it("rejects a bad signature with 401 and never parses or ingests", () => {
    const r = post(ledger, CHARGE, "deadbeef"); // wrong signature
    expect(r).toEqual({ status: 401, kind: "unverified" });
    expect(ledger.size).toBe(0);
  });

  it("ACKs a malformed-but-signed payload with 200 + parse_error, no ingest (poison message)", () => {
    const junk = Buffer.from('{"event":"charge.success","data":{}}'); // missing required fields
    const r = post(ledger, junk);
    expect(r).toMatchObject({ status: 200, kind: "parse_error" });
    expect(ledger.size).toBe(0);
  });
});
