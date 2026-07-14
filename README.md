# pay-normalize

> Raw provider input (webhooks, callbacks, settlement files) goes in → a validated `StandardizedTransaction` comes out. Everything else is the host's job, deliberately.

`pay-normalize` is an **inbound anti-corruption layer** for Nigerian (later African) payment providers. Each provider speaks its own dialect — different signature schemes, amount conventions, status vocabularies, timestamp formats — and this library translates all of them into one deterministic domain model **before** the data reaches your business logic.

It is a **pure, stateless, headless TypeScript library**. No network calls, no database, no framework, no UI, no background jobs. You give it bytes; it gives you a typed result. Storage, idempotency enforcement, and money movement stay in your application, where they belong.

---

## Why this exists

Four providers, four completely different webhook signature schemes:

| Provider | Transport | Algorithm | Signed over | Encoding |
|---|---|---|---|---|
| Paystack | `x-paystack-signature` header | HMAC-SHA512 | raw body | hex |
| Monnify | `monnify-signature` header | HMAC-SHA512 | raw body (compact JSON) | hex |
| Nomba | `nomba-signature` header | HMAC-SHA256 | canonical string (9 fields) | base64 |
| Flutterwave | `flutterwave-signature` header | HMAC-SHA256 | raw body | base64 |
| OPay *(planned)* | body field | HMAC-SHA3-512 | canonical string | hex |

…and four different ways to express an amount (kobo integers, kobo strings, naira decimal *numbers*, naira decimal *strings*, main-unit multi-currency decimals). Getting any one of these subtly wrong is a reconciliation incident. This library encodes the correct handling once, proves it with fixtures, and hands you a uniform shape.

The **fixture corpus is the moat**; the code is scaffolding. See [NOT_DOING.md](NOT_DOING.md) for the scope constitution — what this project will never become (it never moves money, never persists, never guesses).

---

## Packages

This is an npm workspace monorepo. `core` is the contract; each provider is an isolated, independently-versioned connector that depends only on `core`.

| Package | Status | Purpose |
|---|---|---|
| [`@pay-normalize/core`](packages/core/README.md) | Contract | Schema, money (`Kobo`), status ordering, dedupe, errors, the `Connector` interface |
| [`@pay-normalize/paystack`](packages/paystack/README.md) | Partially graduated | Paystack webhooks + verify-transaction responses |
| [`@pay-normalize/nomba`](packages/nomba/README.md) | Experimental | Nomba webhooks + transaction-record API responses |
| [`@pay-normalize/flutterwave`](packages/flutterwave/README.md) | Experimental | Flutterwave v4 webhooks, retrieve-charge, settlements |
| [`@pay-normalize/monnify`](packages/monnify/README.md) | Experimental | Monnify webhooks (collection, disbursement, settlement) + transaction-status API |

