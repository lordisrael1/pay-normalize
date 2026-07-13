# Architecture

This document explains the design principles and the shared data model. For host wiring see [INTEGRATION.md](INTEGRATION.md); for the security model see [SECURITY.md](SECURITY.md).

---

## Design principles

The library is built as an **inbound anti-corruption layer** using the **Strategy pattern**: a single strict contract (`Connector`), one isolated implementation per provider.

1. **Pure.** No HTTP, no database, no clocks, no environment reads, no provider SDKs. The same input always produces the same output. Timestamps come from payloads, never from `Date.now()`.
2. **Stateless.** The library computes; the host stores. It hands you `dedupeKey` and `statusRank`; *you* enforce them against *your* database. Idempotency, ordering, retries, and queueing are host concerns.
3. **Total functions over hostile input.** Parsers never throw on bad data — they return a typed `parse_error`. A malformed payload from one provider must never crash a host's webhook endpoint (that turns one bad message into an availability incident: provider retries, you 500, every later event queues behind the poison message).
4. **Secrets are arguments.** Verification functions receive the secret per call. The library never reads, stores, or logs it.
5. **Fail loud, never guess.** No status inference, no timezone guessing, no lossy normalization. If the schema can't represent something, `rawProviderPayload` preserves it. Unknown event types surface as `unknown_event`, never swallowed.

Each connector is its own package with its own semver line: a Paystack format change is a `paystack` major bump and nobody's Nomba code moves.

```
┌─────────────┐     ┌──────────────────────────────┐     ┌──────────────────────┐
│ raw bytes   │ --> │ Connector (per provider)     │ --> │ ParseResult          │
│ + headers   │     │  verifyWebhookSignature()    │     │  transaction         │
│ + secret    │     │  parseWebhook()              │     │  | unknown_event     │
└─────────────┘     │  parseSettlementFile()       │     │  | parse_error       │
                    │  dedupeKey()                 │     └──────────────────────┘
                    └──────────────┬───────────────┘
                                   │ depends only on
                            ┌──────▼───────┐
                            │ @pn/core     │  schema · money · status · dedupe · errors
                            └──────────────┘
```

---

## The `Connector` interface

Every provider package exports a `Connector` object. Defined in [`packages/core/src/connector/interface.ts`](../packages/core/src/connector/interface.ts):

```ts
interface Connector {
  readonly provider: string;   // 'paystack' | 'nomba' | 'flutterwave'
  readonly version: string;    // connector maturity, currently '0.1.0' (experimental)

  verifyWebhookSignature(input: {
    headers: Record<string, string | string[] | undefined>;
    rawBody: RawBody;
    secret: string;
  }): boolean;

  parseWebhook(rawBody: RawBody): ParseResult;
  parseSettlementFile(file: Buffer): SettlementFileParseResult;
  dedupeKey(txn: StandardizedTransaction): string;
}
```

`verifyWebhookSignature` returns a boolean rather than throwing — an unverified request is a routine hostile-internet event (respond 401), not an exceptional program state. `parseSettlementFile` throws `UnsupportedFileFormatError` only when the *file format itself* is unknown (a version/config problem), which is distinct from a malformed *row* (a data problem that becomes a `parse_error`).

---

## The output: `StandardizedTransaction`

The single shape every connector produces. Defined in [`packages/core/src/schema/transaction.ts`](../packages/core/src/schema/transaction.ts) and validated at runtime by `validateTransaction()` (a Zod schema) before it leaves the library.

