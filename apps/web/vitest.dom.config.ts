import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "src/**/*.dom.test.{ts,tsx}",
      "src/system/chinese-masonry/**/*.test.{ts,tsx}",
    ],
    exclude: [
      ...configDefaults.exclude,
      "src/**/*.heavy.test.{ts,tsx}",
      "src/**/*.perf.test.{ts,tsx}",
      "src/**/*.spec.{ts,tsx}",
    ],
    environment: "jsdom",
    setupFiles: ["./src/test/vitest.dom.setup.ts"],
  },
});
