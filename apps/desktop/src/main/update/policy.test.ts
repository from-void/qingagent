import { test } from "node:test";
import assert from "node:assert/strict";
import {
  fetchUpdatePolicy,
  isBelowMinSupported,
  isTrustedUpdatePolicyUrl,
} from "./policy.js";

const trustedPolicyUrl = "https://raw.githubusercontent.com/from-void/qingagent/main/update-policy.json";

test("policy 200 合法 minSupported 返回规范值", async () => {
  const policy = await fetchUpdatePolicy(
    trustedPolicyUrl,
    async (_url, init) => {
      assert.equal(init.redirect, "error");
      return { ok: true, status: 200, json: async () => ({ minSupported: " 1.2.3 " }) };
    },
  );

  assert.deepEqual(policy, { minSupported: "1.2.3" });
});

test("policy 404 fail-open", async () => {
  const policy = await fetchUpdatePolicy(
    trustedPolicyUrl,
    async () => ({ ok: false, status: 404, json: async () => ({ minSupported: "1.2.3" }) }),
  );

  assert.deepEqual(policy, { minSupported: null });
});

test("policy 超时 fail-open", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let rejectFetch: ((reason?: unknown) => void) | undefined;
  let settled = false;
  const pendingPolicy = fetchUpdatePolicy(
    trustedPolicyUrl,
    async (_url, init) =>
      new Promise((_, reject) => {
        rejectFetch = reject;
        const signal = init.signal;
        if (signal?.aborted) {
          reject(signal.reason);
          return;
        }
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      }),
    1_000,
  ).then((policy) => {
    settled = true;
    return policy;
  });

  try {
    t.mock.timers.tick(999);
    await Promise.resolve();
    assert.equal(settled, false);

    t.mock.timers.tick(1);
    assert.deepEqual(await pendingPolicy, { minSupported: null });
  } finally {
    rejectFetch?.(new Error("test cleanup"));
    await Promise.allSettled([pendingPolicy]);
  }
});

test("policy 非 JSON fail-open", async () => {
  const policy = await fetchUpdatePolicy(
    trustedPolicyUrl,
    async () => ({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError("not json");
      },
    }),
  );

  assert.deepEqual(policy, { minSupported: null });
});

test("policy 字段缺失 fail-open", async () => {
  const policy = await fetchUpdatePolicy(
    trustedPolicyUrl,
    async () => ({ ok: true, status: 200, json: async () => ({ telemetryEndpoint: "https://t.test" }) }),
  );

  assert.deepEqual(policy, { minSupported: null });
});

test("policy minSupported 非字符串 fail-open", async () => {
  const policy = await fetchUpdatePolicy(
    trustedPolicyUrl,
    async () => ({ ok: true, status: 200, json: async () => ({ minSupported: 123 }) }),
  );

  assert.deepEqual(policy, { minSupported: null });
});

test("policy minSupported 非法 SemVer fail-open", async () => {
  const policy = await fetchUpdatePolicy(
    trustedPolicyUrl,
    async () => ({ ok: true, status: 200, json: async () => ({ minSupported: "1.2" }) }),
  );

  assert.deepEqual(policy, { minSupported: null });
});

test("isBelowMinSupported 覆盖低于、等于、高于", () => {
  assert.equal(isBelowMinSupported("1.1.9", "1.2.0"), true);
  assert.equal(isBelowMinSupported("1.2.0", "1.2.0"), false);
  assert.equal(isBelowMinSupported("1.2.1", "1.2.0"), false);
});

test("isBelowMinSupported 按 SemVer 预发布规则比较 beta", () => {
  assert.equal(isBelowMinSupported("1.2.0-beta.1", "1.2.0"), true);
  assert.equal(isBelowMinSupported("1.2.0-beta.2", "1.2.0-beta.1"), false);
  assert.equal(isBelowMinSupported("1.2.0-beta.1", "1.2.0-beta.2"), true);
});

test("isBelowMinSupported 非法输入 fail-open", () => {
  assert.equal(isBelowMinSupported("not-a-version", "1.2.0"), false);
  assert.equal(isBelowMinSupported("1.2.0", "bad-min"), false);
});

test("强更策略端点只接受官方固定 GitHub raw 地址", () => {
  assert.equal(isTrustedUpdatePolicyUrl(trustedPolicyUrl), true);
  assert.equal(isTrustedUpdatePolicyUrl("http://raw.githubusercontent.com/from-void/qingagent/main/update-policy.json"), false);
  assert.equal(isTrustedUpdatePolicyUrl("https://raw.githubusercontent.com/from-void/other/main/update-policy.json"), false);
  assert.equal(isTrustedUpdatePolicyUrl("https://github.com/from-void/qingagent/raw/main/update-policy.json"), false);
  assert.equal(isTrustedUpdatePolicyUrl(`${trustedPolicyUrl}?redirect=https://example.com`), false);
});

test("不受信任策略端点不会发出请求", async () => {
  const policy = await fetchUpdatePolicy("https://example.com/update-policy.json", async () => {
    assert.fail("不应请求不受信任端点");
  });

  assert.deepEqual(policy, { minSupported: null });
});
