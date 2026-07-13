import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { toRawBody } from "@pay-normalize/core";
import { monnify } from "../src/index";
import {
  parseMonnifyWebhook,
  transactionDedupeKey,
  disbursementDedupeKey,
  settlementDedupeKey,
} from "../src/parse-webhook";
import { parseMonnifyTransaction } from "../src/parse-transaction";
import { parseMonnifyTimestamp } from "../src/mapping";

const fx = (dir: string, name: string) => readFileSync(join(__dirname, "..", "fixtures", dir, name));
const SECRET = "monnify_test_client_secret_not_real";
const sign = (buf: Buffer, s = SECRET) => createHmac("sha512", s).update(buf).digest("hex");

describe("signature (HMAC-SHA512 over raw body, hex — confirmed against Monnify's golden hash)", () => {
  it("GOLDEN VECTOR: reproduces Monnify's documented hash byte-for-byte", () => {
    const body = fx("webhooks", "docs.signature_golden_vector.json");
    const docSecret = "91MUDL9N6U3BQRXBQ2PJ9M0PW4J22M1Y";
    const docHash =
      "f04fb635e04d71648bd3cc7999003da6861483342c856d05ddfa9b2dafacb873b0de1d0f8f67405d0010b4348b721c49fa171d317972618debba6b638aedcd3c";
    expect(createHmac("sha512", docSecret).update(body).digest("hex")).toBe(docHash);
    // and it verifies through the connector (case-insensitive header)
    expect(
      monnify.verifyWebhookSignature({
        headers: { "Monnify-Signature": docHash },
        rawBody: toRawBody(body),
        secret: docSecret,
      })
    ).toBe(true);
  });

  it("accepts a correctly signed payload", () => {
    const body = fx("webhooks", "docs.successful_transaction.account_transfer.json");
    expect(
      monnify.verifyWebhookSignature({
        headers: { "monnify-signature": sign(body) },
        rawBody: toRawBody(body),
        secret: SECRET,
      })
    ).toBe(true);
  });

  it("rejects tampered body / wrong secret / missing header", () => {
    const body = fx("webhooks", "docs.successful_transaction.account_transfer.json");
    const tampered = Buffer.from(body.toString("utf8").replace('"amountPaid":3000', '"amountPaid":300000'));
    expect(
      monnify.verifyWebhookSignature({
        headers: { "monnify-signature": sign(body) },
        rawBody: toRawBody(tampered),
        secret: SECRET,
      })
    ).toBe(false);
    expect(
      monnify.verifyWebhookSignature({
        headers: { "monnify-signature": sign(body, "wrong") },
        rawBody: toRawBody(body),
        secret: SECRET,
      })
    ).toBe(false);
    expect(
      monnify.verifyWebhookSignature({ headers: {}, rawBody: toRawBody(body), secret: SECRET })
    ).toBe(false);
  });
});

describe("collections (SUCCESSFUL_TRANSACTION)", () => {
  it("account transfer: amountPaid gross, settlementAmount net, fee = gross - net", () => {
    const r = parseMonnifyWebhook(toRawBody(fx("webhooks", "docs.successful_transaction.account_transfer.json")));
    expect(r.kind).toBe("transaction");
    if (r.kind !== "transaction") return;
    const t = r.transaction;
    expect(t.provider).toBe("monnify");
    expect(t.providerReference).toBe("MNFY|04|20211117112842|000170");
    expect(t.dedupeKey).toBe(transactionDedupeKey("MNFY|04|20211117112842|000170"));
    expect(t.amountInKobo).toBe(300000); // 3000
    expect(t.netAmountInKobo).toBe(299000); // 2990.00
    expect(t.feeInKobo).toBe(1000); // 10
    expect(t.status).toBe("SUCCESSFUL"); // PAID
    expect(t.channel).toBe("bank_transfer"); // ACCOUNT_TRANSFER
    expect(t.direction).toBe("credit");
    expect(t.occurredAt.toISOString()).toBe("2021-11-17T10:28:42.615Z"); // WAT -> UTC
  });

  it("offline cash: DD/MM/YYYY PM timestamp, CASH -> unknown channel", () => {
    const r = parseMonnifyWebhook(toRawBody(fx("webhooks", "docs.successful_transaction.offline_cash.json")));
    if (r.kind !== "transaction") throw new Error(`expected transaction, got ${r.kind}`);
    const t = r.transaction;
    expect(t.amountInKobo).toBe(1500000); // 15000
    expect(t.netAmountInKobo).toBe(1499000); // 14990
    expect(t.feeInKobo).toBe(1000);
    expect(t.channel).toBe("unknown"); // CASH
    expect(t.occurredAt.toISOString()).toBe("2023-08-30T16:13:57.000Z");
  });

  it("REFUSES a payload where settlementAmount exceeds amountPaid (negative fee)", () => {
    const raw = JSON.parse(fx("webhooks", "docs.successful_transaction.account_transfer.json").toString("utf8"));
    raw.eventData.settlementAmount = "3001.00";
    const r = parseMonnifyWebhook(toRawBody(Buffer.from(JSON.stringify(raw))));
    expect(r.kind).toBe("parse_error");
  });
});

