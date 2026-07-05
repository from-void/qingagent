import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  TELEMETRY_BUILD_INFO_FILENAME,
  collectTelemetryBuildInfo,
  writeTelemetryBuildInfo,
} from "./buildTelemetryInfo.mjs";

function makeTempDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

test("未设置构建环境变量时写入空遥测端点", () => {
  const info = collectTelemetryBuildInfo({});
  assert.deepEqual(info, { telemetryEndpoint: "" });
});

test("QINGAGENT_TELEMETRY_ENDPOINT 和 policy URL 覆盖会被烤进 buildInfo", () => {
  const cwd = makeTempDir("desktop-telemetry-info-");
  try {
    const outdir = join(cwd, "dist-main");
    const { file, info } = writeTelemetryBuildInfo({
      outdir,
      env: {
        QINGAGENT_TELEMETRY_ENDPOINT: "  https://t.example.com/api/send  ",
        QINGAGENT_UPDATE_POLICY_URL: "  https://example.com/update-policy.json  ",
      },
    });

    assert.equal(file, join(outdir, TELEMETRY_BUILD_INFO_FILENAME));
    assert.deepEqual(info, {
      telemetryEndpoint: "https://t.example.com/api/send",
      updatePolicyUrl: "https://example.com/update-policy.json",
    });
    assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), info);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
