import { describe, it, expect } from "vitest";
import fc from "fast-check";
import {
  asKobo,
  parseKoboInteger,
  parseNairaDecimalString,
  koboToNairaString,
  AmountParseError,
  MalformedPayloadError,
  SignatureVerificationError,
  UnsupportedFileFormatError,
} from "../src/index";

/**
 * Property-based tests: fixed fixtures prove the documented cases; these
 * prove the INVARIANTS hold across the whole input space. Money math is the
 * highest-stakes pure logic in the library — a one-kobo drift here is a
 * reconciliation incident downstream.
 */

describe("money invariants (property-based)", () => {
  it("round-trips: parse(koboToNairaString(k)) === k for every valid kobo amount", () => {
    fc.assert(
      fc.property(fc.maxSafeNat(), (k) => {
        expect(parseNairaDecimalString(koboToNairaString(asKobo(k)))).toBe(k);
      })
    );
  });

  it("constructs exactly: 'W.FF' parses to W*100 + FF — no float drift anywhere in range", () => {
    fc.assert(
      fc.property(
        fc.nat({ max: 90_071_992_547_408 }), // stays under MAX_SAFE after *100
        fc.nat({ max: 99 }),
        (whole, frac) => {
          const s = `${whole}.${String(frac).padStart(2, "0")}`;
          expect(parseNairaDecimalString(s)).toBe(whole * 100 + frac);
        }
      )
    );
  });

  it("one decimal place means tens of kobo: 'W.d' parses to W*100 + d*10", () => {
    fc.assert(
      fc.property(fc.nat({ max: 1_000_000_000 }), fc.nat({ max: 9 }), (whole, d) => {
        expect(parseNairaDecimalString(`${whole}.${d}`)).toBe(whole * 100 + d * 10);
      })
    );
  });

  it("parseKoboInteger accepts every safe integer, as number and as string", () => {
    fc.assert(
      fc.property(fc.maxSafeNat(), (n) => {
        expect(parseKoboInteger(n)).toBe(n);
        expect(parseKoboInteger(String(n))).toBe(n);
      })
    );
  });

  it("rejects every negative amount with a typed, coded error", () => {
    fc.assert(
      fc.property(fc.maxSafeNat(), (n) => {
        expect(() => parseNairaDecimalString(`-${n}`)).toThrow(AmountParseError);
        expect(() => asKobo(-n - 1)).toThrow(AmountParseError);
      })
    );
  });

  it("ReDoS-safe: the formerly-quadratic whitespace inputs reject fast (< 50ms), not in seconds", () => {
    // Pre-fix these ran O(n²): 80k whitespace chars took ~7s and blocked the
    // event loop. Both must now throw AmountParseError and return promptly.
    const cases = [
      " ".repeat(100_000) + "x",
      "NGN" + " ".repeat(100_000) + "x",
      " ".repeat(50_000) + "5000.00" + " ".repeat(50_000) + "x",
    ];
    for (const bad of cases) {
      const start = performance.now();
      expect(() => parseNairaDecimalString(bad)).toThrow(AmountParseError);
      expect(performance.now() - start).toBeLessThan(50);
    }
  });

  it("length ceiling: an over-long but otherwise digit-only string is rejected", () => {
    expect(() => parseNairaDecimalString("1".repeat(41))).toThrow(AmountParseError);
    // A valid amount at a realistic length still parses.
    expect(parseNairaDecimalString("90,071,992,547,409.91")).toBe(9007199254740991);
  });

  it("trimming preserves acceptance: surrounding whitespace and ₦/NGN prefixes still parse", () => {
    expect(parseNairaDecimalString("  5000  ")).toBe(500000);
    expect(parseNairaDecimalString("₦5,000.00")).toBe(500000);
    expect(parseNairaDecimalString("₦ 5000")).toBe(500000);
    expect(parseNairaDecimalString(" NGN 5,000.50 ")).toBe(500050);
  });

  it("NEVER fails silently on hostile strings: either throws AmountParseError or returns a non-negative safe integer", () => {
    fc.assert(
      fc.property(fc.string(), (s) => {
        try {
          const kobo = parseNairaDecimalString(s);
          expect(Number.isSafeInteger(kobo)).toBe(true);
          expect(kobo).toBeGreaterThanOrEqual(0);
        } catch (e) {
          expect(e).toBeInstanceOf(AmountParseError);
          expect((e as AmountParseError).code).toBe("ERR_AMOUNT_PARSE");
        }
      })
    );
  });
});

describe("semantic error codes (observability contract)", () => {
  it("every error class carries its stable machine-readable code", () => {
    expect(new AmountParseError("x").code).toBe("ERR_AMOUNT_PARSE");
    expect(new MalformedPayloadError("x").code).toBe("ERR_MALFORMED_PAYLOAD");
    expect(new SignatureVerificationError("x").code).toBe("ERR_SIGNATURE_VERIFICATION");
    expect(new UnsupportedFileFormatError("x").code).toBe("ERR_UNSUPPORTED_FILE_FORMAT");
  });

  it("MalformedPayloadError supports narrowed codes without changing its class", () => {
    const e = new MalformedPayloadError("no timestamp", undefined, "ERR_TIMESTAMP_MISSING");
    expect(e.code).toBe("ERR_TIMESTAMP_MISSING");
    expect(e).toBeInstanceOf(MalformedPayloadError);
  });
});
