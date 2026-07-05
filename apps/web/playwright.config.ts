import { defineConfig, devices } from "@playwright/test";

declare const process: { env: Record<string, string | undefined> } | undefined;
function ciFlag(): boolean {
  return typeof process !== "undefined" && Boolean(process.env.CI);
}

const visualPort = Number(process?.env.QINGAGENT_VISUAL_PORT ?? 6174);
const visualBaseURL = `http://127.0.0.1:${visualPort}`;

/**
 * Visual-diff harness for Stage A. CI does NOT run this — the runner
 * has no chromium binary. Locally, run `pnpm --filter @qingagent/web visual`
 * after `pnpm exec playwright install chromium`.
 *
 * Phase 3 page capsules (C-A05..A09) extend this harness with their own
 * specs and committed golden PNGs.
 */
export default defineConfig({
  testDir: "./tests/visual",
  fullyParallel: true,
  retries: 0,
  reporter: "list",
  expect: {
    toHaveScreenshot: {
      maxDiffPixelRatio: 0.02,
    },
  },
  use: {
    baseURL: visualBaseURL,
    trace: "off",
    ...devices["Desktop Chrome"],
    viewport: { width: 1440, height: 900 },
  },
  projects: [
    {
      name: "chromium",
      // Inherit the global `use` so the 1440x900 viewport survives.
      // (Re-spreading `devices["Desktop Chrome"]` here would clobber it.)
      use: {},
    },
  ],
  webServer: {
    command: `QINGAGENT_WEB_PORT=${visualPort} pnpm dev`,
    url: visualBaseURL,
    reuseExistingServer: !ciFlag(),
    timeout: 120_000,
  },
});
