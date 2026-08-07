# @pay-normalize/nomba

Nomba connector — normalizes webhooks and transaction-record API responses into `StandardizedTransaction`. The flagship connector, built from Owoore production experience.

**npm:** [@pay-normalize/nomba](https://www.npmjs.com/package/@pay-normalize/nomba) · **repo:** [github.com/lordisrael1/pay-normalize](https://github.com/lordisrael1/pay-normalize)

```bash
npm i @pay-normalize/nomba
```

> **Status: EXPERIMENTAL** (connector `version: "0.1.0"`). The signature scheme is validated **byte-for-byte against Nomba's published golden vector**, and transaction-record fixtures are **sanitized real production records**. Webhook fixtures remain docs-derived until real captures are donated; it graduates then ([NOT_DOING.md §11](../../NOT_DOING.md)).

```ts
import { nomba } from "@pay-normalize/nomba";
```

See [../../docs/INTEGRATION.md](../../docs/INTEGRATION.md) and [../../docs/SECURITY.md](../../docs/SECURITY.md).

---

## Signature

- **Headers:** `nomba-signature` (the HMAC) **and** `nomba-timestamp` (part of the signed input).
- **Scheme:** HMAC-SHA256 over a **canonical string** of 9 colon-joined fields, base64, constant-time compared.

Canonical string:
```
event_type : requestId : merchant.userId : merchant.walletId :
transaction.transactionId : transaction.type : transaction.time :
transaction.responseCode : nomba-timestamp
```
Quirks encoded: a literal `"null"` `responseCode` is treated as empty before hashing; the timestamp comes from the header (binding each delivery to its send time — hosts can reject stale timestamps to shrink the replay window). The connector extracts these fields from the parsed body and headers for you.

> ⚠️ **The amount is UNSIGNED.** The canonical string is metadata only — `transactionAmount`, `fee`, sender, and account number are outside the HMAC. Enforce TLS and confirm material credits via Nomba's lookup API. Full detail: [SECURITY.md H-2](../../docs/SECURITY.md#h-2-the-nomba-amount-is-unsigned).

---

## Events (`parseNombaWebhook`)

Status and direction are both encoded in the event name:

| Event | Status | Direction |
|---|---|---|
| `payment_success` | `SUCCESSFUL` | credit |
| `payment_failed` | `FAILED` | credit |
| `payment_reversal` | `REVERSED` | credit |
| `payout_success` | `SUCCESSFUL` | debit |
| `payout_failed` | `FAILED` | debit |
| `payout_refund` | `REVERSED` | debit |
| unrecognized | — | `unknown_event` (Nomba adds events over time) |

### Money
Webhook amounts are **naira decimal numbers** (`transactionAmount: 120`, `fee: 0.6`) → `parseNairaDecimalString`. `net = amount − fee`. Currency is `NGN` (webhooks carry no currency field). `requestId` (per-delivery UUID) maps to `providerEventId`; identity for dedupe is `transactionId` → `nomba:transaction:<transactionId>`.

---

## Transaction records (`parseNombaTransactionRecord`)

Normalizes rows from Nomba's transaction list/lookup API (`data.results[]`) — the recon-side shape. Amounts here are naira decimal **strings**.

Money model, with a checkable invariant:
```
amount        "100.0"  = principal (what the recipient receives)  -> netAmountInKobo
fixedCharge   "20.0"   = Nomba's fee, charged on top              -> feeInKobo
amountCharged "120.0"  = amount + fixedCharge = total movement    -> amountInKobo
```
Records whose money fields disagree (`amountCharged ≠ amount + fixedCharge`) become a `parse_error` — no guessing which is authoritative. `record.id` is the same identity space as the webhook's `transactionId`, so a record-sourced row reconciles against its webhook twin.

---

## Settlement files

`parseSettlementFile(buffer)` throws `UnsupportedFileFormatError`. For API-fetched transaction lists, use `parseNombaTransactionRecord` per result row.

---

## Exports

| Export | Type |
|---|---|
| `nomba` | `Connector` |
| `parseNombaWebhook` | `(rawBody) => ParseResult` |
| `parseNombaTransactionRecord` | `(record) => ParseResult` |
| `verifyNombaSignature` | `(input) => boolean` |
| `buildNombaCanonicalString` / `signNombaCanonicalString` | canonical-string helpers |
| `headerValue` | case-insensitive header lookup |
| `EVENT_MAP` | the event → status/direction table |
| `SIGNATURE_HEADER` / `TIMESTAMP_HEADER` | `"nomba-signature"` / `"nomba-timestamp"` |
| `PROVIDER` | `"nomba"` |
| `NombaSignedFields` | type of the canonical-string inputs |

Depends on `@pay-normalize/core` and `zod`.
