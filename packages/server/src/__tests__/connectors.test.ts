import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConnectorInfoDto } from "@qingagent/core";
import { authTokenMiddleware } from "../lib/authToken";
import { getConnectorRuntimeAccess } from "../lib/connectorRuntimeGate";
import { csrfMutationGuard } from "../lib/trustedOrigin";
import { createConnectorsRoutes } from "../routes/connectors";

const connector: ConnectorInfoDto = {
  id: "wechat-mp",
  name: "微信公众号",
  icon: "wechat",
  official: false,
  authPresentation: "scan",
  riskNote: "risk",
  usedBySkills: ["wechat-official-account"],
  status: {
    state: "connected",
    reasonCode: null,
    account: null,
    scopes: [],
    lastCheckedAt: null,
    statusFreshness: "ttl",
    canProbe: true,
  },
};

function setup(input: { gateOn: boolean; publicDeployment: boolean; authOn: boolean }) {
  const service = {
    list: vi.fn(async () => [connector]),
    info: vi.fn(async () => connector),
    start: vi.fn(async () => ({ user_code: "ABCD-EFGH", verification_uri: "https://example.test/device", expiresAt: "2026-07-11T12:00:00.000Z", pendingId: "pending-safe-id" })),
    cancel: vi.fn(async () => ({
      ...connector,
      status: { ...connector.status, state: "disconnected" as const },
    })),
    probe: vi.fn(async () => connector),
    disconnect: vi.fn(async () => ({
      ...connector,
      status: { ...connector.status, state: "disconnected" as const },
    })),
  };
  const env = {
    QINGAGENT_SINGLE_USER: input.gateOn ? "1" : "0",
    QINGAGENT_PUBLIC_DEPLOYMENT: input.publicDeployment ? "1" : "0",
    QINGAGENT_HOST: "127.0.0.1",
    QINGAGENT_AUTH_TOKEN: input.authOn ? "test-auth-token" : undefined,
  };
  if (input.authOn) process.env.QINGAGENT_AUTH_TOKEN = "test-auth-token";
  else delete process.env.QINGAGENT_AUTH_TOKEN;
  const app = new Hono();
  app.use("/api/*", csrfMutationGuard);
  app.use("/api/*", authTokenMiddleware);
  app.route("/api/v1", createConnectorsRoutes({
    service,
    runtimeAccess: () => getConnectorRuntimeAccess(env),
  }));
  return { app, service };
}

function headers(origin: "trusted" | "evil" | "none", authOn: boolean): HeadersInit {
  return {
    ...(origin === "trusted" ? { Origin: "http://localhost:5173" } : {}),
    ...(origin === "evil" ? { Origin: "https://evil.example" } : {}),
    ...(authOn ? { Authorization: "Bearer test-auth-token" } : {}),
  };
}

afterEach(() => {
  delete process.env.QINGAGENT_AUTH_TOKEN;
});

