# NOT_DOING.md

> **Purpose of this file:** Every open-source infrastructure project dies one of two deaths — nobody uses it, or scope creep turns it into an unmaintainable everything-app. This file exists to prevent the second death. Before any feature, PR, or "wouldn't it be cool if" enters the codebase, it must survive this document.
>
> **The one-sentence scope:** Raw provider input (webhooks, callbacks, settlement/statement files) goes in → a validated `StandardizedTransaction` comes out. Everything else is someone else's job — often deliberately so.

**Rule for contributors and future-me:** If a proposal isn't explicitly *in scope*, it's out. Out-of-scope items are not "later" by default — they are *out* until they meet the graduation criteria at the bottom of this file.

---

## 1. What this project IS (for contrast)

- A TypeScript **normalization library**: parsers, validators, and dedupe/ordering primitives for Nigerian (later African) payment-provider events and files.
- A **fixture corpus**: sanitized, real-world provider payloads with contract tests. The corpus is the moat; the code is scaffolding.
- **Stateless by design.** We compute; the host application stores. We hand you `dedupeKey` and `statusRank` — *you* enforce them against *your* database.

Everything below is what we refuse to become.

---

## 2. Money movement — NEVER (not "later", never in this repo)

- ❌ **No initiating payments, transfers, or payouts** through any provider API. Not Flutterwave Transfers, not Paystack Transfers, not Monnify Disbursements, not OPay/PalmPay wallet-to-wallet, not Nomba payouts. The moment this library *moves* money, it stops being a parser and becomes a regulated activity (CBN PSSP/PSP licensing territory) and a liability magnet.
- ❌ **No payment collection/checkout.** No card charge flows, no `initialize transaction` wrappers, no USSD push, no checkout UI, no payment links. Providers already ship SDKs for this; duplicating them adds risk and zero differentiation.
- ❌ **No refund initiation.** We *parse* refund/reversal events; we never *trigger* them.
- ❌ **No float management, no treasury balancing, no multi-gateway payout routing** (the "Switchboard" idea). Explicitly rejected: touches flow of funds, invites licensing scrutiny, and makes gateways hostile.
- ❌ **No holding, aggregating, or displaying provider account balances as authority.** We can parse a balance *event* if a provider sends one; we do not poll balance endpoints or present ourselves as a balance source of truth.

## 3. Ledger — NOT our layer

- ❌ **No double-entry ledger.** No balances, no wallets, no journal entries, no `debit/credit` semantics. Blnk, TigerBeetle, Formance own this layer and do it well. We are the *input pipe* to a ledger, not the ledger.
- ❌ **No persistence layer at all in core.** No bundled Postgres schema-as-product, no ORM, no migrations. We may ship *reference* SQL in `examples/` — examples are documentation, not supported surface area.
- ❌ **No "sync to Blnk / Modern Treasury / QuickBooks" adapters in core.** A `blnk-adapter` may live as a separate community package once the core is stable. Core stays dependency-free of any downstream system.

## 4. Reconciliation *product* — parse yes, product no

- ❌ **No reconciliation engine** (matching rules, one-to-many strategies, exception queues). We normalize both sides so that *someone's* recon engine — Blnk's, or the host app's 30-line SQL diff — becomes trivial. The diff itself is out of scope for v1.
- ❌ **No "missing money" alerting/monitoring service.** That is the future hosted product (ShadowLedger), not the library. It does not enter this repo.
- ❌ **No auto-generated "repair payloads"** that write corrections into anyone's database. We will never propose writes to a host system's ledger.

## 5. AI / LLM — no

- ❌ **No LLM-powered CSV column mapping** for arbitrary bank statements. Non-deterministic parsing of financial data is a correctness landmine and a support nightmare. Every supported format is a hand-written, fixture-tested parser or it doesn't ship.
- ❌ **No "AI reconciliation assistant," no natural-language anything.** This is a deterministic library. Same input, same output, forever.

## 6. Hosted anything — not in v1

- ❌ **No SaaS, no hosted webhook ingestion endpoint, no managed pipeline, no replay service, no dead-letter queues, no dashboard, no admin UI.** These are the eventual business — they are earned by library adoption, not built on spec.
- ❌ **No CLI beyond dev tooling** (fixture scrubbing, connector scaffolding). No `npx pay-normalize serve`.
- ❌ **No queues/brokers in core.** No Kafka, no BullMQ, no Redis dependency. Core must run in a bare Node process. Delivery guarantees are the host's (or the future hosted product's) concern.

