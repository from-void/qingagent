import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { createCredentialShareRoutes } from "../routes/credentialShare";

const request = {
  skillName: "feishu",
  skillLabel: "连飞书",
  declared: "~/.lark-cli",
  path: "/home/tester/.lark-cli",
};

function app(overrides: Parameters<typeof createCredentialShareRoutes>[0] = {}) {
  const routes = createCredentialShareRoutes({
    listRequests: async () => [request],
    listGrants: async () => [],
    ...overrides,
  });
  const server = new Hono();
  server.route("/api/v1", routes);
  return server;
}

function post(body: unknown): Request {
  return new Request("http://localhost/api/v1/settings/credential-share", {
    method: "POST",
    // 同源/无 Origin(curl 形态)放行;这里不带 Origin 即可通过 CSRF 校验。
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("凭证共享设置接口", () => {
  it("列出已启用技能声明的条目与授权状态", async () => {
    const response = await app({
      listGrants: async () => [
        {
          path: request.path,
          grantId: "g1",
          skillName: "feishu",
          declared: "~/.lark-cli",
          createdAt: "2026-07-29T00:00:00.000Z",
          source: "card" as const,
        },
      ],
    }).request("http://localhost/api/v1/settings/credential-share");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      items: [
        {
          skillName: "feishu",
          skillLabel: "连飞书",
          declared: "~/.lark-cli",
          granted: true,
          grantedAt: "2026-07-29T00:00:00.000Z",
        },
      ],
    });
  });

  it("授权时按声明取路径落库,并先把目录建出来", async () => {
    const createGrant = vi.fn(async () => ({
      grant: {
        path: request.path,
        grantId: "g1",
        skillName: "feishu",
        declared: "~/.lark-cli",
        createdAt: "2026-07-29T01:00:00.000Z",
        source: "settings" as const,
      },
      created: true,
    }));
    const ensurePath = vi.fn(async () => undefined);
    const invalidateWorkspaces = vi.fn();
    const response = await app({ createGrant, ensurePath, invalidateWorkspaces }).request(
      post({ skillName: "feishu", declared: "~/.lark-cli", granted: true }),
    );
    expect(response.status).toBe(200);
    expect(ensurePath).toHaveBeenCalledWith(request.path);
    expect(createGrant).toHaveBeenCalledWith(
      expect.objectContaining({ path: request.path, skillName: "feishu", source: "settings" }),
    );
    expect(invalidateWorkspaces).toHaveBeenCalledWith();
    expect(await response.json()).toMatchObject({ granted: true });
  });

  it("回收授权", async () => {
    const revokeGrant = vi.fn(async () => null);
    const invalidateWorkspaces = vi.fn();
    const response = await app({ revokeGrant, invalidateWorkspaces }).request(
      post({ skillName: "feishu", declared: "~/.lark-cli", granted: false }),
    );
    expect(response.status).toBe(200);
    expect(revokeGrant).toHaveBeenCalledWith(request.path);
    expect(invalidateWorkspaces).toHaveBeenCalledWith();
    expect(await response.json()).toMatchObject({ granted: false, grantedAt: null });
  });

  it("请求体里的路径不作数:没被任何已启用技能声明就拒绝", async () => {
    const createGrant = vi.fn();
    const response = await app({ createGrant }).request(
      post({ skillName: "feishu", declared: "~/.ssh", granted: true }),
    );
    expect(response.status).toBe(404);
    expect(createGrant).not.toHaveBeenCalled();
    expect(await response.json()).toEqual({ error: "这个技能现在没有请求共享这个位置。" });
  });

  it("按需申请拿到的授权(没有技能声明)也列得出、收得回", async () => {
    const adhoc = {
      path: "/home/tester/.fakecli",
      grantId: "g2",
      skillName: "",
      declared: "~/.fakecli",
      createdAt: "2026-07-29T02:00:00.000Z",
      source: "card" as const,
    };
    const revokeGrant = vi.fn(async () => null);
    const invalidateWorkspaces = vi.fn();
    const server = app({
      listGrants: async () => [adhoc],
      revokeGrant,
      invalidateWorkspaces,
    });

    const listed = await server.request("http://localhost/api/v1/settings/credential-share");
    expect((await listed.json()).items).toContainEqual({
      skillName: "",
      skillLabel: "命令行工具",
      declared: "~/.fakecli",
      granted: true,
      grantedAt: "2026-07-29T02:00:00.000Z",
    });

    const revoked = await server.request(
      post({ skillName: "", declared: "~/.fakecli", granted: false }),
    );
    expect(revoked.status).toBe(200);
    expect(revokeGrant).toHaveBeenCalledWith("/home/tester/.fakecli");
    expect(invalidateWorkspaces).toHaveBeenCalledWith();
    expect(await revoked.json()).toMatchObject({ granted: false, skillLabel: "命令行工具" });
  });

  it("按需授权不能靠这个接口新增:授权仍只认技能声明", async () => {
    const createGrant = vi.fn();
    const response = await app({ createGrant }).request(
      post({ skillName: "", declared: "~/.fakecli", granted: true }),
    );
    expect(response.status).toBe(404);
    expect(createGrant).not.toHaveBeenCalled();
  });

  it("请求体不合法时给中文提示", async () => {
    const response = await app().request(post({ skillName: "feishu" }));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "设置内容不完整，请再试一次。" });
  });
});