describe("/api/v1/connectors 安全矩阵", () => {
  const booleans = [false, true] as const;
  const origins = ["trusted", "evil", "none"] as const;

  for (const authOn of booleans) {
    for (const gateOn of booleans) {
      for (const publicDeployment of booleans) {
        for (const origin of origins) {
          it(`auth=${authOn} gate=${gateOn} public=${publicDeployment} origin=${origin}`, async () => {
            const { app, service } = setup({ authOn, gateOn, publicDeployment });
            const requestHeaders = headers(origin, authOn);
            const probe = await app.request("/api/v1/connectors/wechat-mp/probe", {
              method: "POST",
              headers: requestHeaders,
            });
            const disconnect = await app.request("/api/v1/connectors/wechat-mp", {
              method: "DELETE",
              headers: requestHeaders,
            });
            const cancel = await app.request("/api/v1/connectors/wechat-mp/pending/pending-safe-id", {
              method: "DELETE",
              headers: requestHeaders,
            });
            const start = await app.request("/api/v1/connectors/github/start", { method: "POST", headers: { ...requestHeaders, "Content-Type": "application/json" }, body: JSON.stringify({ scope: "public_repo" }) });
            const allowed = origin !== "evil" && gateOn && !publicDeployment;
            expect(probe.status).toBe(allowed ? 200 : 403);
            expect(disconnect.status).toBe(allowed ? 200 : 403);
            expect(cancel.status).toBe(allowed ? 200 : 403);
            expect(start.status).toBe(allowed ? 200 : 403);
            expect(service.probe).toHaveBeenCalledTimes(allowed ? 1 : 0);
            expect(service.disconnect).toHaveBeenCalledTimes(allowed ? 1 : 0);
            expect(service.cancel).toHaveBeenCalledTimes(allowed ? 1 : 0);
            expect(service.start).toHaveBeenCalledTimes(allowed ? 1 : 0);
          });
        }
      }
    }
  }

  it("AUTH_TOKEN 已配置但请求无 token 时在进入 route 前稳定 401", async () => {
    const { app, service } = setup({ authOn: true, gateOn: true, publicDeployment: false });
    const response = await app.request("/api/v1/connectors/wechat-mp/probe", { method: "POST" });
    expect(response.status).toBe(401);
    expect(service.probe).not.toHaveBeenCalled();
  });

  it("start 公开 DTO 不含 device_code/token", async () => {
    const { app } = setup({ authOn: false, gateOn: true, publicDeployment: false });
    const response = await app.request("/api/v1/connectors/github/start", { method: "POST", headers: { Origin: "http://localhost:5173", "Content-Type": "application/json" }, body: JSON.stringify({ scope: "public_repo" }) });
    expect(response.status).toBe(200);
    const raw = await response.text();
    expect(raw).not.toContain("device_code");
    expect(raw).not.toContain("access_token");
    expect(JSON.parse(raw)).toMatchObject({ user_code: "ABCD-EFGH", pendingId: "pending-safe-id" });
  });

  it("cancel 把 connectorId 与 pendingId 原样交给服务层", async () => {
    const { app, service } = setup({
      authOn: false,
      gateOn: true,
      publicDeployment: false,
    });
    const response = await app.request(
      "/api/v1/connectors/github/pending/pending-safe-id",
      { method: "DELETE", headers: { Origin: "http://localhost:5173" } },
    );

    expect(response.status).toBe(200);
    expect(service.cancel).toHaveBeenCalledWith("github", "pending-safe-id");
  });

  it("start 失败按可信机器码返回固定中性文案", async () => {
    const { app, service } = setup({ authOn: false, gateOn: true, publicDeployment: false });
    service.start.mockRejectedValueOnce(Object.assign(new Error("至少选择一个飞书授权域"), {
      code: "INVALID_ARGUMENT",
      status: 400,
    }));

    const response = await app.request("/api/v1/connectors/feishu/start", {
      method: "POST",
      headers: { Origin: "http://localhost:5173", "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "INVALID_ARGUMENT",
      message: "连接参数无效，请检查后重试。",
    });
  });

  it("probe 未分类异常不向前端回显原始内部消息", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { app, service } = setup({
      authOn: false,
      gateOn: true,
      publicDeployment: false,
    });
    service.probe.mockRejectedValueOnce(new TypeError("fetch failed: socket detail"));

    try {
      const response = await app.request("/api/v1/connectors/github/probe", {
        method: "POST",
        headers: { Origin: "http://localhost:5173" },
      });
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({
        error: "CONNECTOR_OPERATION_FAILED",
        message: "连接操作失败，请稍后重试。",
      });
      expect(log).toHaveBeenCalledWith(
        "[connector-route] operation failed",
        { code: null, error: "fetch failed: socket detail" },
      );
    } finally {
      log.mockRestore();
    }
  });

  it("probe 带底层 code 的未知异常仍不回显原始消息", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { app, service } = setup({
      authOn: false,
      gateOn: true,
      publicDeployment: false,
    });
    service.probe.mockRejectedValueOnce(Object.assign(
      new Error("fetch failed: upstream socket detail"),
      { code: "ECONNRESET", status: 503 },
    ));

    try {
      const response = await app.request("/api/v1/connectors/github/probe", {
        method: "POST",
        headers: { Origin: "http://localhost:5173" },
      });
      expect(response.status).toBe(500);
      const body = await response.json();
      expect(body).toEqual({
        error: "CONNECTOR_OPERATION_FAILED",
        message: "连接操作失败，请稍后重试。",
      });
      expect(JSON.stringify(body)).not.toContain("socket");
      expect(log).toHaveBeenCalledWith(
        "[connector-route] operation failed",
        { code: "ECONNRESET", error: "fetch failed: upstream socket detail" },
      );
    } finally {
      log.mockRestore();
    }
  });

  it("gate 关闭时 list/detail 只回 unavailable，adapter 零调用", async () => {
    const { app, service } = setup({ authOn: false, gateOn: false, publicDeployment: false });
    const list = await app.request("/api/v1/connectors");
    const detail = await app.request("/api/v1/connectors/feishu");
    expect(list.status).toBe(200);
    expect(detail.status).toBe(200);
    const listBody = await list.json() as { connectors: ConnectorInfoDto[] };
    expect(listBody.connectors).toHaveLength(3);
    expect(listBody.connectors.every((item) => item.status.state === "unavailable")).toBe(true);
    expect((await detail.json() as ConnectorInfoDto).status.state).toBe("unavailable");
    expect(service.list).not.toHaveBeenCalled();
    expect(service.info).not.toHaveBeenCalled();
  });

  it("public flag 优先于 single-user，GET reasonCode 稳定", async () => {
    const { app, service } = setup({ authOn: false, gateOn: true, publicDeployment: true });
    const body = await (await app.request("/api/v1/connectors")).json() as { connectors: ConnectorInfoDto[] };
    expect(body.connectors.every((item) => item.status.reasonCode === "PUBLIC_DEPLOYMENT")).toBe(true);
    expect(service.list).not.toHaveBeenCalled();
  });
});
