# @pay-normalize/monnify

Monnify (Moniepoint) connector — normalizes webhooks and the Get-Transaction-Status API response into `StandardizedTransaction`.

**npm:** [@pay-normalize/monnify](https://www.npmjs.com/package/@pay-normalize/monnify) · **repo:** [github.com/lordisrael1/pay-normalize](https://github.com/lordisrael1/pay-normalize)

```bash
npm i @pay-normalize/monnify
```

> **Status: EXPERIMENTAL** (connector `version: "0.1.0"`). Fixtures are docs-derived. Graduation needs sanitized real captures **with headers and exact bytes** — see the signature caveat below ([NOT_DOING.md §11](../../NOT_DOING.md)).

```ts
import { monnify } from "@pay-normalize/monnify";
```

See [../../docs/INTEGRATION.md](../../docs/INTEGRATION.md) and [../../docs/SECURITY.md](../../docs/SECURITY.md).

---

## Signature

- **Header:** `monnify-signature`
- **Scheme:** HMAC-SHA512 over the **raw body**, hex, keyed by your **client secret**, constant-time compared.

Monnify's docs contradict themselves twice: their prose says `SHA-512(secret + body)` (not HMAC), and their Node sample HMACs a **pretty-printed** body. Neither reproduces their own published golden hash. Computing all candidates against their documented example proves the real scheme is **HMAC-SHA512 over the compact JSON body**. The connector verifies over raw bytes (correct if Monnify transmits the bytes it signed); a golden-vector test pins the hash byte-for-byte.

> **Graduation caveat:** the wire serialization is unconfirmed without a real captured delivery. If Monnify ever transmits pretty-printed bytes while signing compact ones, verification would fail and the fix is to reconstruct the compact form — a one-liner plus a fixture. **Capture headers and exact bytes when donating fixtures.**

---

## Events (`parseMonnifyWebhook`)

| `eventType` | Result | Model |
|---|---|---|
| `SUCCESSFUL_TRANSACTION` | `transaction` (credit) | Collection: `amount = amountPaid`, `net = settlementAmount`, `fee = amountPaid − settlementAmount` |
| `SUCCESSFUL_DISBURSEMENT` | `transaction` (debit, `SUCCESSFUL`) | Payout: `amount = principal + fee`, `fee = fee`, `net = principal` |
| `FAILED_DISBURSEMENT` | `transaction` (debit, `FAILED`) | Same shape as above |
| `SETTLEMENT` | `transaction` (credit, `SUCCESSFUL`) | One credit for a batch; carries a real `settlementDate`; batch rides in raw |
| `REJECTED_PAYMENT` | `transaction` (credit, `FAILED`) | `amount =` what was actually paid; rejection detail in raw |
| `MANDATE_UPDATE`, `ACCOUNT_ACTIVITY`, `LOW_BALANCE_ALERT` | `unknown_event` | Real notifications, not customer money movement |
| anything else | `unknown_event` | Forward-compatible |

### Money
Amounts are naira decimals as **numbers** (`amountPaid: 3000`) or **strings** (`"1234.00"`) → `parseNairaDecimalString`. Collection fee is derived as gross minus settlement; a `settlementAmount` greater than `amountPaid` (negative fee) is refused as a `parse_error`, never a guess. Disbursements follow the Nomba payout shape (fee charged on top; total debit = principal + fee).

### Timestamps
Three formats appear, mostly **unlabeled**: `YYYY-MM-DD HH:mm:ss.SSS`, `DD/MM/YYYY h:mm:ss AM/PM`, and ISO-8601 with an explicit zone. The explicit per-provider rule: unlabeled timestamps are **WAT (UTC+01:00)**; explicit-zone strings are trusted as-is. The original string is preserved in `occurredAtRaw`; never order on `occurredAt` (use `STATUS_RANK`). Invalid dates (e.g. `31/02`) are rejected. *WAT assumption needs confirmation against real captures.*

### Identity
- Collections & rejected payments → `monnify:transaction:<transactionReference>`
- Disbursements → `monnify:disbursement:<transactionReference>`
- Settlements → `monnify:settlement:<settlementReference>`

---

## Verify-before-value

`parseMonnifyTransaction(response)` normalizes a Get-Transaction-Status response (`GET /api/v2/transactions/:reference` or `/api/v2/merchant/transactions/query`). It shares the webhook's `dedupeKey`, so verify- and webhook-sourced rows upsert into one — and it's the missing-money backfill path. Same money model as a collection. API-failure envelopes (`requestSuccessful: false`) become a `parse_error`.

---

## Settlement files

`parseSettlementFile(buffer)` throws `UnsupportedFileFormatError` — export parsing isn't fixture-verified. Use `parseMonnifyTransaction` for API data.

---

## Exports

| Export | Type |
|---|---|
| `monnify` | `Connector` |
| `parseMonnifyWebhook` | `(rawBody) => ParseResult` |
| `parseMonnifyTransaction` | `(response) => ParseResult` |
| `verifyMonnifySignature` | `(input) => boolean` |
| `parseMonnifyTimestamp` | the three-format WAT resolver |
| `mapCollectionStatus` / `mapDisbursementStatus` / `mapPaymentMethod` | mapping tables |
| `transactionDedupeKey` / `disbursementDedupeKey` / `settlementDedupeKey` | identity helpers |
| `SIGNATURE_HEADER` | `"monnify-signature"` |
| `PROVIDER` | `"monnify"` |

Depends on `@pay-normalize/core` and `zod`.