describe("disbursements", () => {
  it("successful: wallet debit = amount + fee, net = principal, debit direction", () => {
    const r = parseMonnifyWebhook(toRawBody(fx("webhooks", "docs.successful_disbursement.json")));
    if (r.kind !== "transaction") throw new Error(`expected transaction, got ${r.kind}`);
    const t = r.transaction;
    expect(t.dedupeKey).toBe(disbursementDedupeKey("MFDS|20210317032332|002431"));
    expect(t.amountInKobo).toBe(1800); // (10 + 8) principal+fee
    expect(t.feeInKobo).toBe(800); // 8
    expect(t.netAmountInKobo).toBe(1000); // 10 principal
    expect(t.status).toBe("SUCCESSFUL");
    expect(t.direction).toBe("debit");
    expect(t.channel).toBe("bank_transfer");
    expect(t.occurredAt.toISOString()).toBe("2021-03-17T02:23:38.000Z"); // completedOn, WAT
  });

  it("failed: FAILED status, still a debit record", () => {
    const r = parseMonnifyWebhook(toRawBody(fx("webhooks", "docs.failed_disbursement.json")));
    if (r.kind !== "transaction") throw new Error(`expected transaction, got ${r.kind}`);
    const t = r.transaction;
    expect(t.amountInKobo).toBe(1712000); // 17100 + 20
    expect(t.feeInKobo).toBe(2000);
    expect(t.netAmountInKobo).toBe(1710000);
    expect(t.status).toBe("FAILED");
    expect(t.direction).toBe("debit");
  });
});

describe("settlements", () => {
  it("SETTLEMENT: one credit with a real settlementDate; batch preserved in raw", () => {
    const r = parseMonnifyWebhook(toRawBody(fx("webhooks", "docs.settlement.json")));
    if (r.kind !== "transaction") throw new Error(`expected transaction, got ${r.kind}`);
    const t = r.transaction;
    expect(t.dedupeKey).toBe(settlementDedupeKey("LB8HG1PNZT4ATJGZXQBY"));
    expect(t.amountInKobo).toBe(119900); // 1199.00
    expect(t.feeInKobo).toBe(0);
    expect(t.direction).toBe("credit");
    expect(t.settlementDate?.toISOString()).toBe("2021-11-11T13:29:00.000Z");
  });
});

describe("rejected payments", () => {
  it("REJECTED_PAYMENT -> FAILED credit, amount = what was actually paid", () => {
    const r = parseMonnifyWebhook(toRawBody(fx("webhooks", "docs.rejected_payment.json")));
    if (r.kind !== "transaction") throw new Error(`expected transaction, got ${r.kind}`);
    const t = r.transaction;
    expect(t.amountInKobo).toBe(4000); // paymentSourceInformation.amountPaid 40
    expect(t.status).toBe("FAILED");
    expect(t.direction).toBe("credit");
    expect(t.dedupeKey).toBe(transactionDedupeKey("MNFY|85|20230626175354|041855"));
  });
});

describe("operational events -> unknown_event (never swallowed)", () => {
  it.each([
    ["docs.account_activity.json", "ACCOUNT_ACTIVITY"],
    ["docs.low_balance_alert.json", "LOW_BALANCE_ALERT"],
    ["docs.mandate_update.json", "MANDATE_UPDATE"],
  ])("%s -> unknown_event(%s)", (file, eventType) => {
    const r = parseMonnifyWebhook(toRawBody(fx("webhooks", file)));
    expect(r).toMatchObject({ kind: "unknown_event", eventType });
  });
});

describe("verify-before-value (Get Transaction Status)", () => {
  it("shares webhook identity; amountPaid gross, settlementAmount net", () => {
    const r = parseMonnifyTransaction(
      JSON.parse(fx("transactions", "docs.get_transaction_status.json").toString("utf8"))
    );
    if (r.kind !== "transaction") throw new Error(`expected transaction, got ${r.kind}`);
    const t = r.transaction;
    expect(t.dedupeKey).toBe(transactionDedupeKey("MNFY|67|20220725111957|000283"));
    expect(t.amountInKobo).toBe(10000); // 100.00
    expect(t.netAmountInKobo).toBe(9000); // 90.00
    expect(t.feeInKobo).toBe(1000);
    expect(t.channel).toBe("card");
    expect(t.status).toBe("SUCCESSFUL");
    expect(t.occurredAt.toISOString()).toBe("2022-07-25T10:20:20.000Z");
  });

  it("API-failure envelope -> parse_error with the message", () => {
    const r = parseMonnifyTransaction({ requestSuccessful: false, responseCode: 99, responseMessage: "I failed" });
    expect(r.kind).toBe("parse_error");
    if (r.kind !== "parse_error") return;
    expect(r.error.message).toContain("I failed");
  });
});

describe("timestamp resolution (explicit WAT rule)", () => {
  it("all three Monnify formats resolve; explicit zones are trusted", () => {
    expect(parseMonnifyTimestamp("2021-11-17 11:28:42.615")?.date.toISOString()).toBe("2021-11-17T10:28:42.615Z");
    expect(parseMonnifyTimestamp("17/11/2021 3:48:10 PM")?.date.toISOString()).toBe("2021-11-17T14:48:10.000Z");
    expect(parseMonnifyTimestamp("2025-09-01T23:13:19Z")?.date.toISOString()).toBe("2025-09-01T23:13:19.000Z");
    expect(parseMonnifyTimestamp("31/02/2021 1:00:00 AM")).toBeUndefined(); // invalid date
    expect(parseMonnifyTimestamp("garbage")).toBeUndefined();
  });
});

describe("hostile input", () => {
  it("never throws", () => {
    expect(parseMonnifyWebhook(toRawBody(Buffer.from("junk"))).kind).toBe("parse_error");
    expect(parseMonnifyWebhook(toRawBody(Buffer.from('{"no":"envelope"}'))).kind).toBe("parse_error");
    expect(parseMonnifyTransaction("not an object").kind).toBe("parse_error");
    expect(parseMonnifyTransaction(null).kind).toBe("parse_error");
  });
});
