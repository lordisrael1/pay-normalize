import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

/**
 * Workspace packages publish `dist/` but are developed and tested against their
 * TypeScript `src/`. tsc resolves to source via each package's private
 * `"pay-normalize-source"` exports condition (see the `customConditions` in each
 * tsconfig). Vitest, however, externalizes workspace deps and does NOT honor
 * that condition, so we alias the package names straight to source here. Result:
 * tests run against `src` with no build step, while consumers only ever see the
 * published `dist` (they never set the private condition).
 */
const root = dirname(fileURLToPath(import.meta.url));
const src = (name: string) => resolve(root, `packages/${name}/src/index.ts`);

export default defineConfig({
  resolve: {
    alias: {
      "@pay-normalize/core": src("core"),
      "@pay-normalize/paystack": src("paystack"),
      "@pay-normalize/nomba": src("nomba"),
      "@pay-normalize/flutterwave": src("flutterwave"),
      "@pay-normalize/monnify": src("monnify"),
    },
  },
});
