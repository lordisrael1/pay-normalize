# @pay-normalize/paystack

Paystack connector — normalizes webhooks and verify-transaction responses into `StandardizedTransaction`.

> **Status: EXPERIMENTAL** (connector `version: "0.1.0"`). Fixtures are derived from Paystack's published documentation, not captured production traffic. Per [NOT_DOING.md §11](../../NOT_DOING.md), it graduates when the corpus contains sanitized real payloads.

```ts
import { paystack } from "@pay-normalize/paystack";
```

See [../../docs/INTEGRATION.md](../../docs/INTEGRATION.md) for the full host flow and [../../docs/SECURITY.md](../../docs/SECURITY.md) for the signature model.

---

## Signature

- **Header:** `x-paystack-signature`
- **Scheme:** HMAC-SHA512 over the **raw body**, hex, constant-time compared.
- Secret is your Paystack secret key, passed as an argument.

```ts
const ok = paystack.verifyWebhookSignature({ headers: req.headers, rawBody, secret });
```

---

## Events

`parseWebhook(rawBody)` routes Paystack's event list:

| Event | Result | Direction / status |
|---|---|---|
| `charge.success` | `transaction` | credit; status from the 8-status vocabulary |
| `transfer.success` / `.failed` / `.reversed` | `transaction` | debit; status encoded by the event name |
| `refund.processed` | `transaction` | `REVERSED` on the **original charge's** `dedupeKey` |
| `subscription.*`, `invoice.*`, `dispute.*`, `dedicatedaccount.*`, `refund.pending/processing/failed`, … | `unknown_event` | recognized, surfaced, never swallowed |
| anything else | `unknown_event` | forward-compatible |

### Status vocabulary
Paystack's 8 documented statuses map explicitly (no inference): `success → SUCCESSFUL`; `failed`/`abandoned → FAILED`; `reversed → REVERSED`; `pending`/`processing`/`queued`/`ongoing → PENDING`. Anything outside the table becomes a `parse_error`. `abandoned → FAILED` combined with the `FAILED → SUCCESSFUL` rank rule cleanly handles a pay-with-transfer that completes late.

### Money
Charge amounts and fees arrive **already in kobo** (`parseKoboInteger`). `net = amount − fees`. Transfer webhooks don't reliably carry the fee, so `fee = 0` there and the true fee reconciles from the settlement export (documented, not guessed).

### Identity
`chargeDedupeKey(reference)` → `paystack:charge:<reference>`. A charge and its refund share this key, so the refund lands as a `SUCCESSFUL → REVERSED` transition. Transfers use `paystack:transfer:<reference>`.

---

## Verify-before-value

`parsePaystackVerification(response)` normalizes a `GET /transaction/verify/:reference` response. It shares the webhook's `dedupeKey`, so verify-sourced and webhook-sourced rows upsert into one. Money model: `amount − fees = requested_amount` (the schema invariant is Paystack's arithmetic). This is also the missing-money backfill path when a webhook was never delivered.

```ts
const result = parsePaystackVerification(apiResponse);
if (result.kind === "transaction" && result.transaction.status === "SUCCESSFUL") { /* fulfil */ }
```

---

## Settlement files

`parseSettlementFile(buffer)` throws `UnsupportedFileFormatError` (`ERR_UNSUPPORTED_FILE_FORMAT`) until a sanitized real CSV export exists in fixtures to pin the column layout.

---

## Exports

| Export | Type |
|---|---|
| `paystack` | `Connector` |
| `verifyPaystackSignature` | `(input) => boolean` |
| `parsePaystackWebhook` | `(rawBody) => ParseResult` |
| `parsePaystackVerification` | `(response) => ParseResult` |
| `chargeDedupeKey` | `(reference) => string` |
| `SIGNATURE_HEADER` | `"x-paystack-signature"` |
| `PROVIDER` | `"paystack"` |

Depends on `@pay-normalize/core` and `zod`.
