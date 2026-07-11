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
            const allowed = origin !== "evil" && gateOn && !publicDeployment;
            expect(probe.status).toBe(allowed ? 200 : 403);
            expect(disconnect.status).toBe(allowed ? 200 : 403);
            expect(service.probe).toHaveBeenCalledTimes(allowed ? 1 : 0);
            expect(service.disconnect).toHaveBeenCalledTimes(allowed ? 1 : 0);
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
