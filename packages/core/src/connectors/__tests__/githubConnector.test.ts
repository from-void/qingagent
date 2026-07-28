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
  } as {
    version: 1;
    connectorId: string;
    revision: number;
    payload: {
      strategy: "oauth2-device";
      version: 1;
      grantedScopes: string[];
      account: { id: string; displayName: string };
      token: string;
      verification?: {
        state: "connected" | "needs_reauth";
        checkedAt: string;
      };
    };
  } | null,
}));

vi.mock("../../credentials/credentialsRepo.js", () => ({
  getConnectorCredentialBundle: vi.fn(async () => h.bundle),
  saveConnectorCredentialBundle: vi.fn(),
  deleteConnectorCredentialBundle: vi.fn(),
}));

import { saveConnectorCredentialBundle } from "../../credentials/credentialsRepo.js";
import { GithubConnector, type GithubCredentialPayload } from "../githubConnector.js";
import { PendingStore } from "../pendingStore.js";

function fetchOk(body: unknown): typeof globalThis.fetch {
  return vi.fn(async () =>
    new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } }),
  ) as unknown as typeof globalThis.fetch;
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = () => {};
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("GithubConnector probe", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.bundle = {
      version: 1,
      connectorId: "github",
      revision: 1,
      payload: {
        strategy: "oauth2-device",
        version: 1,
        grantedScopes: ["repo"],
        account: { id: "1", displayName: "@octo" },
        token: "tok-test",
      },
    };
  });

  it("probe 成功后 status 带 lastCheckedAt(luna e2e 回归)", async () => {
    vi.mocked(saveConnectorCredentialBundle).mockImplementationOnce(async (_connectorId, payload) => {
      h.bundle = {
        version: 1,
        connectorId: "github",
        revision: 2,
        payload: payload as GithubCredentialPayload,
      };
      return h.bundle as never;
    });
    const connector = new GithubConnector({ clientId: "cid", fetch: fetchOk({ id: 1, login: "octo" }) });
    const before = await connector.status();
    expect(before.state).toBe("connected");
    expect(before.lastCheckedAt).toBeNull();
    expect(before.statusFreshness).toBe("unknown");

    const probed = await connector.probe();
    expect(probed.state).toBe("connected");
    expect(probed.lastCheckedAt).not.toBeNull();
    expect(Number.isNaN(Date.parse(probed.lastCheckedAt!))).toBe(false);

    // 后续 status 查询也应保留探活时间
    const after = await connector.status();
    expect(after.lastCheckedAt).toBe(probed.lastCheckedAt);
    expect(after.statusFreshness).toBe("fresh");
  });

  it("已确认失效的凭证在连接器重建后仍保持 needs_reauth", async () => {
    vi.mocked(saveConnectorCredentialBundle).mockImplementationOnce(async (_connectorId, payload) => {
      h.bundle = {
        version: 1,
        connectorId: "github",
        revision: 2,
        payload: payload as GithubCredentialPayload,
      };
      return h.bundle as never;
    });
    const unauthorized = vi.fn(async () =>
      new Response(JSON.stringify({ message: "Bad credentials" }), { status: 401 })
    ) as unknown as typeof globalThis.fetch;

    const connector = new GithubConnector({ clientId: "cid", fetch: unauthorized });
    await expect(connector.probe()).resolves.toMatchObject({
      state: "needs_reauth",
      reasonCode: "NEEDS_REAUTH",
      statusFreshness: "fresh",
    });

    const restarted = new GithubConnector({ clientId: "cid", fetch: unauthorized });
    await expect(restarted.status()).resolves.toMatchObject({
      state: "needs_reauth",
      reasonCode: "NEEDS_REAUTH",
      statusFreshness: "fresh",
    });
  });
});

