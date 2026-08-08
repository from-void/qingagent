import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.perf.test.{ts,tsx}"],
    fileParallelism: false,
    testTimeout: 180_000,
    hookTimeout: 180_000,
  },
});
