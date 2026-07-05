import { defineConfig } from "vitest/config";

/**
 * Vitest is scoped to `*.test.ts(x)` so it doesn't try to load Playwright
 * `*.spec.ts` files (those run via `pnpm visual` and pull in `@playwright/test`,
 * which throws when imported outside the Playwright runner).
 */
export default defineConfig({
  test: {
    include: ["src/**/*.test.{ts,tsx}"],
    exclude: ["src/**/*.dom.test.{ts,tsx}", "src/**/*.spec.{ts,tsx}"],
    environment: "node",
  },
});
