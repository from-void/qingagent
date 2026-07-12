import { configDefaults, defineConfig } from "vitest/config";

/**
 * Vitest is scoped to `*.test.ts(x)` so it doesn't try to load Playwright
 * `*.spec.ts` files (those run via `pnpm visual` and pull in `@playwright/test`,
 * which throws when imported outside the Playwright runner).
 */
export default defineConfig({
  test: {
    include: ["src/**/*.test.{ts,tsx}"],
    exclude: [
      ...configDefaults.exclude,
      "src/**/*.heavy.test.{ts,tsx}",
      "src/**/*.perf.test.{ts,tsx}",
      "src/**/*.dom.test.{ts,tsx}",
      "src/**/*.spec.{ts,tsx}",
      "src/system/chinese-masonry/**/*.test.{ts,tsx}",
    ],
    environment: "node",
  },
});
