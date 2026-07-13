import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { rawBodyFromString, toRawBody } from "@pay-normalize/core";
import {
  buildNombaCanonicalString,
  signNombaCanonicalString,
  verifyNombaSignature,
} from "../src/signature";
import { nomba } from "../src/index";

/**
 * GOLDEN VECTOR — from Nomba's own documentation worked example.
 * If this test ever fails, either the implementation regressed or Nomba
 * changed nomba-signature-version. Either way: stop the line.
 */
const GOLDEN = {
  fields: {
    eventType: "payment_success",
    requestId: "45f2dc2d-d559-4773-bba3-2d5ec17b2e20",
    merchantUserId: "b7b10e81-e57d-41d0-8fdc-f4e23a132bbf",
    merchantWalletId: "6756ff80aafe04a795f18b38",
    transactionId: "API-VACT_TRA-B7B10-0435b274-807a-4bc7-8abe-9dbb4548fd7a",
    transactionType: "vact_transfer",
    transactionTime: "2025-09-29T10:51:44Z",
    responseCode: "",
    nombaTimestamp: "2025-09-29T10:51:44Z",
  },
  secret: "HkatexKDZg7CLWy96q5sfrVHSvtoz92B",
  expectedSignature: "Kt9095hQxfgmVbx6iz7G2tPhHdbdXgLlyY/mf35sptw=",
};

describe("golden vector (Nomba's published worked example)", () => {
  it("reproduces their expected signature byte-for-byte", () => {
    const canonical = buildNombaCanonicalString(GOLDEN.fields);
    expect(signNombaCanonicalString(canonical, GOLDEN.secret)).toBe(GOLDEN.expectedSignature);
  });

  it("verifies end-to-end through the Connector interface using the doc payload fixture", () => {
    const rawBody = toRawBody(
      readFileSync(join(__dirname, "..", "fixtures", "webhooks", "docs.payment_success.json"))
    );
    expect(
      nomba.verifyWebhookSignature({
        headers: {
          "Nomba-Signature": GOLDEN.expectedSignature, // mixed case on purpose
          "nomba-timestamp": GOLDEN.fields.nombaTimestamp,
        },
        rawBody,
        secret: GOLDEN.secret,
      })
    ).toBe(true);
  });
});

describe("canonical string rules", () => {
  it('treats responseCode literal "null" as empty (their reference implementation rule)', () => {
    const a = buildNombaCanonicalString({ ...GOLDEN.fields, responseCode: "null" });
    const b = buildNombaCanonicalString({ ...GOLDEN.fields, responseCode: "" });
    expect(a).toBe(b);
  });

  it("binds the delivery timestamp — same event re-sent with a new nomba-timestamp signs differently", () => {
    const sig1 = signNombaCanonicalString(buildNombaCanonicalString(GOLDEN.fields), GOLDEN.secret);
    const sig2 = signNombaCanonicalString(
      buildNombaCanonicalString({ ...GOLDEN.fields, nombaTimestamp: "2025-09-29T11:51:44Z" }),
      GOLDEN.secret
    );
    expect(sig1).not.toBe(sig2);
  });
});

describe("rejection cases", () => {
  it("rejects tampering with any SIGNED field", () => {
    expect(
      verifyNombaSignature({
        signedFields: { ...GOLDEN.fields, transactionId: "API-VACT_TRA-FORGED" },
        providedSignature: GOLDEN.expectedSignature,
        secret: GOLDEN.secret,
      })
    ).toBe(false);
  });

  it("rejects wrong secret / missing signature / missing timestamp header", () => {
    expect(
      verifyNombaSignature({
        signedFields: GOLDEN.fields,
        providedSignature: GOLDEN.expectedSignature,
        secret: "wrong",
      })
    ).toBe(false);
    const rawBody = rawBodyFromString("{}");
    expect(
      nomba.verifyWebhookSignature({ headers: { "nomba-timestamp": "t" }, rawBody, secret: "s" })
    ).toBe(false);
    expect(
      nomba.verifyWebhookSignature({ headers: { "nomba-signature": "x" }, rawBody, secret: "s" })
    ).toBe(false);
  });
});

describe("⚠️ THE UNSIGNED-AMOUNT FINDING", () => {
  it("tampering the transactionAmount 12,000x STILL VERIFIES — the amount is outside the signature", () => {
    const original = JSON.parse(
      readFileSync(
        join(__dirname, "..", "fixtures", "webhooks", "docs.payment_success.json"),
        "utf8"
      )
    );
    original.data.transaction.transactionAmount = 120000; // was 10 (naira)
    original.data.transaction.fee = 0; // and zero the fee while we're at it
    original.data.customer.senderName = "TOTALLY LEGIT SENDER"; // also unsigned

    expect(
      nomba.verifyWebhookSignature({
        headers: {
          "nomba-signature": GOLDEN.expectedSignature,
          "nomba-timestamp": GOLDEN.fields.nombaTimestamp,
        },
        rawBody: rawBodyFromString(JSON.stringify(original)),
        secret: GOLDEN.secret,
      })
    ).toBe(true);
    // This passing test IS the documentation: TLS authenticates the amount,
    // the signature does not. For material credits, confirm via transaction
    // lookup before releasing value. See signature.ts.
  });
});
