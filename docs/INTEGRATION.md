# Integration guide

How to wire a connector into a host application. The library is stateless and pure; this guide covers the parts that are **your** responsibility: capturing raw bytes, enforcing idempotency, applying status transitions, and handling retries.

The flow is always four steps:

```
capture raw bytes  →  verify signature  →  parse  →  handle the typed result
```

See [ARCHITECTURE.md](ARCHITECTURE.md) for the data model and [SECURITY.md](SECURITY.md) for the threat details behind these rules.

---

## 1. Capture the raw request body

Signatures are computed over the **exact bytes** the provider sent. If your framework parses JSON first and you later re-serialize, key order / whitespace / unicode escaping can change and the HMAC will no longer match — the classic "invalid signature on a valid webhook" bug.

The library enforces this at the type level: `verifyWebhookSignature` requires a `RawBody`, which is only constructible from a `Buffer` via `toRawBody`. A host that only has parsed JSON gets a **compile error**, not a 2am mystery.

**Express** — mount `express.raw()` on the webhook route, *before* any `express.json()`:

```ts
import express from "express";
import { toRawBody } from "@pay-normalize/core";

app.post(
  "/webhooks/paystack",
  express.raw({ type: "application/json", limit: "256kb" }), // size cap = cheap DoS defense
  (req, res) => {
    const rawBody = toRawBody(req.body); // req.body is a Buffer
    // ...
  }
);
```

**Next.js / Fastify / others:** disable automatic body parsing on the route and read the raw buffer (`await buffer(req)`, `rawBody` config, etc.), then `toRawBody(buf)`. Parse to JSON only *after* verification, from these same bytes — which is what `parseWebhook` does internally.

> `rawBodyFromString(s)` exists for tests and fixture replay only. Using it in production reintroduces the re-serialization risk it is meant to prevent.

---

## 2. Verify before parsing

Parsing unverified bytes is choosing to process attacker-controlled input. Always verify first; on failure respond `401` and stop.

```ts
import { paystack } from "@pay-normalize/paystack";

const ok = paystack.verifyWebhookSignature({
  headers: req.headers,               // case-insensitive lookup internally; tolerates string[]
  rawBody,
  secret: process.env.PAYSTACK_SECRET_KEY!,
});
if (!ok) return res.status(401).end();
```

The secret is an **argument** — the library never reads env vars. Nomba additionally requires the `nomba-timestamp` header (it is part of the signed canonical string); the connector reads it from `headers` for you.

---

## 3. Parse and handle the result

`parseWebhook` is a total function: malformed input returns a typed `parse_error`, never throws. **ACK with `200` quickly**, then do the work — providers treat anything but a fast 2xx as failure and retry.

```ts
res.status(200).end(); // ACK first — see §5

const result = paystack.parseWebhook(rawBody);

switch (result.kind) {
  case "transaction":
    await ingest(result.transaction);
    break;

  case "unknown_event":
    // Recognized but not money movement (subscription.*, dedicatedaccount.*, future types).
    // Log + store raw. NEVER NACK — unknown ≠ error; NACKing makes the provider retry forever.
    await logUnknown(result.provider, result.eventType, result.raw);
    break;

  case "parse_error":
    // Poison message: it will fail identically on every retry. ACK 200 (already done),
    // park result.raw in a dead-letter store, and alert. Route on the code, not the message.
    await deadLetter(result.raw, result.error.code, result.error.message);
    break;
}
```

---

## 4. Store idempotently (the part that actually prevents double-crediting)

Two independent mechanisms, both required:

### 4a. A unique index on `dedupeKey` — the hard lock

At-least-once delivery + retries + concurrent workers means duplicates are guaranteed. Application-level "does it exist?" checks race. The database constraint is the lock.

```sql
CREATE UNIQUE INDEX ux_txn_dedupe ON transactions (dedupe_key);
```

### 4b. A rank guard on status — for out-of-order delivery

Insert new rows; on conflict, apply the incoming status **only if it outranks** the stored one (`shouldApplyStatusTransition`). This makes redelivery a no-op and lets a late `SUCCESSFUL` or a `REVERSED` win correctly regardless of arrival order.

```ts
import { shouldApplyStatusTransition, type StandardizedTransaction } from "@pay-normalize/core";

async function ingest(txn: StandardizedTransaction) {
  await db.tx(async (t) => {
    const existing = await t.oneOrNone(
      "SELECT status FROM transactions WHERE dedupe_key = $1 FOR UPDATE", // row lock
      [txn.dedupeKey]
    );

    if (!existing) {
      await t.none("INSERT INTO transactions (dedupe_key, status, /* ... */) VALUES ($1, $2 /* ... */)",
        [txn.dedupeKey, txn.status /* ... */]);
      return;
    }

    if (shouldApplyStatusTransition(existing.status, txn.status)) {
      await t.none("UPDATE transactions SET status = $2 /* ... */ WHERE dedupe_key = $1",
        [txn.dedupeKey, txn.status]);
    }
    // equal-or-lower rank → no-op (idempotent redelivery)
  });
}
```

