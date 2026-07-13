import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
import { rawBodyFromString } from "@pay-normalize/core";
import { verifyPaystackSignature, SIGNATURE_HEADER } from "../src/signature";

const SECRET = "sk_test_notarealkey";

function sign(body: string, secret = SECRET): string {
  return createHmac("sha512", secret).update(Buffer.from(body, "utf8")).digest("hex");
}

describe("verifyPaystackSignature", () => {
  const body = '{"event":"charge.success","data":{"reference":"qTPrJoy9Bx","amount":10000}}';

  it("accepts a correctly signed payload", () => {
    expect(
      verifyPaystackSignature({
        headers: { [SIGNATURE_HEADER]: sign(body) },
        rawBody: rawBodyFromString(body),
        secret: SECRET,
      })
    ).toBe(true);
  });

  it("is case-insensitive on the header name (proxies love re-casing)", () => {
    expect(
      verifyPaystackSignature({
        headers: { "X-Paystack-Signature": sign(body) },
        rawBody: rawBodyFromString(body),
        secret: SECRET,
      })
    ).toBe(true);
  });

  it("rejects a tampered body — even one flipped digit", () => {
    const tampered = body.replace('"amount":10000', '"amount":10001');
    expect(
      verifyPaystackSignature({
        headers: { [SIGNATURE_HEADER]: sign(body) },
        rawBody: rawBodyFromString(tampered),
        secret: SECRET,
      })
    ).toBe(false);
  });

  it("rejects wrong secret, missing header, empty secret", () => {
    expect(
      verifyPaystackSignature({
        headers: { [SIGNATURE_HEADER]: sign(body, "sk_wrong") },
        rawBody: rawBodyFromString(body),
        secret: SECRET,
      })
    ).toBe(false);
    expect(
      verifyPaystackSignature({ headers: {}, rawBody: rawBodyFromString(body), secret: SECRET })
    ).toBe(false);
    expect(
      verifyPaystackSignature({
        headers: { [SIGNATURE_HEADER]: sign(body) },
        rawBody: rawBodyFromString(body),
        secret: "",
      })
    ).toBe(false);
  });

  it("tolerates array header values (duplicated headers)", () => {
    expect(
      verifyPaystackSignature({
        headers: { [SIGNATURE_HEADER]: [sign(body), "garbage"] },
        rawBody: rawBodyFromString(body),
        secret: SECRET,
      })
    ).toBe(true);
  });

  it("demonstrates WHY raw bytes matter: stringify(parse(body)) can diverge from the signed bytes", () => {
    // Same JSON value, different bytes: whitespace differs.
    const bodyWithSpaces = '{ "event": "charge.success", "data": { "reference": "qTPrJoy9Bx", "amount": 10000 } }';
    const signature = sign(bodyWithSpaces); // Paystack signs THESE bytes
    // A host that re-serializes the parsed body gets different bytes...
    const restringified = JSON.stringify(JSON.parse(bodyWithSpaces));
    expect(restringified).not.toBe(bodyWithSpaces);
    // ...and verification against restringified bytes fails:
    expect(
      verifyPaystackSignature({
        headers: { [SIGNATURE_HEADER]: signature },
        rawBody: rawBodyFromString(restringified),
        secret: SECRET,
      })
    ).toBe(false);
    // while verification over the actual raw bytes succeeds:
    expect(
      verifyPaystackSignature({
        headers: { [SIGNATURE_HEADER]: signature },
        rawBody: rawBodyFromString(bodyWithSpaces),
        secret: SECRET,
      })
    ).toBe(true);
  });
});
