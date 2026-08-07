import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  modelFetch: vi.fn(),
  recordProviderBalanceSnapshot: vi.fn(async () => undefined),
  getProviderBalanceComparison: vi.fn(),
}));

vi.mock("@qingagent/core", () => ({ modelFetch: mocks.modelFetch }));
vi.mock("@qingagent/db", () => ({
  recordProviderBalanceSnapshot: mocks.recordProviderBalanceSnapshot,
  getProviderBalanceComparison: mocks.getProviderBalanceComparison,
}));

const {
  credentialFingerprint,
  getEnvDeepseekBalanceComparison,
  refreshDeepseekBalanceSnapshot,
  resetProviderBalanceProbeForTests,
} = await import("../providerBalanceProbe.js");

const savedKey = process.env.DEEPSEEK_API_KEY;

beforeEach(() => {
  vi.clearAllMocks();
  resetProviderBalanceProbeForTests();
  delete process.env.DEEPSEEK_API_KEY;
});

afterEach(() => {
  if (savedKey === undefined) delete process.env.DEEPSEEK_API_KEY;
  else process.env.DEEPSEEK_API_KEY = savedKey;
});

describe("providerBalanceProbe", () => {
  it("只读取 env key，经 modelFetch 查询并仅落不可逆指纹", async () => {
    process.env.DEEPSEEK_API_KEY = "sk-env-balance-secret";
    mocks.modelFetch.mockResolvedValue(Response.json({
      balance_infos: [{ currency: "CNY", total_balance: "18.75" }],
    }));

    await refreshDeepseekBalanceSnapshot({ force: true });

    expect(mocks.modelFetch).toHaveBeenCalledWith(
      "https://api.deepseek.com/user/balance",
      expect.objectContaining({
        headers: { Authorization: "Bearer sk-env-balance-secret" },
      }),
    );
    expect(mocks.recordProviderBalanceSnapshot).toHaveBeenCalledWith({
      provider: "deepseek",
      credentialFingerprint: credentialFingerprint("sk-env-balance-secret"),
      balanceCny: 18.75,
    });
    expect(credentialFingerprint("sk-env-balance-secret")).not.toContain("secret");
  });

  it("无 env key 时不查询；读取对比也按当前 key 指纹隔离", async () => {
    await refreshDeepseekBalanceSnapshot({ force: true });
    expect(mocks.modelFetch).not.toHaveBeenCalled();

    process.env.DEEPSEEK_API_KEY = "key-after-rotation";
    mocks.getProviderBalanceComparison.mockResolvedValue({
      provider: "deepseek",
      credentialFingerprint: credentialFingerprint("key-after-rotation"),
      latestBalanceCny: 10,
      latestAt: "2026-08-08T00:00:00.000Z",
    });
    await expect(getEnvDeepseekBalanceComparison()).resolves.toMatchObject({
      latestBalanceCny: 10,
    });
    expect(mocks.getProviderBalanceComparison).toHaveBeenCalledWith(
      "deepseek",
      credentialFingerprint("key-after-rotation"),
    );
  });

  it("探针网络或解析失败静默，不影响调用方", async () => {
    process.env.DEEPSEEK_API_KEY = "key-failure";
    mocks.modelFetch.mockRejectedValue(new Error("network down"));
    await expect(refreshDeepseekBalanceSnapshot({ force: true })).resolves.toBeUndefined();
    expect(mocks.recordProviderBalanceSnapshot).not.toHaveBeenCalled();
  });
});
