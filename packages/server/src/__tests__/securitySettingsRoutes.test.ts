import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type {
  ConfirmGrant,
  ConfirmGrantKind,
  ConfirmGrantMutation,
  ConfirmGrantSource,
  ConfirmGrantState,
} from "@qingagent/db";
import { createSecuritySettingsRoutes } from "../routes/securitySettings";

function makeHarness(
  initial: ConfirmGrant[] = [],
  initialBypass: { enabled: boolean; enabledAt: string | null } = {
    enabled: false,
    enabledAt: null,
  },
) {
  // 「以后不用再问我」在这一页必须可见、可一键改回;改回即恢复默认形态。
  const bypass = { ...initialBypass };
  const bypassWrites: boolean[] = [];
  const stored = new Map<ConfirmGrantKind, ConfirmGrant>(initial.map((grant) => [grant.kind, grant]));
  const created: Array<{ kind: ConfirmGrantKind; source: ConfirmGrantSource }> = [];
  const revoked: ConfirmGrantKind[] = [];
  const versions = new Map<ConfirmGrantKind, number>([
    ["install", 0],
    ["command", 0],
    ["send", 0],
    ["connect", 0],
  ]);
  const app = new Hono();
  app.route("/api/v1", createSecuritySettingsRoutes({
    listGrantStates: async () =>
      (["install", "command", "send", "connect"] as const).map((kind): ConfirmGrantState => {
      const grant = stored.get(kind) ?? null;
      return {
        kind,
        present: grant !== null,
        grantId: grant?.grantId ?? null,
        version: versions.get(kind) ?? 0,
        revocationEpoch: 0,
        grant,
      };
    }),
    createGrant: async ({ kind, source }) => {
      created.push({ kind, source });
      const grant = {
        grantId: `grant-${kind}`,
        kind,
        source,
        createdAt: new Date().toISOString(),
      };
      stored.set(kind, grant);
      const version = (versions.get(kind) ?? 0) + 1;
      versions.set(kind, version);
      return {
        grant,
        created: true,
        stale: false,
        state: {
          kind,
          present: true,
          grantId: grant.grantId,
          version,
          revocationEpoch: 0,
          grant,
        },
      };
    },
    revokeGrant: async (kind) => {
      revoked.push(kind);
      const grant = stored.get(kind) ?? null;
      stored.delete(kind);
      const version = (versions.get(kind) ?? 0) + 1;
      versions.set(kind, version);
      return {
        revokedGrant: grant,
        state: {
          kind,
          present: false,
          grantId: null,
          version,
          revocationEpoch: version,
          grant: null,
        },
      };
    },
    readBypass: async () => ({ ...bypass }),
    writeBypass: async (enabled: boolean) => {
      bypassWrites.push(enabled);
      bypass.enabled = enabled;
      bypass.enabledAt = enabled ? "2026-07-29T00:00:00.000Z" : null;
      return { ...bypass };
    },
  }));
  return { app, stored, created, revoked, bypass, bypassWrites };
}