| Field | Type | Notes |
|---|---|---|
| `dedupeKey` | `string` | Deterministic identity for idempotency. See below. |
| `provider` | `string` | Lowercase, `^[a-z0-9_-]+$`. |
| `providerReference` | `string` | The provider's own transaction reference. |
| `providerEventId?` | `string` | Per-*delivery* id when the provider sends one — distinguishes redelivery of one event from two events about one transaction. |
| `amountInKobo` | `Kobo` | Integer minor units. Branded — a plain `number` won't typecheck here. |
| `feeInKobo` | `Kobo` | Provider fee in minor units. |
| `netAmountInKobo` | `Kobo` | **Enforced invariant:** must equal `amountInKobo - feeInKobo`. |
| `currency` | `string` | ISO-4217 uppercase. Non-NGN is tagged and passed through — no FX. |
| `status` | `TransactionStatus` | `PENDING` \| `FAILED` \| `SUCCESSFUL` \| `REVERSED`. |
| `channel` | `PaymentChannel` | `card` \| `bank_transfer` \| `ussd` \| `qr` \| `wallet` \| `pos` \| `unknown`. |
| `direction` | `'credit' \| 'debit'` | Money in vs. money out. Parsing a debit ≠ initiating one. |
| `occurredAt` | `Date` | When the provider says it happened. **Never use for ordering** (clock skew) — use `STATUS_RANK`. |
| `occurredAtRaw?` | `string` | The provider's original timestamp string, verbatim, for audit. |
| `settlementDate` | `Date \| null` | Present when the payload/file carries one; crucial for recon. |
| `rawProviderPayload` | `unknown` | The untouched payload. The non-lossy escape hatch. **Contains PII** — host owns encryption-at-rest and retention. |

**Schema versioning contract:** v1 fields are frozen. Additions ship as optional fields in minor versions; renames/removals are v2 and a new major of every package.

---

## Money: the `Kobo` model

Money is **integer minor units only**, never a float. IEEE-754 turns `"5000.10"` into `500009.999…`; this library never lets that happen. `Kobo` is a branded type (`number & { __brand: "Kobo" }`) so an unconverted provider amount cannot leak past the connector boundary — it won't typecheck.

Conversion happens exactly once, at the connector boundary, via [`packages/core/src/schema/money.ts`](../packages/core/src/schema/money.ts):

| Function | Input | Use |
|---|---|---|
| `asKobo(n)` | already-integer number | Assert a value is valid `Kobo` (e.g. a literal `0` fee). |
| `parseKoboInteger(v)` | `number \| string` integer | Provider sends kobo integers (Paystack). Rejects decimals. |
| `parseNairaDecimalString(v)` | `number \| string` decimal | Provider sends main-unit decimals (Nomba, Flutterwave). BigInt string math, ×100. |
| `koboToNairaString(k)` | `Kobo` | Display helper. **Never** feed its output back into parsing. |

All parsing uses **BigInt/string math** and rejects negatives, >2 decimal places, scientific notation, and (since the ReDoS hardening) over-long inputs. The **amount-convention census** across providers — the reason this is centralized:

| Provider | Amount shape | Parser |
|---|---|---|
| Paystack | kobo integers (`10000`) | `parseKoboInteger` |
| Nomba webhook | naira decimal *numbers* (`120`, `0.6`) | `parseNairaDecimalString` |
| Nomba records | naira decimal *strings* (`"100.0"`) | `parseNairaDecimalString` |
| Flutterwave | main-unit decimals, multi-currency (`2000`, `1500.25`) | `parseNairaDecimalString` |
| Monnify | naira decimals as numbers *or* strings (`3000`, `"2990.00"`) | `parseNairaDecimalString` |

Non-NGN amounts (KES, USD…) are tagged in `currency` and passed through untouched — `×100` is correct for any 2-minor-digit ISO currency, and there is no FX conversion anywhere (see [NOT_DOING.md §10](../NOT_DOING.md)).

---

## Status ordering: `STATUS_RANK`

Webhooks arrive **out of order** (retries + parallel delivery paths). A `pending` emitted at T0 can arrive *after* the `successful` emitted at T1. You cannot fix this with timestamps — provider clocks skew. You fix it with a deterministic rank. Defined in [`packages/core/src/schema/status.ts`](../packages/core/src/schema/status.ts):

```
PENDING (0)  <  FAILED (1)  <  SUCCESSFUL (2)  <  REVERSED (3)
```

```ts
shouldApplyStatusTransition(current, incoming): boolean // = rank(incoming) > rank(current)
```

- `REVERSED` outranks `SUCCESSFUL` deliberately — refunds/chargebacks are a legitimate forward progression.
- `FAILED → SUCCESSFUL` is allowed (some providers emit a failure then succeed on internal retry under the same reference).
- Equal rank returns `false` — redelivery of the same status is a no-op (idempotency).

