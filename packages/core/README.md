# @pay-normalize/core

The contract. Every connector depends on this package and nothing else; hosts import the shared types, the money helpers, and the ordering/dedupe primitives from here.

- Data model & design rationale: [../../docs/ARCHITECTURE.md](../../docs/ARCHITECTURE.md)
- Host wiring: [../../docs/INTEGRATION.md](../../docs/INTEGRATION.md)

```ts
import {
  validateTransaction, type StandardizedTransaction,
  parseNairaDecimalString, parseKoboInteger, asKobo, koboToNairaString, type Kobo,
  shouldApplyStatusTransition, STATUS_RANK, statusRank, type TransactionStatus,
  type PaymentChannel,
  composeDedupeKey,
  toRawBody, rawBodyFromString, type RawBody,
  type Connector, type ParseResult, type SettlementFileParseResult, summarizeRows,
  NormalizationError, MalformedPayloadError, AmountParseError,
  SignatureVerificationError, UnsupportedFileFormatError, type NormalizationErrorCode,
} from "@pay-normalize/core";
```

---

## Schema

### `StandardizedTransaction`
The single output shape of every connector. Full field table in [ARCHITECTURE.md](../../docs/ARCHITECTURE.md#the-output-standardizedtransaction). Key invariant, enforced at runtime: `netAmountInKobo === amountInKobo - feeInKobo`.

### `validateTransaction(input: unknown): StandardizedTransaction`
Runtime gate (Zod) every connector output passes through before leaving the library. Throws a `ZodError` if the shape or the money invariant is violated — this is an internal guard, so a connector bug surfaces loudly rather than emitting a bad row.

### `StandardizedTransactionSchema`
The Zod schema itself, exported for hosts that want to re-validate at their own boundary.

---

## Money

Integer minor units only; conversion happens once, at the connector boundary, with BigInt/string math. `Kobo` is a branded `number` so unconverted amounts can't leak.

| Export | Signature | Notes |
|---|---|---|
| `asKobo` | `(value: number) => Kobo` | Assert an already-integer, non-negative value is `Kobo`. Throws `AmountParseError` otherwise. |
| `parseKoboInteger` | `(input: number \| string) => Kobo` | For providers that send kobo integers. Rejects decimals and values over `MAX_SAFE_INTEGER`. |
| `parseNairaDecimalString` | `(input: string \| number) => Kobo` | For main-unit decimals (`"5,000.00"`, `5000`, `1500.25`, `"₦5000"`). Rejects negatives, >2dp, scientific notation, and over-long input. |
| `koboToNairaString` | `(kobo: Kobo) => string` | Display only. Never feed back into parsing. |

```ts
parseKoboInteger(10000);           // 10000 (already kobo)
parseNairaDecimalString(120);      // 12000
parseNairaDecimalString("1500.25");// 150025  (no float drift)
asKobo(0);                         // 0
```

---

## Status ordering

`TransactionStatus = "PENDING" | "FAILED" | "SUCCESSFUL" | "REVERSED"`, ranked `0 < 1 < 2 < 3`.

| Export | Signature | Notes |
|---|---|---|
| `STATUS_RANK` | `Readonly<Record<TransactionStatus, number>>` | Frozen rank map. |
| `statusRank` | `(status) => number` | Rank lookup. |
| `shouldApplyStatusTransition` | `(current, incoming) => boolean` | `true` iff `rank(incoming) > rank(current)`. Equal rank → `false` (idempotent redelivery). |

Use it in your upsert to make out-of-order and duplicate delivery safe. See [INTEGRATION.md §4b](../../docs/INTEGRATION.md#4b-a-rank-guard-on-status--for-out-of-order-delivery).

---

## Dedupe identity

| Export | Signature | Notes |
|---|---|---|
| `composeDedupeKey` | `(provider: string, reference: string) => string` | Returns `${provider}:${reference}` (provider lowercased, both trimmed). Throws on empty input. |

Connectors namespace the reference by family (`charge:…`, `transfer:…`, `transaction:…`) so a charge and its refund, or a webhook and its API-record twin, share one key. The host enforces uniqueness with a DB index.

---

## Raw body

| Export | Signature | Notes |
|---|---|---|
| `RawBody` | `Buffer & { __brand: "RawBody" }` | Branded — only way to satisfy `verifyWebhookSignature`. |
| `toRawBody` | `(buf: Buffer) => RawBody` | Production path. Throws `TypeError` if not a `Buffer`. |
| `rawBodyFromString` | `(s: string, enc?) => RawBody` | Tests / fixture replay only. |

---

## Connector & results

| Export | Notes |
|---|---|
| `Connector` | The interface every provider package implements. See [ARCHITECTURE.md](../../docs/ARCHITECTURE.md#the-connector-interface). |
| `ParseResult` | `transaction \| unknown_event \| parse_error`. Never `null`, never a throw. |
| `SettlementFileParseResult` | Row-isolated file result with a `summary` of counts. |
| `summarizeRows` | `(rows: ParseResult[]) => summary` | Counts by outcome. |

---

## Errors

All extend `NormalizationError` and carry a stable `code: NormalizationErrorCode` — **route on `code`, not `message`.**

| Class | `code` |
|---|---|
| `SignatureVerificationError` | `ERR_SIGNATURE_VERIFICATION` |
| `MalformedPayloadError` | `ERR_MALFORMED_PAYLOAD` (or narrowed `ERR_TIMESTAMP_MISSING`) |
| `AmountParseError` | `ERR_AMOUNT_PARSE` |
| `UnsupportedFileFormatError` | `ERR_UNSUPPORTED_FILE_FORMAT` |

```ts
if (result.kind === "parse_error" && result.error.code === "ERR_TIMESTAMP_MISSING") {
  // retry via the fetch-time overload
}
```

---

## Dependencies

`zod` (runtime validation). Node 18+, ESM.