**All connectors start `EXPERIMENTAL` (connector `version: "0.1.0"`).** Per [NOT_DOING.md §11](NOT_DOING.md), a connector graduates out of experimental only when its fixture corpus contains sanitized *real* production payloads — not docs-derived ones, and graduation is per event family, not all-or-nothing. Nomba is furthest along (signature validated byte-for-byte against Nomba's golden vector; transaction-record fixtures are sanitized production data). Paystack's `charge.success` (card + bank_transfer) now has real captured-and-sanitized webhook fixtures; its `transfer.*`/`refund.processed` paths remain docs-derived. Flutterwave's signature scheme is confirmed against Flutterwave's authoritative docs but still wants one real signed delivery.

---

## Install

> Not yet published to npm; consumed today as a workspace. Intended package names are shown above.

```bash
npm install
```

Requirements: **Node 18+** (uses `node:crypto` `timingSafeEqual` and Web-standard `Buffer`), ESM only (`"type": "module"`). Packages expose TypeScript source directly (`main` → `./src/index.ts`) and are consumed in a TS/bundler context.

---

## 60-second quick start

The flow is always the same four steps: **capture raw bytes → verify signature → parse → handle the typed result.**

```ts
import express from "express";
import { toRawBody } from "@pay-normalize/core";
import { paystack } from "@pay-normalize/paystack";

const app = express();

// 1. Capture the EXACT raw bytes. Signature verification requires them —
//    express.json() would destroy the byte-for-byte body the HMAC was computed over.
app.post(
  "/webhooks/paystack",
  express.raw({ type: "application/json", limit: "256kb" }),
  (req, res) => {
    const rawBody = toRawBody(req.body); // req.body is a Buffer here

    // 2. Verify BEFORE parsing. Parsing unverified bytes is processing attacker input.
    const ok = paystack.verifyWebhookSignature({
      headers: req.headers,
      rawBody,
      secret: process.env.PAYSTACK_SECRET_KEY!, // an argument, never read from env by the library
    });
    if (!ok) return res.status(401).end();

    // 3. Parse. Total function: malformed input returns a typed parse_error, never throws.
    const result = paystack.parseWebhook(rawBody);

    // 4. ACK fast (providers retry aggressively), then handle by kind.
    res.status(200).end();

    switch (result.kind) {
      case "transaction":
        // Idempotent upsert on result.transaction.dedupeKey; see docs/INTEGRATION.md
        void ingest(result.transaction);
        break;
      case "unknown_event":
        // Recognized-but-not-money-movement. Log + store raw; never NACK (see integration guide).
        break;
      case "parse_error":
        // Poison message. ACK 200, park result.raw in your dead-letter store, alert.
        console.error(result.error.code, result.error.message);
        break;
    }
  }
);
```

Full host-side guidance — idempotent upsert SQL, the `STATUS_RANK` transition guard, retries/timeouts, multi-worker races — is in **[docs/INTEGRATION.md](docs/INTEGRATION.md)**.

---

## Documentation

| Doc | What's in it |
|---|---|
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Design principles, the `StandardizedTransaction` model, `Kobo`, status ranking, dedupe identity, the error model |
| [docs/INTEGRATION.md](docs/INTEGRATION.md) | The complete host integration: raw body, verify, parse, idempotent storage, retries, verify-before-value |
| [docs/SECURITY.md](docs/SECURITY.md) | Signature schemes, the Nomba unsigned-amount finding, TLS/secret handling, input hardening |
| [NOT_DOING.md](NOT_DOING.md) | The scope constitution — what this project refuses to become |
| [CONTRIBUTING.md](CONTRIBUTING.md) | Fixture-graduation rules, adding a connector, running tests + mutation testing |
| [CHANGELOG.md](CHANGELOG.md) | Version history |

---

## Development

```bash
npm test              # vitest, all packages + the example
npm run typecheck     # tsc --noEmit across every package
npm run check:fixtures # PII guard: fails on any un-allowlisted PII in a fixture
npm run check         # fixtures guard + typecheck + test (the CI gate)
npm run test:mutation # Stryker mutation testing (reports/mutation/index.html)
npm run build -w @pay-normalize/core   # build one package to dist/ (tsup)
```

Packages build to `dist/` (bundled ESM + `.d.ts`) and publish only that; development and tests run
against `src` via a private `pay-normalize-source` exports condition (tsc) and a vitest alias, so no
build is needed to work on the repo. To preview a publish: `npm publish --dry-run -w @pay-normalize/<pkg>`.

## Examples

[`examples/paystack-ledger`](examples/paystack-ledger/README.md) — a runnable reference integration wiring Paystack **verify → parse → idempotent ingest** end-to-end, including the `dedupeKey` unique-index pattern and the `STATUS_RANK` transition guard. It's the ~30 lines of glue every host writes, executed against real fixtures.

## License

ISC (Apache-2.0/MIT intended at public release; see [NOT_DOING.md §11](NOT_DOING.md)).
