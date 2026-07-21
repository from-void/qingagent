import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { ConfirmGrant, ConfirmGrantKind, ConfirmGrantSource } from "@qingagent/db";
import { ConfirmUiGrantStore } from "../lib/confirmUiGrant";
import { createSecuritySettingsRoutes } from "../routes/securitySettings";

function makeHarness(initial: ConfirmGrant[] = []) {
  const stored = new Map<ConfirmGrantKind, ConfirmGrant>(initial.map((grant) => [grant.kind, grant]));
  const created: ConfirmGrantKind[] = [];
  const revoked: ConfirmGrantKind[] = [];
  let sequence = 0;
  const nonces = new ConfirmUiGrantStore({ createNonce: () => `settings-nonce-${sequence++}` });
  const app = new Hono();
  app.route("/api/v1", createSecuritySettingsRoutes({
    listGrants: async () => [...stored.values()],
    createGrant: async ({ kind, source }) => {
      created.push(kind);
      const grant = {
        grantId: `grant-${kind}`,
        kind,
        source,
        createdAt: new Date().toISOString(),
      };
      stored.set(kind, grant);
      return grant;
    },
    revokeGrant: async (kind) => {
      revoked.push(kind);
      const grant = stored.get(kind) ?? null;
      stored.delete(kind);
      return grant;
    },
    consumeUiGrant: (input) => nonces.consume(input),
    insecureRememberAllowed: () => false,
  }));
  return { app, stored, created, revoked, nonces };
}

async function post(
  app: Hono,
  kind: string,
  body: { needConfirmation: boolean; uiGrantNonce?: string },
) {
  return app.request(`/api/v1/settings/security/${kind}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("安全设置路由", () => {
  it("读取四类开关，send/connect 固定为始终确认", async () => {
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
        { kind: "install", needConfirmation: true, mutable: true },
        { kind: "command", needConfirmation: false, mutable: true },
        { kind: "send", needConfirmation: true, mutable: false },
        { kind: "connect", needConfirmation: true, mutable: false },
      ],
    });
  });

  it("关闭确认必须消费 settings+kind 绑定 nonce，重放拒绝", async () => {
    const harness = makeHarness();
    expect((await post(harness.app, "command", { needConfirmation: false })).status).toBe(403);
    const nonce = harness.nonces.register({ purpose: "settings", kind: "command" });
    const response = await post(harness.app, "command", {
      needConfirmation: false,
      uiGrantNonce: nonce,
    });
    expect(response.status).toBe(200);
    expect(harness.created).toEqual(["command"]);
    expect((await post(harness.app, "command", {
      needConfirmation: false,
      uiGrantNonce: nonce,
    })).status).toBe(403);
  });

  it("恢复需要确认属于收紧方向，不需要 nonce 即撤销", async () => {
    const harness = makeHarness([{
      grantId: "grant-install",
      kind: "install",
      source: "card",
      createdAt: new Date().toISOString(),
    }]);
    const response = await post(harness.app, "install", { needConfirmation: true });
    expect(response.status).toBe(200);
    expect(harness.revoked).toEqual(["install"]);
    expect(harness.stored.has("install")).toBe(false);
  });

  it.each(["send", "connect"])("%s 设置写入始终 hard reject", async (kind) => {
    const harness = makeHarness();
    const response = await post(harness.app, kind, { needConfirmation: false });
    expect(response.status).toBe(400);
    expect(harness.created).toHaveLength(0);
    expect(harness.revoked).toHaveLength(0);
  });

  it("不安全开发开关显式开启时才允许无 nonce 创建", async () => {
    const createGrant = vi.fn(async ({ kind, source }: {
      kind: ConfirmGrantKind;
      source: ConfirmGrantSource;
    }) => ({ grantId: "dev-grant", kind, source, createdAt: new Date().toISOString() }));
    const app = new Hono();
    app.route("/api/v1", createSecuritySettingsRoutes({
      listGrants: async () => [],
      createGrant,
      insecureRememberAllowed: () => true,
    }));
    expect((await post(app, "command", { needConfirmation: false })).status).toBe(200);
    expect(createGrant).toHaveBeenCalledOnce();
  });
});
