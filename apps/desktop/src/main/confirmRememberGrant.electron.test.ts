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
const RESULT_PREFIX = "QINGAGENT_REMEMBER_GRANT_ELECTRON_RESULT=";

test("真实 Electron 主进程 IPC 为 send/connect 签发非空 nonce", async () => {
  const tempRoot = mkdtempSync(path.join(tmpdir(), "qingagent-remember-grant-test-"));
  const fixtureBundle = path.join(tempRoot, "fixture.mjs");
  const preloadBundle = path.join(tempRoot, "preload.cjs");
  const userDataDirectory = path.join(tempRoot, "user-data");

  try {
    await build({
      entryPoints: [path.join(__dirname, "confirmRememberGrant.electron.fixture.ts")],
      outfile: fixtureBundle,
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node22",
      external: ["electron"],
      logLevel: "silent",
    });
    await build({
      entryPoints: [path.join(__dirname, "confirmRememberGrant.electron.preload.fixture.ts")],
      outfile: preloadBundle,
      bundle: true,
      platform: "node",
      format: "cjs",
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
          QINGAGENT_REMEMBER_TEST_PRELOAD: preloadBundle,
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
      nonces: Record<"send" | "connect", string | null>;
      registeredKinds: Array<"send" | "connect">;
    };
    assert.deepEqual(payload.nonces, {
      send: "send-nonce",
      connect: "connect-nonce",
    });
    assert.deepEqual(payload.registeredKinds, ["send", "connect"]);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});