Equivalently as one statement:

```sql
INSERT INTO transactions (dedupe_key, status /* ... */)
VALUES ($1, $2 /* ... */)
ON CONFLICT (dedupe_key) DO UPDATE
  SET status = EXCLUDED.status
  WHERE <rank(EXCLUDED.status)> > <rank(transactions.status)>;
```

`FOR UPDATE` (or the `ON CONFLICT` form) is what makes concurrent workers safe — two deliveries for the same transaction *will* race.

---

## 5. Retries, timeouts, and ACK discipline

Providers retry aggressively until they get a `200`. Respond fast, work after.

| Provider | Retry / timeout behavior |
|---|---|
| Paystack | Every 3 min for the first 4 attempts, then hourly for 72 hours until 200. |
| Nomba | Up to 5 redeliveries at ~2m / 5m / 11m / 24m / 53m on any non-2xx. |
| Flutterwave | 60s timeout; 3 retries at 30-min intervals — **only if retries are enabled on the dashboard**. |
| Monnify | Notifications time out; retries duplicate notifications. ACK 200 fast, process after. |

Consequences:
- **ACK before heavy work.** A slow handler becomes a retry storm.
- **A `parse_error` should still return 200.** Retrying a poison payload just fails identically — dead-letter it instead.
- **Enable Flutterwave retries on the dashboard.** With them off, a missed delivery is gone forever; their docs prescribe a backup polling job over pending transactions (host-side; normalize the results with `parseFlutterwaveCharge`).

---

## Verify-before-value

A webhook tells you *something* happened. Before releasing value on a material transaction, re-query the provider's API (your HTTP, your credentials — the library never calls out) and normalize the response. The verify parser returns the **same `dedupeKey`** as the webhook, so the two rows collapse into one with `STATUS_RANK` arbitrating.

```ts
import { parsePaystackVerification } from "@pay-normalize/paystack";

const apiResponse = await fetch(
  `https://api.paystack.co/transaction/verify/${reference}`,
  { headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}` } }
).then((r) => r.json());

const result = parsePaystackVerification(apiResponse);
if (result.kind === "transaction") {
  const t = result.transaction;
  if (t.status === "SUCCESSFUL" && t.amountInKobo === expectedAmountInKobo && t.currency === expectedCurrency) {
    await fulfilOrder();          // confirmed server-side
  }
}
```

This is also the **missing-money recovery path**: if a webhook was never delivered (past the retry window), verify is how you backfill a transaction you never heard about.

Per-provider verify parsers:

| Provider | Function | Enforces |
|---|---|---|
| Paystack | `parsePaystackVerification(response)` | `net = amount − fees` |
| Flutterwave | `parseFlutterwaveChargeAt(response, fetchedAt)` | `net = amount − Σfees`; supply fetch time when the response has no timestamp |
| Flutterwave | `parseFlutterwaveSettlement(record)` / `parseFlutterwaveSettlementList(response)` | `net = gross − Σfees`; refuses records whose money fields disagree |
| Nomba | `parseNombaTransactionRecord(record)` | `amountCharged = amount + fixedCharge` |
| Monnify | `parseMonnifyTransaction(response)` | `net = amountPaid − settlementAmount` |

> **Flutterwave & Nomba: the amount is not covered by the webhook signature in every case** (Nomba's especially — see [SECURITY.md](SECURITY.md#h-2-the-nomba-amount-is-unsigned)). For material credits, verify-before-value is not optional.

---

## Settlement / statement files

`parseSettlementFile(buffer)` currently throws `UnsupportedFileFormatError` for every connector — settlement CSV/XLSX parsing ships only when a sanitized real export exists in fixtures to pin the column layout ([NOT_DOING.md §11](../NOT_DOING.md)). For API-fetched settlements today, use the verify-before-value parsers above (Flutterwave's settlement parsers are live). Catch the error by `code`:

```ts
try {
  const file = connector.parseSettlementFile(buf);
} catch (e) {
  if (e instanceof UnsupportedFileFormatError) { /* e.code === "ERR_UNSUPPORTED_FILE_FORMAT" */ }
}
```

---

## Checklist

- [ ] Raw body captured with `express.raw()` (or equivalent) **before** any JSON parser, with a size limit.
- [ ] Signature verified **before** parsing; 401 on failure.
- [ ] Secret passed as an argument from your own config/secret manager.
- [ ] `200` returned **before** heavy processing.
- [ ] `UNIQUE INDEX` on `dedupe_key` in the database.
- [ ] Status updates guarded by `shouldApplyStatusTransition` under a row lock / `ON CONFLICT`.
- [ ] `unknown_event` logged, not NACKed.
- [ ] `parse_error` dead-lettered, not retried.
- [ ] Material credits confirmed via verify-before-value.
- [ ] `rawProviderPayload` stored encrypted-at-rest with a retention policy (it contains PII).
- [ ] TLS enforced on the webhook endpoint.