async function post(
  app: Hono,
  kind: string,
  body: {
    grantMode: "ask" | "always";
    operationId?: string;
    baseVersion?: number;
  },
) {
  return app.request(`/api/v1/settings/security/${kind}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("安全设置路由:「以后不用再问我」", () => {
  it("默认形态在设置页读出来就是未开启", async () => {
    const harness = makeHarness();
    const response = await harness.app.request("/api/v1/settings/security");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      bypass: { enabled: false, enabledAt: null },
    });
  });

  it("已开启时设置页看得到当前状态", async () => {
    const harness = makeHarness([], {
      enabled: true,
      enabledAt: "2026-07-29T00:00:00.000Z",
    });
    const response = await harness.app.request("/api/v1/settings/security");
    expect(await response.json()).toMatchObject({
      bypass: { enabled: true, enabledAt: "2026-07-29T00:00:00.000Z" },
    });
  });

  it("可以一键改回默认:关掉后再读就是未开启", async () => {
    const harness = makeHarness([], {
      enabled: true,
      enabledAt: "2026-07-29T00:00:00.000Z",
    });
    const response = await harness.app.request("/api/v1/settings/security/bypass", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ enabled: false, enabledAt: null });
    expect(harness.bypassWrites).toEqual([false]);

    const reread = await harness.app.request("/api/v1/settings/security");
    expect(await reread.json()).toMatchObject({ bypass: { enabled: false } });
  });

  it("也可以在设置页直接开启", async () => {
    const harness = makeHarness();
    const response = await harness.app.request("/api/v1/settings/security/bypass", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: true }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ enabled: true });
    expect(harness.bypassWrites).toEqual([true]);
  });

  it("bypass 不会被当成第五个确认类别", async () => {
    const harness = makeHarness();
    const response = await harness.app.request("/api/v1/settings/security");
    const body = await response.json() as { categories: Array<{ kind: string }> };
    expect(body.categories.map((item) => item.kind)).toEqual([
      "install",
      "command",
      "send",
      "connect",
    ]);
  });

  it("不受信 Origin 不能借设置端点关闭询问", async () => {
    const harness = makeHarness();
    const response = await harness.app.request("/api/v1/settings/security/bypass", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "https://evil.example",
      },
      body: JSON.stringify({ enabled: true }),
    });
    expect(response.status).toBe(403);
    expect(harness.bypassWrites).toEqual([]);
  });

  it("请求体不合法时不改动状态", async () => {
    const harness = makeHarness();
    const response = await harness.app.request("/api/v1/settings/security/bypass", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: "yes" }),
    });
    expect(response.status).toBe(400);
    expect(harness.bypassWrites).toEqual([]);
  });
});

describe("安全设置路由", () => {
  it("读取真实授权档位，四类都可在每次询问 / 始终允许之间选", async () => {
    const harness = makeHarness([{
      grantId: "grant-command",
      kind: "command",
      source: "settings",
      createdAt: new Date().toISOString(),
    }]);
    const response = await harness.app.request("/api/v1/settings/security");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      categories: [
        { kind: "install", label: "安装软件", grantMode: "ask", grantModes: ["ask", "always"] },
        { kind: "command", label: "删除或移动文件", grantMode: "always", grantModes: ["ask", "always"] },
        { kind: "send", label: "向外发送内容", grantMode: "ask", grantModes: ["ask", "always"] },
        { kind: "connect", label: "连接账号", grantMode: "ask", grantModes: ["ask", "always"] },
      ],
    });
  });

  it("未走过确认卡也能从可信设置端点直接创建 settings grant", async () => {
    const harness = makeHarness();
    const response = await post(harness.app, "command", {
      grantMode: "always",
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      kind: "command",
      grantMode: "always",
      present: true,
    });
    expect(harness.created).toEqual([{ kind: "command", source: "settings" }]);
  });

  it("不受信 Origin 不能借设置端点创建 grant", async () => {
    const harness = makeHarness();
    const response = await harness.app.request("/api/v1/settings/security/install", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "https://evil.example",
      },
      body: JSON.stringify({ grantMode: "always" }),
    });
    expect(response.status).toBe(403);
    expect(harness.created).toHaveLength(0);
  });

  it("恢复需要确认属于收紧方向，不需要 nonce 即撤销", async () => {
    const harness = makeHarness([{
      grantId: "grant-install",
      kind: "install",
      source: "card",
      createdAt: new Date().toISOString(),
    }]);
    const response = await post(harness.app, "install", { grantMode: "ask" });
    expect(response.status).toBe(200);
    expect(harness.revoked).toEqual(["install"]);
    expect(harness.stored.has("install")).toBe(false);
  });

  it.each(["send", "connect"])("%s 也能设为始终允许并撤回", async (kind) => {
    const harness = makeHarness();
    const grantKind = kind as ConfirmGrantKind;
    const always = await post(harness.app, kind, { grantMode: "always" });
    expect(always.status).toBe(200);
    expect(await always.json()).toMatchObject({ kind, grantMode: "always", present: true });
    expect(harness.created).toEqual([{ kind: grantKind, source: "settings" }]);

    const back = await post(harness.app, kind, { grantMode: "ask" });
    expect(back.status).toBe(200);
    expect(await back.json()).toMatchObject({ kind, grantMode: "ask", present: false });
    expect(harness.revoked).toEqual([grantKind]);
  });

  it("未知类别仍然拒绝", async () => {
    const harness = makeHarness();
    const response = await post(harness.app, "unknown-kind", { grantMode: "always" });
    expect(response.status).toBe(400);
    expect(harness.created).toHaveLength(0);
  });

  it("设置内容不完整时返回可行动说明", async () => {
    const harness = makeHarness();
    const response = await harness.app.request("/api/v1/settings/security/install", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "设置内容不完整，请再试一次。",
    });
  });

  it("创建返回数据库 canonical 状态", async () => {
    const createGrant = vi.fn(async ({ kind, source }: {
      kind: ConfirmGrantKind;
      source: ConfirmGrantSource;
    }) => ({ grantId: "dev-grant", kind, source, createdAt: new Date().toISOString() }));
    const app = new Hono();
    app.route("/api/v1", createSecuritySettingsRoutes({
      listGrantStates: async () => (["install", "command", "send", "connect"] as const).map((kind) => ({
        kind,
        present: false,
        grantId: null,
        version: 0,
        revocationEpoch: 0,
        grant: null,
      })),
      createGrant: async (input) => {
        const grant = await createGrant(input);
        return {
          grant,
          created: true,
          stale: false,
          state: {
            kind: input.kind,
            present: true,
            grantId: grant.grantId,
            version: 1,
            revocationEpoch: 0,
            grant,
          },
        };
      },
    }));
    expect((await post(app, "command", { grantMode: "always" })).status).toBe(200);
    expect(createGrant).toHaveBeenCalledOnce();
  });

  it("写入响应超时期间可按操作 ID 查询 pending，提交后返回对应版本", async () => {
    let releaseCreate: ((value: ConfirmGrantMutation) => void) | undefined;
    let markCreateStarted: (() => void) | undefined;
    const createResult = new Promise<ConfirmGrantMutation>((resolve) => {
      releaseCreate = resolve;
    });
    const createStarted = new Promise<void>((resolve) => {
      markCreateStarted = resolve;
    });
    const createGrant = vi.fn(async () => {
      markCreateStarted?.();
      return createResult;
    });
    const app = new Hono();
    app.route("/api/v1", createSecuritySettingsRoutes({
      listGrantStates: async () => (["install", "command", "send", "connect"] as const).map((kind) => ({
        kind,
        present: false,
        grantId: null,
        version: 0,
        revocationEpoch: 0,
        grant: null,
      })),
      createGrant,
    }));

    const operationId = "security-operation-late";
    const pendingPost = post(app, "install", {
      grantMode: "always",
      operationId,
      baseVersion: 0,
    });
    await createStarted;

    const pending = await app.request(
      `/api/v1/settings/security?operationId=${operationId}`,
    );
    expect(await pending.json()).toMatchObject({
      operation: {
        operationId,
        kind: "install",
        grantMode: "always",
        baseVersion: 0,
        status: "pending",
      },
    });
    const duplicate = await post(app, "install", {
      grantMode: "always",
      operationId,
      baseVersion: 0,
    });
    expect(duplicate.status).toBe(202);
    expect(createGrant).toHaveBeenCalledOnce();

    const grant = {
      grantId: "grant-install-late",
      kind: "install" as const,
      source: "settings" as const,
      createdAt: new Date().toISOString(),
    };
    releaseCreate?.({
      grant,
      created: true,
      stale: false,
      state: {
        kind: "install",
        present: true,
        grantId: grant.grantId,
        version: 1,
        revocationEpoch: 0,
        grant,
      },
    });
    const postResponse = await pendingPost;
    expect(await postResponse.json()).toMatchObject({
      operationId,
      baseVersion: 0,
      version: 1,
      grantMode: "always",
    });

    const committed = await app.request(
      `/api/v1/settings/security?operationId=${operationId}`,
    );
    expect(await committed.json()).toMatchObject({
      operation: {
        operationId,
        status: "committed",
        result: {
          operationId,
          baseVersion: 0,
          version: 1,
        },
      },
    });
  });
});
