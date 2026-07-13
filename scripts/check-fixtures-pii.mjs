#!/usr/bin/env node
// Fixture PII guard — the enforcement behind NOT_DOING.md §11.
//
// "No unsanitized payloads in the repo, ever ... a leaked BVN/account number is
//  a project-ending event." The constitution mandated a scrubber that passes in
// CI; this is it. It scans every fixture for PII-shaped values and fails on any
// that isn't on the allowlist — so a contributor pasting a real provider payload
// gets a red build instead of a silent leak.
//
// Dependency-free. Run: node scripts/check-fixtures-pii.mjs
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, basename, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const allow = JSON.parse(readFileSync(join(ROOT, "scripts", "fixtures-pii-allowlist.json"), "utf8"));
const allowEmails = new Set(allow.emails.map((s) => s.toLowerCase()));
const allowPhones = new Set(allow.phones ?? []);
const allowNumbers = new Set(allow.numbers ?? []);

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const ELEVEN_DIGITS_RE = /(?<!\d)\d{11}(?!\d)/g;
const TEN_DIGITS_RE = /(?<!\d)\d{10}(?!\d)/g;

/** A value is an obvious placeholder if masked (*) or padded with a long run of one digit. */
const isPlaceholderAccount = (s) => s.includes("*") || /(\d)\1{4,}/.test(s);

function fixtureFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name === "node_modules") continue;
      if (name === "fixtures") out.push(...allJson(p));
      else out.push(...fixtureFiles(p));
    }
  }
  return out;
}
function allJson(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...allJson(p));
    else if (name.endsWith(".json")) out.push(p);
  }
  return out;
}

const violations = [];
const add = (file, rule, value) => violations.push({ file: relative(ROOT, file), rule, value });

for (const file of fixtureFiles(join(ROOT, "packages"))) {
  const text = readFileSync(file, "utf8");
  const isProd = basename(file).startsWith("prod.");

  for (const email of text.match(EMAIL_RE) ?? []) {
    if (!allowEmails.has(email.toLowerCase())) add(file, "unlisted-email", email);
  }

  for (const n of text.match(ELEVEN_DIGITS_RE) ?? []) {
    if (n.startsWith("0")) {
      if (!allowPhones.has(n)) add(file, "unlisted-phone", n); // 11-digit, leading 0 => NG mobile
    } else if (!allowNumbers.has(n)) {
      add(file, "possible-bvn", n); // 11-digit, non-phone => BVN/NIN shape
    }
  }

  // Production-sourced fixtures must mask account numbers.
  if (isProd) {
    for (const n of text.match(TEN_DIGITS_RE) ?? []) {
      if (!isPlaceholderAccount(n) && !allowNumbers.has(n)) add(file, "prod-unmasked-account", n);
    }
  }
}

if (violations.length === 0) {
  console.log("✓ fixture PII guard: no unlisted PII in any fixture.");
  process.exit(0);
}

console.error(`✗ fixture PII guard: ${violations.length} unlisted PII value(s) found.\n`);
for (const v of violations) console.error(`  [${v.rule}] ${v.value}\n      in ${v.file}`);
console.error(
  "\nIf a value is genuine documentation/fake data, add it to scripts/fixtures-pii-allowlist.json " +
    "(a conscious, reviewable acknowledgement). If it is REAL customer data, scrub it before committing — " +
    "an unsanitized payload is a project-ending event (NOT_DOING.md §11)."
);
process.exit(1);
