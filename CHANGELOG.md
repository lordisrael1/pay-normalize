# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project aims to
follow [Semantic Versioning](https://semver.org/) once connectors leave experimental status.

Each package is versioned independently. `core` is the API contract — a breaking
change there is a major bump of every package.

## [Unreleased]

### Added
- **Publishable build.** Each package now builds to `dist/` with `tsup` (bundled ESM +
  `.d.ts` + sourcemap), ships only `dist` + `README` + `LICENSE` (ISC) via a `files` allowlist,
  and declares `publishConfig.access: "public"`. Versions aligned to `0.1.0` (experimental).
  Dev and tests still run against `src`: tsc resolves source via a private
  `"pay-normalize-source"` exports condition (`customConditions`), and vitest via `resolve.alias`
  (`vitest.config.ts`) — so a fresh clone tests without a build, while consumers only see `dist`.
  Verified with `npm publish --dry-run` (6 files per package, no fixtures/src/tests) and a runtime
  smoke test of the built output.
- **Fixture PII guard** (`scripts/check-fixtures-pii.mjs`, run via `npm run check:fixtures`,
  first step of `npm run check`): scans every fixture and fails CI on any email, phone,
  BVN-shaped number, or unmasked production account number not on an explicit allowlist —
  the enforcement NOT_DOING.md §11 mandated. Closes the gap where a contributor could paste a
  real payload with nothing stopping them.
- **`examples/paystack-ledger`**: a runnable reference host integration (verify → parse →
  idempotent ingest) with an in-memory `dedupeKey`/`STATUS_RANK` ledger, proven end-to-end
  against real fixtures. `examples/*` is now a workspace.
- **`@pay-normalize/monnify`** (experimental): Monnify connector. Parses `SUCCESSFUL_TRANSACTION`,
  `SUCCESSFUL_DISBURSEMENT`/`FAILED_DISBURSEMENT`, `SETTLEMENT`, and `REJECTED_PAYMENT` webhooks;
  routes `MANDATE_UPDATE`/`ACCOUNT_ACTIVITY`/`LOW_BALANCE_ALERT` to `unknown_event`; normalizes the
  Get-Transaction-Status API response (`parseMonnifyTransaction`). Signature scheme confirmed
  empirically as HMAC-SHA512 over the compact body (Monnify's prose and sample both misstate it);
  pinned by a byte-for-byte golden-vector test. Multi-format WAT timestamp resolver.
- **Documentation set**: root `README.md`, `docs/ARCHITECTURE.md`, `docs/INTEGRATION.md`,
  `docs/SECURITY.md`, per-package READMEs, `CONTRIBUTING.md`, and this changelog.
- **Semantic error codes**: `NormalizationError` now carries a stable
  `code: NormalizationErrorCode` (`ERR_SIGNATURE_VERIFICATION`, `ERR_MALFORMED_PAYLOAD`,
  `ERR_AMOUNT_PARSE`, `ERR_UNSUPPORTED_FILE_FORMAT`, `ERR_TIMESTAMP_MISSING`). Route on
  the code, not the message.
- **Property-based tests** (`fast-check`) for the money model, plus **mutation testing**
  (Stryker) via `npm run test:mutation`.
- **Flutterwave**: accepts both `id` and `webhook_id` as the delivery-id field; charge
  responses now sum the typed `fees[]` array (`net = amount − Σfees`). New bank-transfer
  (PWBT) webhook and verify fixtures.
- **Flutterwave settlements**: the money invariant now accounts for `chargeback` and `refund`
  deductions (`net = gross − Σfees − chargeback − refund`) — previously any settlement carrying
  a chargeback or refund was falsely rejected. Added the full v4 status vocabulary
  (`disburse-pending`, `reviewed`, `approved`, `processing`, `on-hold`, `completed-offline`) and
  reads `transaction_datetime`. New retrieve-settlement fixture.

### Fixed
- **Security (ReDoS)**: `parseNairaDecimalString` no longer backtracks quadratically on
  whitespace-heavy input. Added a length cap (`MAX_AMOUNT_LEN = 40`) and linearized the
  regex; the formerly ~7s pathological input is now rejected O(1). Pinned by a regression test.
- **Flutterwave delivery id** was silently dropped on card/bank-transfer webhooks
  (they use `webhook_id`, not `id`); `providerEventId` is now captured for all delivery shapes.
- **Flutterwave charge fees** were hardcoded to `0`; the verify/retrieve path now reflects
  the real `fees[]` breakdown.

### Confirmed
- **Flutterwave signature scheme** confirmed as HMAC-SHA256 over raw body (base64) against
  Flutterwave's authoritative documentation; the connector's implementation matches.

### Security notes (unchanged, host-mitigated)
- **Nomba amount is unsigned** — see [docs/SECURITY.md](docs/SECURITY.md#h-2-the-nomba-amount-is-unsigned).
  Enforce TLS and verify-before-value for material credits.

## Status

| Package | npm version | Connector maturity |
|---|---|---|
| `@pay-normalize/core` | 1.0.0 | — (contract) |
| `@pay-normalize/paystack` | 1.0.0 | Experimental (`0.1.0`) |
| `@pay-normalize/nomba` | 1.0.0 | Experimental (`0.1.0`) |
| `@pay-normalize/flutterwave` | 0.1.0 | Experimental (`0.1.0`) |
| `@pay-normalize/monnify` | 0.1.0 | Experimental (`0.1.0`) |

No connector has graduated out of experimental yet — that requires sanitized real
production fixtures per [NOT_DOING.md §11](NOT_DOING.md).
