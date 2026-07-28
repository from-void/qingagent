import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const grants: Array<{
    path: string;
    grantId: string;
    skillName: string;
    declared: string;
    createdAt: string;
    source: "card";
  }> = [];
  const prepareReadWall = vi.fn(async (options: {
    grantedCredentialPaths?: string[];
    effectiveHome?: string;
    credentialWallMode?: "standard" | "wide";
  }) => ({
    nativeSandbox: {
      allowNetwork: true,
      readOnlyPaths: [],
      readWritePaths: [...(options.grantedCredentialPaths ?? [])],
      bwrapArgs: [],
    },
    effectiveHome: options.effectiveHome ?? "/home/tester",
    policyHash: JSON.stringify(options.grantedCredentialPaths ?? []),
    ruleCount: 1,
    warnings: [],
    mode: "bwrap-read-wall" as const,
    credentialPaths: [...(options.grantedCredentialPaths ?? [])],
    credentialWallMode: options.credentialWallMode ?? "standard",
    verifyIntegrity: async () => undefined,
  }));
  return { grants, prepareReadWall };
});

vi.mock("@qingagent/db", () => ({
  listCredentialGrants: vi.fn(async () => [...mocks.grants]),
}));

vi.mock("../skills/credentialRequests.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../skills/credentialRequests.js")>();
  return {
    ...actual,
    listCredentialRequests: vi.fn(async () => []),
    ensureCredentialPathExists: vi.fn(async () => undefined),
  };
});

vi.mock("../workspace/readWallSandbox.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../workspace/readWallSandbox.js")>();
  return { ...actual, prepareReadWall: mocks.prepareReadWall };
});

import {
  __resetIsolationCacheForTest,
  __resetSessionWorkspaceCacheForTest,
  getSessionWorkspace,
  invalidateSessionWorkspace,
} from "../workspace/sessionWorkspace.js";

describe("全局凭证授权跨会话失效", () => {
  const opts = { resolveSkillDirs: () => [] as string[] };

  beforeEach(() => {
    mocks.grants.length = 0;
    mocks.prepareReadWall.mockClear();
    __resetSessionWorkspaceCacheForTest();
    __resetIsolationCacheForTest();
    process.env.QINGAGENT_SANDBOX_ISOLATION = "bwrap";
  });

  afterEach(() => {
    delete process.env.QINGAGENT_SANDBOX_ISOLATION;
    __resetSessionWorkspaceCacheForTest();
    __resetIsolationCacheForTest();
  });

  it("A 授权或撤权后，B 下一次获取都会重建并反映最新策略", async () => {
    await getSessionWorkspace("credential-session-a", opts);
    const beforeGrantB = await getSessionWorkspace("credential-session-b", opts);
    expect(mocks.prepareReadWall).toHaveBeenCalledTimes(2);

    const credentialPath = "/home/tester/.fakecli";
    mocks.grants.push({
      path: credentialPath,
      grantId: "grant-1",
      skillName: "",
      declared: "~/.fakecli",
      createdAt: "2026-07-28T00:00:00.000Z",
      source: "card",
    });
    invalidateSessionWorkspace();

    const afterGrantB = await getSessionWorkspace("credential-session-b", opts);
    expect(afterGrantB).not.toBe(beforeGrantB);
    expect(mocks.prepareReadWall).toHaveBeenLastCalledWith(
      expect.objectContaining({ grantedCredentialPaths: [credentialPath] }),
    );

    mocks.grants.length = 0;
    invalidateSessionWorkspace();

    const afterRevokeB = await getSessionWorkspace("credential-session-b", opts);
    expect(afterRevokeB).not.toBe(afterGrantB);
    expect(mocks.prepareReadWall).toHaveBeenLastCalledWith(
      expect.objectContaining({ grantedCredentialPaths: [] }),
    );
  });
});
