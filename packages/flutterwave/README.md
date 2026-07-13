# @pay-normalize/flutterwave

Flutterwave **v4** connector — normalizes webhooks, retrieve-charge responses, and settlement API responses into `StandardizedTransaction`.

> **Status: EXPERIMENTAL** (connector `version: "0.1.0"`). The signature scheme is confirmed against Flutterwave's authoritative docs and the connector matches it, but fixtures are docs-derived. Graduation still wants one real signed delivery **with headers** ([NOT_DOING.md §11](../../NOT_DOING.md)).

```ts
import { flutterwave } from "@pay-normalize/flutterwave";
```

See [../../docs/INTEGRATION.md](../../docs/INTEGRATION.md) and [../../docs/SECURITY.md](../../docs/SECURITY.md).

---

## Signature

- **Header:** `flutterwave-signature`
- **Scheme:** HMAC-SHA256 over the **raw body**, base64, constant-time compared.
- Secret is your dashboard **secret hash**, passed as an argument.

Flutterwave's docs contain a self-contradiction (one inline sample compares the header directly to the plain secret). The connector implements the authoritative HMAC scheme; a test pins that the plain-secret comparison correctly fails. See [SECURITY.md](../../docs/SECURITY.md#flutterwave--scheme-confirmed).

---

## Webhooks (`parseFlutterwaveWebhook`)

Handles `charge.completed`; other event types (`transfer.completed`, refunds, future types) surface as `unknown_event`.

Notable payload quirks the connector absorbs:

- **Delivery id field varies:** `id` on mobile_money deliveries, `webhook_id` on card / bank_transfer deliveries. Both are accepted → `providerEventId`.
- **`created_datetime` changes type between samples:** ISO-8601 string in one, float epoch **seconds** (`1735116842.116`) in another, while the envelope `timestamp` is epoch **milliseconds**. `resolveFlwTimestamp` resolves all three by magnitude (`< 1e12` → seconds, `≥ 1e12` → ms). Nanosecond-precision ISO strings truncate cleanly to ms.
- **Amounts are main-unit decimals**, multi-currency (`2000` NGN, `2500` KES, `1500.25`). Converted to minor units via `parseNairaDecimalString`; non-NGN is tagged and passed through — no FX.

Identity: `chargeDedupeKey(id)` → `flutterwave:charge:<chargeId>`, shared with the retrieve-charge parser so webhook- and API-sourced rows upsert together.

---

## Verify-before-value

Flutterwave is emphatic: **re-query before giving value.**

### Retrieve charge
- `parseFlutterwaveCharge(response)` — normalizes a `GET /charges/:id` response. Their sample omits a timestamp, so a bare call returns `parse_error` with code `ERR_TIMESTAMP_MISSING`.
- `parseFlutterwaveChargeAt(response, fetchedAt)` — the overload: supply the host's fetch time as the occurrence time for timestamp-less responses.

Charge responses can carry a **typed `fees[]` array** (`vat`, `app`, `merchant`, `stamp_duty`, …). When present, fees are summed and `net = amount − Σfees`. Webhook charges omit fees → `Σ = 0` → `net = amount`.

### Settlements
- `parseFlutterwaveSettlement(record)` — one settlement record. The `GET /settlements/:id` response is enveloped (`{ status, message, data, meta }`); pass `response.data`. First real `settlementDate` (`due_datetime`), with `transaction_datetime` preferred as `occurredAt`. A settlement is a batch (`charge_count` may be > 1) but normalizes as one credit — one money movement into your bank/wallet.
- `parseFlutterwaveSettlementList(response)` — a full list response, row-isolated: one bad record doesn't sink the page.

**Money invariant:** `net_amount = gross_amount − Σfees − chargeback − refund`. All three deductions (typed `fees[]`, `chargeback`, `refund`) are withheld before settlement; the connector **refuses** any record where the breakdown doesn't reconcile. `feeInKobo` on the output aggregates all pre-settlement deductions (so the schema's `net = amount − fee` holds); the typed breakdown is preserved in `rawProviderPayload`.

**Status vocabulary** (full v4 enum): `completed` / `completed-offline` → `SUCCESSFUL`; `disburse-pending` / `pending` / `reviewed` / `approved` / `processing` / `flagged` / `on-hold` → `PENDING` (money not yet landed, reversible via the rank guard); `failed` → `FAILED`. Anything outside the table is a `parse_error`, loud not guessed.

---

## Settlement files

`parseSettlementFile(buffer)` throws `UnsupportedFileFormatError` — CSV export parsing isn't fixture-verified. Use the settlement **API** parsers above instead.

---

## Exports

| Export | Type |
|---|---|
| `flutterwave` | `Connector` |
| `parseFlutterwaveWebhook` | `(rawBody) => ParseResult` |
| `parseFlutterwaveCharge` / `parseFlutterwaveChargeAt` | retrieve-charge parsers |
| `parseFlutterwaveSettlement` / `parseFlutterwaveSettlementList` | settlement parsers |
| `verifyFlutterwaveSignature` | `(input) => boolean` |
| `resolveFlwTimestamp` | the three-format timestamp resolver |
| `chargeDedupeKey` | `(id) => string` |
| `SIGNATURE_HEADER` | `"flutterwave-signature"` |
| `CHARGE_EVENT_TYPE` | `"charge.completed"` |
| `PROVIDER` | `"flutterwave"` |

Depends on `@pay-normalize/core` and `zod`.
