import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.dom.test.{ts,tsx}"],
    exclude: ["src/**/*.spec.{ts,tsx}"],
    environment: "jsdom",
    setupFiles: ["./src/test/vitest.dom.setup.ts"],
  },
});
