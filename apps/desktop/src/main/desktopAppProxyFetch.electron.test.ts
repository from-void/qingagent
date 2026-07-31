import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const electronExecutable = require("electron") as string;
const RESULT_PREFIX = "QINGAGENT_SSE_EOF_ELECTRON_RESULT=";

test("真实 Electron EventSource 在协议代理上游结束后秒级收到 onerror", async (t) => {
  const tempRoot = mkdtempSync(path.join(tmpdir(), "qingagent-electron-sse-eof-test-"));
  const fixtureBundle = path.join(tempRoot, "fixture.mjs");
  const userDataDirectory = path.join(tempRoot, "user-data");

  try {
    await build({
      entryPoints: [path.join(__dirname, "desktopAppProxyFetch.electron.fixture.ts")],
      outfile: fixtureBundle,
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node22",
      external: ["electron"],
      logLevel: "silent",
    });

    const result = spawnSync(
      electronExecutable,
      [
        "--headless",
        "--no-sandbox",
        "--disable-gpu",
        `--user-data-dir=${userDataDirectory}`,
        fixtureBundle,
      ],
      {
        encoding: "utf8",
        timeout: 15_000,
        env: {
          ...process.env,
          ELECTRON_DISABLE_SANDBOX: "1",
        },
      },
    );
    assert.equal(
      result.status,
      0,
      `Electron fixture failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
    const resultLine = result.stdout
      .split(/\r?\n/)
      .find((line) => line.startsWith(RESULT_PREFIX));
    assert.ok(resultLine, `missing Electron result\nstdout:\n${result.stdout}`);
    const payload = JSON.parse(resultLine.slice(RESULT_PREFIX.length)) as {
      timedOut: boolean;
      fetchError: string;
      readyAt: number;
      errorAt: number;
      upstreamClosedAt: number;
      eventRequests: number;
      eofDelayMs: number | null;
    };
    t.diagnostic(`上游 EOF → renderer onerror: ${payload.eofDelayMs} ms`);
    assert.equal(payload.timedOut, false, JSON.stringify(payload));
    assert.equal(payload.fetchError, "", JSON.stringify(payload));
    assert.equal(payload.eventRequests, 1, JSON.stringify(payload));
    assert.ok(payload.readyAt > 0, JSON.stringify(payload));
    assert.ok(payload.upstreamClosedAt >= payload.readyAt, JSON.stringify(payload));
    assert.ok(payload.errorAt >= payload.upstreamClosedAt, JSON.stringify(payload));
    assert.ok(
      payload.eofDelayMs !== null && payload.eofDelayMs < 2_000,
      JSON.stringify(payload),
    );
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});
