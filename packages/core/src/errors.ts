/**
 * Typed errors so hosts can route failures without string-matching messages.
 * Connectors throw these ONLY inside their own boundary; parseWebhook /
 * parseSettlementFile catch them and return `parse_error` results instead
 * (see connector/result.ts) — a malformed payload from one provider must never
 * crash a host's webhook endpoint (that would turn one bad payload into an
 * availability incident: the provider retries, you 500, backoff kicks in,
 * and every later event for that endpoint queues behind the poison message).
 */

/**
 * Machine-readable error codes — stable API, unlike messages, which may be
 * reworded in a PATCH release. Route on `error.code` (or instanceof), never
 * on `error.message`.
 */
export type NormalizationErrorCode =
  | "ERR_SIGNATURE_VERIFICATION"
  | "ERR_MALFORMED_PAYLOAD"
  | "ERR_AMOUNT_PARSE"
  | "ERR_UNSUPPORTED_FILE_FORMAT"
  | "ERR_TIMESTAMP_MISSING";

export class NormalizationError extends Error {
  constructor(message: string, public readonly code: NormalizationErrorCode) {
    super(message);
    this.name = new.target.name;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Signature header missing, malformed, or HMAC mismatch. Host should respond 401 and NOT process. */
export class SignatureVerificationError extends NormalizationError {
  constructor(message: string, public readonly provider?: string) {
    super(message, "ERR_SIGNATURE_VERIFICATION");
  }
}

/**
 * Payload structurally unusable: not JSON, missing required fields, wrong
 * shapes. `code` may be narrowed (e.g. ERR_TIMESTAMP_MISSING) when the defect
 * is specific enough for a host — or a caller — to act on programmatically.
 */
export class MalformedPayloadError extends NormalizationError {
  constructor(
    message: string,
    public readonly raw?: unknown,
    code: NormalizationErrorCode = "ERR_MALFORMED_PAYLOAD"
  ) {
    super(message, code);
  }
}

/** Amount could not be converted to Kobo safely. Carries the offending input for logs. */
export class AmountParseError extends NormalizationError {
  constructor(message: string, public readonly input?: unknown) {
    super(message, "ERR_AMOUNT_PARSE");
  }
}

/** Settlement/statement file is not a format this connector version supports. */
export class UnsupportedFileFormatError extends NormalizationError {
  constructor(message: string, public readonly provider?: string) {
    super(message, "ERR_UNSUPPORTED_FILE_FORMAT");
  }
}
