import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.perf.test.{ts,tsx}"],
    environment: "jsdom",
    setupFiles: ["./src/test/vitest.dom.setup.ts"],
    fileParallelism: false,
    testTimeout: 60000,
    hookTimeout: 60000,
  },
});
