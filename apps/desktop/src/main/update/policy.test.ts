import { test } from "node:test";
import assert from "node:assert/strict";
import { fetchUpdatePolicy, isBelowMinSupported } from "./policy.js";

test("policy 200 合法 minSupported 返回规范值", async () => {
  const policy = await fetchUpdatePolicy(
    "https://policy.test/update-policy.json",
    async () => ({ ok: true, status: 200, json: async () => ({ minSupported: " 1.2.3 " }) }),
  );

  assert.deepEqual(policy, { minSupported: "1.2.3" });
});

test("policy 404 fail-open", async () => {
  const policy = await fetchUpdatePolicy(
    "https://policy.test/update-policy.json",
    async () => ({ ok: false, status: 404, json: async () => ({ minSupported: "1.2.3" }) }),
  );

  assert.deepEqual(policy, { minSupported: null });
});

test("policy 超时 fail-open", async () => {
  const policy = await fetchUpdatePolicy(
    "https://policy.test/update-policy.json",
    async (_url, init) =>
      new Promise((_, reject) => {
        const signal = init.signal;
        if (signal?.aborted) {
          reject(signal.reason);
          return;
        }
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      }),
    5,
  );

  assert.deepEqual(policy, { minSupported: null });
});

test("policy 非 JSON fail-open", async () => {
  const policy = await fetchUpdatePolicy(
    "https://policy.test/update-policy.json",
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
    "https://policy.test/update-policy.json",
    async () => ({ ok: true, status: 200, json: async () => ({ telemetryEndpoint: "https://t.test" }) }),
  );

  assert.deepEqual(policy, { minSupported: null });
});

test("policy minSupported 非字符串 fail-open", async () => {
  const policy = await fetchUpdatePolicy(
    "https://policy.test/update-policy.json",
    async () => ({ ok: true, status: 200, json: async () => ({ minSupported: 123 }) }),
  );

  assert.deepEqual(policy, { minSupported: null });
});

test("policy minSupported 非法 SemVer fail-open", async () => {
  const policy = await fetchUpdatePolicy(
    "https://policy.test/update-policy.json",
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
