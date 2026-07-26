import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type {
  ConfirmGrant,
  ConfirmGrantKind,
  ConfirmGrantSource,
  ConfirmGrantState,
} from "@qingagent/db";
import { createSecuritySettingsRoutes } from "../routes/securitySettings";

function makeHarness(initial: ConfirmGrant[] = []) {
  const stored = new Map<ConfirmGrantKind, ConfirmGrant>(initial.map((grant) => [grant.kind, grant]));
  const created: Array<{ kind: ConfirmGrantKind; source: ConfirmGrantSource }> = [];
  const revoked: ConfirmGrantKind[] = [];
  const versions = new Map<ConfirmGrantKind, number>([["install", 0], ["command", 0]]);
  const app = new Hono();
  app.route("/api/v1", createSecuritySettingsRoutes({
    listGrantStates: async () => (["install", "command"] as const).map((kind): ConfirmGrantState => {
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
  }));
  return { app, stored, created, revoked };
}

async function post(
  app: Hono,
  kind: string,
  body: { grantMode: "ask" | "always" },
) {
  return app.request(`/api/v1/settings/security/${kind}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("安全设置路由", () => {
  it("读取真实授权档位，send/connect 只有每次询问", async () => {
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
        { kind: "install", label: "安装", grantMode: "ask", grantModes: ["ask", "always"] },
        { kind: "command", label: "同类操作", grantMode: "always", grantModes: ["ask", "always"] },
        { kind: "send", label: "向外发送内容", grantMode: "ask", grantModes: ["ask"] },
        { kind: "connect", label: "连接账号", grantMode: "ask", grantModes: ["ask"] },
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

  it.each(["send", "connect"])("%s 设置写入始终 hard reject", async (kind) => {
    const harness = makeHarness();
    const response = await post(harness.app, kind, { grantMode: "always" });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "这类操作只能每次询问，不能改为自动进行。",
    });
    expect(harness.created).toHaveLength(0);
    expect(harness.revoked).toHaveLength(0);
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
      listGrantStates: async () => (["install", "command"] as const).map((kind) => ({
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
});