The host applies this when upserting; see [INTEGRATION.md](INTEGRATION.md).

---

## Identity: `dedupeKey`

Webhook delivery is at-least-once everywhere. The only reliable defense is idempotent ingestion keyed on a deterministic identity. `composeDedupeKey(provider, reference)` produces `${provider}:${reference}`, namespaced so Paystack ref `TX123` and Nomba ref `TX123` never collide. Connectors add a family namespace, e.g.:

- `paystack:charge:<reference>` — a charge **and its later refund share this key**, so the refund lands as a `SUCCESSFUL → REVERSED` transition on one row.
- `nomba:transaction:<transactionId>` — a webhook and its transaction-record twin share identity and reconcile into one row.
- `flutterwave:charge:<chargeId>` — webhook-sourced and retrieve-sourced rows upsert together.

**The database unique index is the lock** (`CREATE UNIQUE INDEX … ON transactions (dedupe_key)`), not application code — two workers processing the same redelivered webhook will both pass a naive "does it exist?" check.

---

## The result: `ParseResult`

Every parse returns a discriminated union — never `null`, never a throw (defined in [`packages/core/src/connector/result.ts`](../packages/core/src/connector/result.ts)):

```ts
type ParseResult =
  | { kind: "transaction";   transaction: StandardizedTransaction }
  | { kind: "unknown_event"; provider: string; eventType: string; raw: unknown }
  | { kind: "parse_error";   provider: string; error: MalformedPayloadError | AmountParseError; raw: unknown };
```

Settlement/file parsing returns `SettlementFileParseResult` — row-isolated, so one mangled row yields one `parse_error` while the rest normalize, plus a `summary` of counts by outcome.

---

## The error model

Typed errors with **stable machine-readable codes** — route on `error.code`, never on `error.message` (messages may be reworded in a patch release). Defined in [`packages/core/src/errors.ts`](../packages/core/src/errors.ts):

| Class | `code` | Meaning |
|---|---|---|
| `SignatureVerificationError` | `ERR_SIGNATURE_VERIFICATION` | Signature missing/malformed/mismatch. Host → 401. |
| `MalformedPayloadError` | `ERR_MALFORMED_PAYLOAD` | Not JSON, missing fields, wrong shapes. |
| `MalformedPayloadError` | `ERR_TIMESTAMP_MISSING` | Narrowed: no usable timestamp (drives the Flutterwave `…At` overload). |
| `AmountParseError` | `ERR_AMOUNT_PARSE` | Amount couldn't be safely converted to `Kobo`. |
| `UnsupportedFileFormatError` | `ERR_UNSUPPORTED_FILE_FORMAT` | The file format itself is unknown. |

All extend `NormalizationError`, which carries `code: NormalizationErrorCode`. Connectors throw these only inside their own boundary; `parseWebhook`/`parseSettlementFile` catch them and return `parse_error` results.

---

## Verify-before-value

Webhooks are a *hint* that something happened, not proof. Before releasing value, the host re-queries the provider's API and normalizes the response through a dedicated parser that shares the webhook's `dedupeKey`:

| Provider | Verify parser | Notes |
|---|---|---|
| Paystack | `parsePaystackVerification` | `GET /transaction/verify/:reference` response. |
| Flutterwave | `parseFlutterwaveCharge` / `parseFlutterwaveChargeAt` | Retrieve-charge; the `…At` overload supplies a host fetch time when the response omits a timestamp. |
| Flutterwave | `parseFlutterwaveSettlement` / `…List` | Settlement API; enforces `net = gross − Σfees`. |
| Nomba | `parseNombaTransactionRecord` | Transaction list/lookup rows; enforces `amountCharged = amount + fixedCharge`. |
| Monnify | `parseMonnifyTransaction` | Get-Transaction-Status response; `net = amountPaid − settlementAmount`. |

The library never makes the API call itself — the host owns the HTTP and its credentials. See [INTEGRATION.md](INTEGRATION.md#verify-before-value).
