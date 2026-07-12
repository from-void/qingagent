import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.perf.test.{ts,tsx}"],
    fileParallelism: false,
    testTimeout: 60000,
    hookTimeout: 60000,
  },
});
