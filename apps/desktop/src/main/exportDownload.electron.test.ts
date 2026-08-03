import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import {
  mkdtempSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const electronExecutable = require("electron") as string;
const RESULT_PREFIX = "QINGAGENT_EXPORT_DOWNLOAD_ELECTRON_RESULT=";

test("真实 Electron sandbox renderer 经 IPC 保存所有格式且不触发 will-download", async () => {
  const tempRoot = mkdtempSync(path.join(tmpdir(), "qingagent-electron-download-test-"));
  const fixtureBundle = path.join(tempRoot, "fixture.mjs");
  const preloadBundle = path.join(tempRoot, "preload.cjs");
  const downloadsDirectory = path.join(tempRoot, "Downloads");
  const userDataDirectory = path.join(tempRoot, "user-data");

  try {
    await build({
      entryPoints: [path.join(__dirname, "exportDownload.electron.fixture.ts")],
      outfile: fixtureBundle,
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node22",
      external: ["electron"],
      logLevel: "silent",
    });
    await build({
      entryPoints: [path.join(__dirname, "exportDownload.electron.preload.fixture.ts")],
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
        timeout: 30_000,
        env: {
          ...process.env,
          ELECTRON_DISABLE_SANDBOX: "1",
          QINGAGENT_EXPORT_TEST_DIR: downloadsDirectory,
          QINGAGENT_EXPORT_TEST_PRELOAD: preloadBundle,
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
      savedFilenames: string[];
      willDownloadEvents: number;
    };
    assert.deepEqual(payload.savedFilenames, [
      "测试文档_20260729.md",
      "2026运动手环选购攻略｜小白也能看懂的完整指南_20260801.md",
      "2026运动手环选购攻略｜小白也能看懂的完整指南_20260801.txt",
      "2026运动手环选购攻略｜小白也能看懂的完整指南_20260801.html",
      "测试文档_20260729.docx",
      "测试文档_20260729.pdf",
      "公众号稿-测试标题.png",
      "测试文档_20260729 (2).pdf",
    ]);
    assert.equal(payload.willDownloadEvents, 0);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});
