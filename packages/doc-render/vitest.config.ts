import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    exclude: [
      ...configDefaults.exclude,
      "**/*.heavy.test.{ts,tsx}",
      "**/*.perf.test.{ts,tsx}",
    ],
    testTimeout: 30000,
    hookTimeout: 30000,
  },
});
