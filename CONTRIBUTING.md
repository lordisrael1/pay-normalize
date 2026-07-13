# Contributing

Before proposing anything, read [NOT_DOING.md](NOT_DOING.md) — the scope constitution. If a feature isn't explicitly in scope, it's out. That document has veto power over enthusiasm, including mine.

The one-sentence scope: **raw provider input goes in → a validated `StandardizedTransaction` comes out.** The library never moves money, never persists, never guesses.

---

## Development setup

```bash
npm install          # workspace install; links packages/* together
npm run check        # the gate: typecheck (all packages) + full test suite
```

Individual commands:

```bash
npm test                       # vitest, all packages
npm run typecheck              # tsc --noEmit per package
npm run test:mutation          # Stryker mutation testing -> reports/mutation/index.html
npx vitest run packages/nomba  # a single package
```

Requirements: Node 18+, ESM. TypeScript is `strict` with `verbatimModuleSyntax`, `isolatedModules`, `noUncheckedIndexedAccess`, and `exactOptionalPropertyTypes` on. New code must typecheck clean under all of these.

---

## The corpus rule (read this twice)

**No connector merges without sanitized real fixtures.** Docs-derived parsers are experimental at best and excluded from the supported table ([NOT_DOING.md §11](NOT_DOING.md)). Documentation describes the happy path; production teaches the quirks. A connector graduates out of `EXPERIMENTAL` only when its fixture corpus contains real, sanitized production payloads.

**No unsanitized payloads in the repo, ever.** A leaked BVN or account number is a project-ending event. Every fixture must be scrubbed (account numbers zeroed, UUIDs masked, names replaced with placeholders) before it enters version control. Do not paste a real payload into an issue, a test, or a commit.

This is **enforced**, not just asked: `npm run check:fixtures` ([scripts/check-fixtures-pii.mjs](scripts/check-fixtures-pii.mjs)) scans every fixture and fails on any email, phone, BVN-shaped number, or unmasked production account number that isn't on [scripts/fixtures-pii-allowlist.json](scripts/fixtures-pii-allowlist.json). It runs first in `npm run check`. Adding a value to the allowlist is a conscious, reviewable statement in git history that the value is fake/doc-derived — so a real payload can't slip in silently. If the guard flags real data, scrub it; never allowlist real customer data.

Fixtures live under `packages/<provider>/fixtures/**` and are named by provenance — `docs.*` for documentation-derived, `prod.sanitized.*` for scrubbed production captures.

---

## Design invariants (enforced by tests and review)

These are non-negotiable and mostly encoded in `core`:

- **No floats for money.** Integer minor units only, converted once at the connector boundary with BigInt/string math. Add a test for each amount shape the provider can send.
- **No lossy normalization.** `rawProviderPayload` always preserves the original. If the schema can't represent a field, the raw payload is the escape hatch.
- **No swallowed unknowns.** Unrecognized event types return `unknown_event` with the raw payload, never a silent drop.
- **No status inference.** Map provider statuses through an explicit, tested table. No `default: SUCCESSFUL`, ever. Unmapped → `parse_error`.
- **No timezone guessing.** Parse timestamps per documented/observed format with a fixture proving it.
- **Never throw on hostile input.** `parseWebhook` is a total function; every connector has a "hostile input never throws" test.
- **Secrets are arguments.** Never read env vars, never store or log secrets.
- **Constant-time signature comparison.** Use `crypto.timingSafeEqual`, never `===`.

---

## Adding a connector

1. Open a design-doc PR against [NOT_DOING.md](NOT_DOING.md) first if the provider isn't already scoped there.
2. Create `packages/<provider>/` mirroring an existing connector's layout:
   - `src/signature.ts` — verification (raw-body or canonical-string HMAC, constant-time).
   - `src/parse-webhook.ts` — event routing → `ParseResult`.
   - `src/mapping.ts` — explicit status/channel tables.
   - `src/index.ts` — the `Connector` object + public exports.
   - `fixtures/**` — sanitized payloads.
   - `test/**` — contract tests, including a golden-vector signature test and a hostile-input test.
   - `README.md` — following the existing per-package format.
3. Match the workspace `package.json` shape: `"type": "module"`, exact-pinned deps, `main`/`types` → `./src/index.ts`, `test` and `typecheck` scripts.
4. Keep the connector's `version` at `"0.1.0"` and mark it `EXPERIMENTAL` until real fixtures exist.
5. `npm run check` must pass. Aim to keep mutation score from regressing.

---

## Pull requests

- One logical change per PR. Update `CHANGELOG.md` under `[Unreleased]`.
- New behavior needs a test; a bug fix needs a regression test that fails without the fix.
- Don't add dependencies to `core` beyond `zod`. Connectors stay dependency-light and never pull in a provider SDK.
- Security-relevant changes (signature, money parsing, trust boundaries) get extra scrutiny — call them out explicitly in the PR description.