## 7. Compliance, identity, risk — out entirely

- ❌ No KYC/KYB, no BVN/NIN validation, no identity resolution.
- ❌ No fraud scoring, no velocity rules, no transaction monitoring/AML, no sanctions screening.
- ❌ No PII tokenization/vault. Our only PII stance: the **fixture scrubber must strip it** before payloads enter the repo, and `rawProviderPayload` handling docs must warn hosts that raw payloads contain PII. That's it.

## 8. Provider-by-provider scope fence

Format per provider: ✅ what the connector does · ❌ what it will never do.

### Flutterwave
- ✅ Parse v4 webhooks (`charge.completed`; other event types surfaced as unknown); verify the `flutterwave-signature` header (HMAC-SHA256 over the raw body, base64 — confirmed against Flutterwave's authoritative docs); normalize retrieve-charge and settlement API responses; normalize their multi-currency payloads to our schema (NGN/other in minor units; tag non-NGN and pass through). Settlement *file* (CSV) parsing ships when a sanitized real export pins the layout.
- ❌ No Transfers API, no Payment Plans/subscription management, no virtual card issuing wrappers, no Barter/wallet features, no `verify transaction` polling as a service (we may document the *pattern*; the host makes the call), no multi-country rail logic (Rwanda/Ghana/Kenya rails are separate connectors *later*, not flags on this one).

### Paystack
- ✅ Parse webhooks (`charge.success`, `transfer.success/failed/reversed`, `refund.*`, dedicated-NUBAN `dedicatedaccount.assign` events, subscription charge events *as transactions*); verify `x-paystack-signature` (HMAC-SHA512 over **raw body** — framework must expose raw bytes); parse settlement CSV exports; model their fee/split fields into `feeInKobo`/`netAmountInKobo`.
- ❌ No Transaction Initialize/charge API, no Transfers, no Subscriptions *management* (create/cancel plans), no Terminal/POS APIs, no dedicated-NUBAN *provisioning* (we parse assignment events; we don't create accounts).

### Monnify
- ✅ Parse transaction-completion and settlement webhooks; verify their signature scheme; parse reserved-account funding notifications; parse settlement reports; handle their amount-in-naira-decimal convention → integer kobo conversion at the boundary.
- ❌ No reserved-account *creation*, no invoice API, no disbursement API, no sub-account/split *configuration* (we parse split outcomes present in payloads; we don't manage splits).

### OPay
- ✅ Parse merchant callback/webhook notifications for collections (card, bank transfer, OPay wallet payments *received by the merchant*); handle their signature verification; handle amount-as-string and status-vocabulary quirks; dedupe duplicate callbacks (known behavior — fixtures required); parse merchant settlement exports.
- ❌ No OPay consumer-wallet features, no wallet transfers, no airtime/bills/data APIs, no agent/POS network features, no OPay-to-bank payout initiation, no cashback/loyalty mechanics.

### PalmPay
- ✅ Parse merchant payment notification callbacks; signature verification per their spec; settlement file parsing; status-vocabulary normalization. **Honest flag:** PalmPay's merchant API documentation is thinner and shifts more than the others — this connector ships *only* when we have real fixtures, not from docs alone. No fixtures, no connector. That rule is absolute and applies to every provider.
- ❌ No consumer wallet, no bills/airtime, no PalmPay POS/agent features, no loan/BNPL event handling beyond passing unknown events through as `UNKNOWN` with raw payload preserved.

### Nomba (first connector — built from Owoore production experience)
- ✅ Parse virtual-account funding webhooks and transaction notifications; signature verification; settlement/transaction export parsing; the out-of-order and duplicate-delivery quirks observed in production are the *founding fixtures* of the corpus.
- ❌ No virtual-account *creation* (Owoore does that; this library doesn't), no Nomba checkout, no terminal/POS APIs, no payout initiation.

### Moniepoint, Kuda, Providus, Wema/ALAT, GTBank, Zenith, Access (statements & the long tail)
- ✅ **Placeholder rows only** in the supported-providers table — they are invitations to contributors. Bank *statement/settlement file* parsers (CSV/XLSX exports) are in scope one format at a time, each requiring donated sanitized fixtures.
- ❌ No screen-scraping of internet-banking portals, no headless-browser statement fetching, no open-banking API integrations (until NDPR/open-banking rails in Nigeria are stable enough that a connector is deterministic), no MT940/ISO 20022 ambitions in v1, no email-parsing of transaction alerts, and **no SMS alert parsing** — tempting for completeness, unbounded format chaos in practice.

### Cross-provider refusals (apply to every connector)
- ❌ No polling loops. Connectors are pure functions over inputs the host supplies. If a provider requires a verify-by-API call to confirm a webhook, we document the pattern; the host owns the HTTP call and its credentials.
- ❌ No storage of provider secrets/keys. Verification functions *receive* secrets as arguments; we never read env vars, never persist, never log them.
- ❌ No retry/backoff logic against provider APIs (there are no API calls to retry — see above).
- ❌ No provider SDK dependencies. Every connector is dependency-light parsing code we control. A provider's official SDK changing must never break us.

## 9. Schema discipline — refusals baked into the data model

- ❌ **No floats, ever.** Money is integer kobo (`amountInKobo`, `feeInKobo`, `netAmountInKobo`). A naira decimal or amount-string is converted exactly once, at the connector boundary, with tests for `"5000.00"`, `"5,000.00"`, `5000`, and `500000` (already-kobo) confusions per provider.
- ❌ **No lossy normalization.** `rawProviderPayload` is always preserved. If our schema can't represent something, the raw payload is the escape hatch — we do not silently drop fields.
- ❌ **No swallowing unknown events.** Unrecognized event types emit a typed `UNKNOWN` result with raw payload, never a throw-away or a guess.
- ❌ **No status inference.** If a provider says `PROCESSING`, we map it to `PENDING` via an explicit, tested table — we never infer success from amount presence, absence of error fields, or vibes.
- ❌ **No timezone guessing.** Provider timestamps are parsed per documented/observed format (mostly WAT, sometimes UTC, sometimes unlabeled) with an explicit per-provider rule and fixtures proving it. Unlabeled ambiguous timestamps are surfaced as such, not silently assumed.
- ❌ **No breaking schema changes without a major version.** `StandardizedTransaction` v1 fields are frozen; additions are optional fields; renames/removals are v2.

## 10. Ecosystem & surface-area refusals

- ❌ **No multi-language ports** (Python/Go/PHP) maintained by us in v1. The fixture corpus is language-agnostic by design — ports are community projects that consume our fixtures.
- ❌ **No framework plugins** (Nest module, Next.js route helpers, Fastify plugin) in core. One Express *example* exists as documentation. Plugins are community packages.
- ❌ **No webhook-forwarding/fan-out utilities**, no ngrok-style tunneling helpers, no local webhook simulators beyond the fixture-replay harness in `packages/testing`.
- ❌ **No currency conversion, FX rates, or multi-currency arithmetic.** Non-NGN amounts are tagged and passed through untouched.
- ❌ **No accounting outputs** (journal entries, trial balances, VAT/WHT computation, ICAN-shaped anything). Tempting given my background; still no.
- ❌ **No analytics/BI** — no revenue charts, no MRR calculations, no "insights."

## 11. Governance refusals

- ❌ **No connector merges without sanitized real fixtures.** Docs-derived parsers are `experimental/` at best and excluded from the supported table. The corpus rule outranks contributor enthusiasm.
- ❌ **No unsanitized payloads in the repo, ever** — the scrubber tool must pass in CI on every fixture; a leaked BVN/account number is a project-ending event, treated accordingly.
- ❌ **No paid-priority features, no closed-source connectors, no dual licensing** in v1. Everything Apache-2.0/MIT until a hosted product exists as a *separate* codebase.
- ❌ **No roadmap promises to strangers.** The supported-providers table shows what exists; empty rows show what's invited. No dates.

---

## 12. Graduation criteria — how something leaves this file

An item may move from NOT_DOING to the roadmap only when **all** of these hold:

1. **Pull, not push:** ≥3 independent strangers (not friends, not one company) have opened issues asking for it against real usage.
2. **Core is stable:** the 3 launch connectors (Nomba, Paystack, one of Monnify/OPay) have been fixture-green in someone else's production for 90+ days.
3. **It doesn't move money and doesn't require a license.** Sections 2 and 7 have no graduation path. They are permanent.
4. **It's written up first:** a design doc PR against this file, arguing the change, merged before any code.

The hosted pipeline / ShadowLedger recon product graduates to a **separate repository and company decision** — it never grows inside this library.

---

*Last reviewed: 2026-07-04. Review date set for 90 days post-launch. Future-me: you are not allowed to move the goalposts without editing this file in a public commit.*