describe("GithubConnector 授权生命周期", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.bundle = null;
  });

  it("disconnect 后保存事务内的代际 guard 拒绝迟到凭证写入", async () => {
    const saveEntered = deferred();
    const releaseSave = deferred();
    let writeGuard: (() => boolean) | undefined;
    vi.mocked(saveConnectorCredentialBundle).mockImplementationOnce(async (_connectorId, _payload, options) => {
      writeGuard = options?.writeGuard;
      saveEntered.resolve();
      await releaseSave.promise;
      if (!writeGuard?.()) {
        throw Object.assign(new Error("连接器授权已取消"), {
          code: "CONNECTOR_CREDENTIAL_WRITE_CANCELLED",
        });
      }
      throw new Error("测试期望 disconnect 使 writeGuard 失效");
    });
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/login/device/code")) {
        return new Response(JSON.stringify({
          device_code: "device-public",
          user_code: "PUBLIC",
          verification_uri: "https://github.test/device",
          expires_in: 300,
          interval: 1,
        }));
      }
      if (url.endsWith("/login/oauth/access_token")) {
        return new Response(JSON.stringify({
          access_token: "token-public",
          token_type: "bearer",
          scope: "public_repo",
        }));
      }
      if (url.endsWith("/user")) {
        return new Response(JSON.stringify({ id: 1, login: "octo" }));
      }
      throw new Error(`unexpected ${url}`);
    }) as typeof globalThis.fetch;
    const connector = new GithubConnector({
      clientId: "cid",
      oauthBaseUrl: "https://github.test",
      apiBaseUrl: "https://api.github.test",
      fetch,
      sleep: async () => {},
    });

    await connector.start({ scope: "public_repo" });
    await saveEntered.promise;
    await expect(connector.disconnect()).resolves.toMatchObject({ state: "disconnected" });
    expect(writeGuard).toBeTypeOf("function");
    expect(writeGuard?.()).toBe(false);
    releaseSave.resolve();
    await vi.waitFor(() => expect(saveConnectorCredentialBundle).toHaveBeenCalledTimes(1));
    await expect(connector.status()).resolves.toMatchObject({ state: "disconnected" });
    expect(h.bundle).toBeNull();
  });

  it("不同 scope 的并发 start 不共享授权卡", async () => {
    const publicStarted = deferred();
    const releasePublic = deferred();
    const requestedScopes: string[] = [];
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/login/device/code")) {
        const scope = new URLSearchParams(String(init?.body)).get("scope")!;
        requestedScopes.push(scope);
        if (scope === "public_repo") {
          publicStarted.resolve();
          await releasePublic.promise;
        }
        return new Response(JSON.stringify({
          device_code: `device-${scope}`,
          user_code: scope === "repo" ? "PRIVATE" : "PUBLIC",
          verification_uri: "https://github.test/device",
          expires_in: 300,
          interval: 1,
        }));
      }
      throw new Error(`unexpected ${url}`);
    }) as typeof globalThis.fetch;
    const connector = new GithubConnector({
      clientId: "cid",
      oauthBaseUrl: "https://github.test",
      fetch,
      sleep: (_ms, signal) => new Promise<void>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
      }),
    });

    const publicStart = connector.start({ scope: "public_repo" });
    await publicStarted.promise;
    const privateStart = connector.start({ scope: "repo" });
    releasePublic.resolve();

    await expect(publicStart).resolves.toMatchObject({ user_code: "PUBLIC" });
    await expect(privateStart).resolves.toMatchObject({ user_code: "PRIVATE" });
    expect(requestedScopes).toEqual(["public_repo", "repo"]);
    await connector.disconnect();
  });

  it("切换 scope 时取消旧 device flow 并只保留新 pending", async () => {
    const pendingStore = new PendingStore({ createId: (() => {
      let sequence = 0;
      return () => `pending-${++sequence}`;
    })() });
    const pollSignals: AbortSignal[] = [];
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/login/device/code")) {
        const scope = new URLSearchParams(String(init?.body)).get("scope")!;
        return new Response(JSON.stringify({
          device_code: `device-${scope}`,
          user_code: scope === "repo" ? "PRIVATE" : "PUBLIC",
          verification_uri: "https://github.test/device",
          expires_in: 300,
          interval: 1,
        }));
      }
      throw new Error(`unexpected ${url}`);
    }) as typeof globalThis.fetch;
    const connector = new GithubConnector({
      clientId: "cid",
      oauthBaseUrl: "https://github.test",
      fetch,
      pendingStore: pendingStore as never,
      sleep: (_ms, signal) => {
        pollSignals.push(signal);
        return new Promise<void>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
        });
      },
    });

    const first = await connector.start({ scope: "public_repo" });
    await vi.waitFor(() => expect(pollSignals).toHaveLength(1));
    const second = await connector.start({ scope: "repo" });
    await vi.waitFor(() => expect(pollSignals).toHaveLength(2));

    expect(first).toMatchObject({ pendingId: "pending-1", user_code: "PUBLIC" });
    expect(second).toMatchObject({ pendingId: "pending-2", user_code: "PRIVATE" });
    expect(pollSignals[0]?.aborted).toBe(true);
    expect(pendingStore.size).toBe(1);
    expect(pendingStore.current("github", "default:public_repo")).toBeNull();
    expect(pendingStore.current("github", "default:repo")?.pendingId).toBe("pending-2");
    await connector.disconnect();
  });
});
