import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_UPDATE_POLICY_URL,
  loadTelemetryConfig,
  resolveTelemetryUrls,
} from "./config.js";

function quietLogger() {
  const warnings: unknown[][] = [];
  return {
    logger: { warn: (...args: unknown[]) => warnings.push(args) },
    warnings,
  };
}

test("空构建端点静默禁用,且不拉 policy", async () => {
  let calls = 0;
  const { logger } = quietLogger();
  const cfg = await loadTelemetryConfig({
    env: {},
    buildInfo: { telemetryEndpoint: "" },
    logger,
    fetchPolicy: async () => {
      calls += 1;
      return { ok: true, status: 200, json: async () => ({ telemetryEndpoint: "https://policy.test/api/send" }) };
    },
  });

  assert.equal(cfg.enabled, false);
  assert.equal(cfg.source, "empty");
  assert.equal(calls, 0);
});

test("QINGAGENT_TELEMETRY_DISABLED=1 对构建端点和 policy 一票否决", async () => {
  let calls = 0;
  const { logger } = quietLogger();
  const cfg = await loadTelemetryConfig({
    env: { QINGAGENT_TELEMETRY_DISABLED: "1" },
    buildInfo: { telemetryEndpoint: "https://build.test/api/send" },
    logger,
    fetchPolicy: async () => {
      calls += 1;
      return { ok: true, status: 200, json: async () => ({ telemetryEndpoint: "https://policy.test/api/send" }) };
    },
  });

  assert.equal(cfg.enabled, false);
  assert.equal(cfg.source, "disabled");
  assert.equal(calls, 0);
});

test("policy 端点优先于构建期注入端点", async () => {
  const { logger } = quietLogger();
  let seenUrl = "";
  const cfg = await loadTelemetryConfig({
    env: {},
    buildInfo: {
      telemetryEndpoint: "https://build.test/api/send",
      updatePolicyUrl: "https://policy.test/update-policy.json",
    },
    logger,
    fetchPolicy: async (url) => {
      seenUrl = url;
      return { ok: true, status: 200, json: async () => ({ telemetryEndpoint: "https://policy.test/api/send" }) };
    },
  });

  assert.equal(seenUrl, "https://policy.test/update-policy.json");
  assert.equal(cfg.enabled, true);
  assert.equal(cfg.source, "policy");
  assert.equal(cfg.sendUrl, "https://policy.test/api/send");
  assert.equal(cfg.batchUrl, "https://policy.test/api/batch");
});

test("policy 不可达时 fail-open 回退构建期注入端点", async () => {
  const { logger, warnings } = quietLogger();
  const cfg = await loadTelemetryConfig({
    env: {},
    buildInfo: { telemetryEndpoint: "https://build.test/api/send" },
    logger,
    fetchPolicy: async () => {
      throw new Error("network down");
    },
  });

  assert.equal(cfg.enabled, true);
  assert.equal(cfg.source, "build");
  assert.equal(cfg.sendUrl, "https://build.test/api/send");
  assert.equal(cfg.batchUrl, "https://build.test/api/batch");
  assert.equal(warnings.length, 1);
});

test("官方包门:没有构建期端点时,即使 policy 可给端点也不启用", async () => {
  let calls = 0;
  const { logger } = quietLogger();
  const cfg = await loadTelemetryConfig({
    env: {},
    buildInfo: null,
    logger,
    fetchPolicy: async () => {
      calls += 1;
      return { ok: true, status: 200, json: async () => ({ telemetryEndpoint: "https://policy.test/api/send" }) };
    },
  });

  assert.equal(cfg.enabled, false);
  assert.equal(cfg.source, "empty");
  assert.equal(calls, 0);
});

test("policy 显式空端点会关闭官方包遥测", async () => {
  const { logger } = quietLogger();
  const cfg = await loadTelemetryConfig({
    env: {},
    buildInfo: { telemetryEndpoint: "https://build.test/api/send" },
    logger,
    fetchPolicy: async () => ({ ok: true, status: 200, json: async () => ({ telemetryEndpoint: "" }) }),
  });

  assert.equal(cfg.enabled, false);
  assert.equal(cfg.source, "policy");
  assert.equal(cfg.endpoint, "");
});

test("端点规范化兼容旧 base host 和新的 /api/send endpoint", () => {
  assert.deepEqual(resolveTelemetryUrls("http://127.0.0.1:3000/"), {
    endpoint: "http://127.0.0.1:3000/api/send",
    sendUrl: "http://127.0.0.1:3000/api/send",
    batchUrl: "http://127.0.0.1:3000/api/batch",
  });
  assert.deepEqual(resolveTelemetryUrls("https://t.qingagent.com/api/send"), {
    endpoint: "https://t.qingagent.com/api/send",
    sendUrl: "https://t.qingagent.com/api/send",
    batchUrl: "https://t.qingagent.com/api/batch",
  });
});

test("未注入 policy URL 覆盖时使用集中默认 URL", async () => {
  const { logger } = quietLogger();
  let seenUrl = "";
  await loadTelemetryConfig({
    env: {},
    buildInfo: { telemetryEndpoint: "https://build.test/api/send" },
    logger,
    fetchPolicy: async (url) => {
      seenUrl = url;
      return { ok: true, status: 200, json: async () => ({}) };
    },
  });
  assert.equal(seenUrl, DEFAULT_UPDATE_POLICY_URL);
});
