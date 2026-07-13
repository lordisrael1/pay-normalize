# Security model

This library sits at a trust boundary — untrusted provider payloads on one side, your ledger on the other. This document describes what it defends, what it deliberately leaves to the host, and the known findings a host operator must account for.

For reporting a vulnerability, see [Reporting](#reporting) at the bottom.

---

## What the library guarantees

- **Constant-time signature comparison.** All verifiers use `crypto.timingSafeEqual`, never `===`. String comparison short-circuits on the first differing byte and leaks how much of a forged signature is correct. The length pre-check before `timingSafeEqual` compares only against a *public constant* (the fixed digest length per scheme), so it leaks nothing.
- **Raw-byte verification.** HMACs are computed over the exact request bytes (`RawBody`), never over a re-serialized object. See [INTEGRATION.md §1](INTEGRATION.md#1-capture-the-raw-request-body).
- **Total functions over hostile input.** Parsers never throw on malformed bytes — they return a typed `parse_error`. A poison payload cannot crash the host endpoint.
- **No secret handling.** Secrets are per-call arguments. The library never reads env vars, never stores, never logs secrets.
- **Bounded money parsing.** Amount parsing is integer/BigInt only and length-capped (see [ReDoS hardening](#input-hardening-redos)).
- **No injection surface.** The library builds no SQL, shell commands, HTML, or templates. It parses JSON and returns plain data. Injection risk lives entirely in how the *host* stores/renders `rawProviderPayload`.

---

## Signature schemes

Each connector implements exactly what the provider documents. Verification requires the raw body and, where noted, specific headers.

| Provider | Header(s) | Algorithm | Signed input | Encoding |
|---|---|---|---|---|
| Paystack | `x-paystack-signature` | HMAC-SHA512 | raw body | hex |
| Monnify | `monnify-signature` | HMAC-SHA512 | raw body (compact JSON), keyed by client secret | hex |
| Nomba | `nomba-signature` + `nomba-timestamp` | HMAC-SHA256 | canonical string (9 colon-joined fields) | base64 |
| Flutterwave | `flutterwave-signature` | HMAC-SHA256 | raw body | base64 |

Header lookups are case-insensitive (proxies re-case headers) and tolerate `string[]` (duplicated headers).

### Monnify — scheme confirmed empirically

Monnify's docs contradict themselves twice: the prose describes a plain `SHA-512(secret + body)` (not HMAC), while their Node sample HMACs a **pretty-printed** body. Neither reproduces Monnify's own published golden hash. Computing all candidates against their documented example proves the real scheme is **HMAC-SHA512 over the compact JSON body**, keyed by the client secret. The connector verifies over the raw request bytes, which is correct provided Monnify transmits the bytes it signed; a golden-vector test pins the hash byte-for-byte. Confirming the wire serialization against a real captured delivery is the outstanding graduation step.

### Flutterwave — scheme confirmed

Flutterwave's own docs briefly contradict themselves (one inline sample compares the header directly to the plain secret). The **authoritative "Verifying Webhook Signatures" section** and Flutterwave's `isValidFlutterwaveWebhook` helper both specify HMAC-SHA256 over the raw body, base64 — which is what the connector implements. The plain-secret comparison is the sloppy sample and is *not* what the connector does. A test pins that the plain-secret path correctly **fails** under the HMAC scheme.

---

## Findings a host must account for

These are not defects in the library — they are properties of the providers' schemes that the library surfaces honestly and cannot fix in code. A host operator must implement the stated mitigations.

### H-2: The Nomba amount is unsigned

**The Nomba signature covers routing/identity metadata only. `transactionAmount`, `fee`, sender, and account number are NOT in the HMAC input.** A party able to modify the payload in transit can change `transactionAmount` from `120` to `120000` and the signature still verifies. There is a test that demonstrates the tampered amount verifying.

Required host mitigations:

1. **TLS on the webhook endpoint is not optional** — it is the only thing authenticating the amount in transit.
2. **For material credits, confirm the amount via Nomba's transaction lookup API** (verify-before-value; host-side call) before releasing value. Treat the webhook as "something happened to transaction X," and the unsigned fields as a hint of *what*.

The same principle applies whenever the amount is outside the signed input; verify-before-value is the general defense ([INTEGRATION.md](INTEGRATION.md#verify-before-value)).

### Verify-before-value is a security control, not just reliability

Providers themselves say it: re-query before giving value, and confirm `status`, `amount`, `currency`, and `reference` match your expectation. A webhook is attacker-reachable (the URL is public); the authenticated API response is not.

---

## Input hardening (ReDoS)

`parseNairaDecimalString` runs on attacker-influenceable amount strings. Its matching is hardened against catastrophic backtracking:

- **Length cap (`MAX_AMOUNT_LEN = 40`).** The largest representable amount is ~24 characters; anything longer is rejected O(1) *before* the regex runs. A hostile megabyte-long string can't reach the matcher.
- **Linear regex.** The pattern trims once and carries a single internal whitespace run. The earlier `^\s*…\s*$` form allowed two whitespace runs to trade off against each other, backtracking O(n²) (an 80k-char input took ~7s and blocked the event loop). The current form is flat/linear, verified empirically and pinned by a regression test.

**Host responsibility:** cap webhook body size at the transport layer (`express.raw({ limit: "256kb" })`). The library defends the money field; the host defends total request size.

---

## Data exposure

- **`rawProviderPayload` contains PII** (names, emails, phone numbers, account numbers). The schema preserves it deliberately for auditability and non-lossy normalization. The host owns **encryption-at-rest, access control, and a retention policy** for whatever column stores it.
- **The library logs nothing.** It emits no `console.*` output and holds no telemetry. What gets logged is entirely the host's choice — do not log secrets or full raw payloads to shared log sinks.
- **Fixtures are sanitized.** Every payload in the repo is scrubbed of real PII (account numbers zeroed, UUIDs masked, names replaced). Unsanitized payloads never enter the repo ([NOT_DOING.md §11](../NOT_DOING.md)); the scrubber must pass in CI on every fixture.
- **Test secrets are non-live.** Secrets in test files are fake or are providers' own published golden-vector example values, never real dashboard credentials.

---

## Boundaries the library does NOT cross (host responsibilities)

Per [NOT_DOING.md](../NOT_DOING.md), these are deliberately out of scope — do not expect the library to do them:

- TLS termination, IP allowlisting, WAF rules, rate limiting.
- Request size limits (transport layer).
- Secret storage/rotation.
- Idempotency **enforcement** (the library gives you the key; your unique index enforces it).
- Encryption-at-rest and retention for stored payloads.
- Any outbound API call, including verify-before-value (host owns the HTTP + credentials).

---

## Reporting

This is pre-release software. Report suspected vulnerabilities privately to the maintainers rather than opening a public issue. A leaked real payload (BVN/account number) in a fixture is treated as a project-ending event and should be reported with the same urgency.
