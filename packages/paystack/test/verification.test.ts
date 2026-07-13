import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { toRawBody, shouldApplyStatusTransition } from "@pay-normalize/core";
import { parsePaystackVerification } from "../src/parse-verification";
import { parsePaystackWebhook, chargeDedupeKey } from "../src/parse-webhook";
import { mapChargeStatus } from "../src/mapping";

const verifyFixture = () =>
  JSON.parse(
    readFileSync(join(__dirname, "..", "fixtures", "verify", "docs.verify.success.json"), "utf8")
  );

describe("parsePaystackVerification (Paystack's documented sample response)", () => {
  it("normalizes the verify response", () => {
    const result = parsePaystackVerification(verifyFixture());
    expect(result.kind).toBe("transaction");
    if (result.kind !== "transaction") return;
    const t = result.transaction;
    expect(t.providerReference).toBe("re4lyvq3s3");
    expect(t.amountInKobo).toBe(40333);
    expect(t.feeInKobo).toBe(10283);
    expect(t.status).toBe("SUCCESSFUL");
    expect(t.channel).toBe("card");
    expect(t.occurredAtRaw).toBe("2024-08-22T09:15:02.000Z"); // paid_at wins over created_at
  });

  it("PINS THE MONEY MODEL: net = amount - fees = requested_amount (fees passed to customer)", () => {
    const fixture = verifyFixture();
    const result = parsePaystackVerification(fixture);
    if (result.kind !== "transaction") throw new Error("expected transaction");
    // Paystack's own sample: 40333 - 10283 = 30050
    expect(result.transaction.netAmountInKobo).toBe(fixture.data.requested_amount);
  });

  it("shares identity with the webhook row — verify-sourced and webhook-sourced upsert into ONE row", () => {
    const result = parsePaystackVerification(verifyFixture());
    if (result.kind !== "transaction") throw new Error("expected transaction");
    expect(result.transaction.dedupeKey).toBe(chargeDedupeKey("re4lyvq3s3"));
    // and it's the same key parseWebhook would produce for this reference:
    const webhookStyle = JSON.stringify({
      event: "charge.success",
      data: { reference: "re4lyvq3s3", amount: 40333, fees: 10283, status: "success", channel: "card", paid_at: "2024-08-22T09:15:02.000Z" },
    });
    const viaWebhook = parsePaystackWebhook(toRawBody(Buffer.from(webhookStyle)));
    if (viaWebhook.kind !== "transaction") throw new Error("expected transaction");
    expect(viaWebhook.transaction.dedupeKey).toBe(result.transaction.dedupeKey);
  });

  it("API-level failure envelope (status:false) -> parse_error with the API message", () => {
    const result = parsePaystackVerification({
      status: false,
      message: "Transaction reference not found",
      data: null,
    });
    expect(result.kind).toBe("parse_error");
    if (result.kind !== "parse_error") return;
    expect(result.error.message).toContain("Transaction reference not found");
  });

  it("unmapped status -> parse_error, loud not guessed", () => {
    const f = verifyFixture();
    f.data.status = "quantum";
    expect(parsePaystackVerification(f).kind).toBe("parse_error");
  });
});

describe("the authoritative 8-status vocabulary", () => {
  it.each([
    ["success", "SUCCESSFUL"],
    ["failed", "FAILED"],
    ["abandoned", "FAILED"],
    ["reversed", "REVERSED"],
    ["pending", "PENDING"],
    ["processing", "PENDING"],
    ["queued", "PENDING"],
    ["ongoing", "PENDING"],
  ] as const)("%s -> %s", (raw, expected) => {
    expect(mapChargeStatus(raw)).toBe(expected);
  });

  it("abandoned pay-with-transfer completing LATE still applies: FAILED -> SUCCESSFUL is a legal transition", () => {
    // Known Paystack behavior: customer abandons, then their transfer lands.
    // abandoned -> FAILED(rank 1); the late success -> SUCCESSFUL(rank 2) wins.
    const abandoned = mapChargeStatus("abandoned");
    const success = mapChargeStatus("success");
    if (!abandoned || !success) throw new Error("mapping gap");
    expect(shouldApplyStatusTransition(abandoned, success)).toBe(true);
    // ...while the reverse can never regress:
    expect(shouldApplyStatusTransition(success, abandoned)).toBe(false);
  });

  it("statuses outside the table map to undefined", () => {
    expect(mapChargeStatus("SUCCESSISH")).toBeUndefined();
    expect(mapChargeStatus(42)).toBeUndefined();
  });
});
