import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    exclude: [
      ...configDefaults.exclude,
      "**/*.heavy.test.{ts,tsx}",
      "**/*.perf.test.{ts,tsx}",
    ],
  },
});
