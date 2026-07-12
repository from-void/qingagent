import { beforeEach, describe, expect, it, vi } from "vitest";

// 凭证仓 mock:模拟已连接(盘上有 bundle),不触真实 libsql
const h = vi.hoisted(() => ({
  bundle: {
    version: 1 as const,
    connectorId: "github",
    revision: 1,
    payload: {
      strategy: "oauth2-device" as const,
      version: 1 as const,
      grantedScopes: ["repo"],
      account: { id: "1", displayName: "@octo" },
      token: "tok-test",
    },
  },
}));

vi.mock("../../credentials/credentialsRepo.js", () => ({
  getConnectorCredentialBundle: vi.fn(async () => h.bundle),
  saveConnectorCredentialBundle: vi.fn(),
  deleteConnectorCredentialBundle: vi.fn(),
}));

import { GithubConnector } from "../githubConnector.js";

function fetchOk(body: unknown): typeof globalThis.fetch {
  return vi.fn(async () =>
    new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } }),
  ) as unknown as typeof globalThis.fetch;
}

describe("GithubConnector probe", () => {
  beforeEach(() => vi.clearAllMocks());

  it("probe 成功后 status 带 lastCheckedAt(luna e2e 回归)", async () => {
    const connector = new GithubConnector({ clientId: "cid", fetch: fetchOk({ id: 1, login: "octo" }) });
    const before = await connector.status();
    expect(before.state).toBe("connected");
    expect(before.lastCheckedAt).toBeNull();

    const probed = await connector.probe();
    expect(probed.state).toBe("connected");
    expect(probed.lastCheckedAt).not.toBeNull();
    expect(Number.isNaN(Date.parse(probed.lastCheckedAt!))).toBe(false);

    // 后续 status 查询也应保留探活时间
    const after = await connector.status();
    expect(after.lastCheckedAt).toBe(probed.lastCheckedAt);
  });
});
