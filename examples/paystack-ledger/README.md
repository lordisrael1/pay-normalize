# Example: Paystack → idempotent ledger

A runnable reference integration showing the four-step host flow from
[docs/INTEGRATION.md](../../docs/INTEGRATION.md), connected end-to-end:

```
raw bytes  →  verify signature  →  parse  →  idempotent ingest
```

This is the machinery the library deliberately leaves to the host (it is pure
and stateless). Nothing here is provider-specific magic — it's the ~30 lines of
glue every consumer writes.

## Files

| File | Role |
|---|---|
| [ledger.ts](ledger.ts) | `InMemoryLedger` — the idempotent upsert. The `Map` keyed by `dedupeKey` stands in for a `UNIQUE INDEX`; `shouldApplyStatusTransition` is the out-of-order guard. In production this is `INSERT … ON CONFLICT … WHERE rank(new) > rank(old)`. |
| [handle-webhook.ts](handle-webhook.ts) | `handlePaystackWebhook()` — verify → parse → route → ingest, returning an HTTP-shaped result. |
| [test/integration.test.ts](test/integration.test.ts) | Drives the whole flow with real fixtures and real HMAC signing. |

## What it proves

Running `npm test` from the repo root executes the integration test, which
demonstrates, with real signed payloads:

- a charge is **verified, parsed, and inserted** as one `SUCCESSFUL` row;
- a **redelivered** charge is **ignored** — no double-recording (idempotency);
- `refund.processed` lands as **`SUCCESSFUL → REVERSED` on the same row** (charge
  and refund share a `dedupeKey`);
- an **out-of-order** charge arriving *after* its refund **cannot un-reverse** it
  (the `STATUS_RANK` guard);
- a non-money event (`subscription.create`) surfaces as `unknown_event` and
  **never touches the ledger**;
- a **bad signature** is a `401` with no parse and no ingest;
- a **malformed but signed** payload is ACK'd `200` as a `parse_error` (poison
  message — dead-letter it, don't retry), with no ingest.

## Wiring it to a real server

`handlePaystackWebhook` returns `{ status, kind, outcome, … }`. A thin server
maps that to a response. With Express:

```ts
import express from "express";
import { InMemoryLedger } from "./ledger";
import { handlePaystackWebhook } from "./handle-webhook";

const ledger = new InMemoryLedger(); // swap for your database
const app = express();

app.post(
  "/webhooks/paystack",
  express.raw({ type: "application/json", limit: "256kb" }), // raw bytes, before any JSON parser
  (req, res) => {
    const r = handlePaystackWebhook(req.body, req.headers, process.env.PAYSTACK_SECRET_KEY!, ledger);
    res.status(r.status).end();
    // do heavy work AFTER responding
  }
);
```

For material credits, confirm server-side before releasing value: call Paystack's
verify endpoint and normalize with `parsePaystackVerification` — it returns the
same `dedupeKey`, so it reconciles into the same ledger row. See
[docs/INTEGRATION.md](../../docs/INTEGRATION.md#verify-before-value).
