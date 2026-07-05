import { afterEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { isDebugEndpointEnabled, isExternallyExposed } from "../lib/debugGate";

afterEach(() => {
  delete process.env.QINGAGENT_ENABLE_DEBUG;
  delete process.env.QINGAGENT_HOST;
  delete process.env.QINGAGENT_PUBLIC_DEPLOYMENT;
  delete process.env.QINGAGENT_AUTH_TOKEN;
  vi.doUnmock("@qingagent/core");
  vi.doUnmock("../routes/skills");
  vi.resetModules();
});

describe("isExternallyExposed", () => {
  it("默认未设 host/PUBLIC 时判定为非对外暴露", () => {
    expect(isExternallyExposed()).toBe(false);
  });

  it("QINGAGENT_HOST=0.0.0.0 时判定为对外暴露", () => {
    process.env.QINGAGENT_HOST = "0.0.0.0";

    expect(isExternallyExposed()).toBe(true);
  });

  it("回环 host 仍判定为非对外暴露", () => {
    for (const host of ["127.0.0.1", "::1", "localhost"]) {
      process.env.QINGAGENT_HOST = host;

      expect(isExternallyExposed()).toBe(false);
    }
  });

  it("QINGAGENT_PUBLIC_DEPLOYMENT=1 会覆盖回环 host 判定为对外暴露", () => {
    process.env.QINGAGENT_HOST = "127.0.0.1";
    process.env.QINGAGENT_PUBLIC_DEPLOYMENT = "1";

    expect(isExternallyExposed()).toBe(true);
  });
});

describe("isDebugEndpointEnabled", () => {
  it("回环非 PUBLIC:未显式 ENABLE_DEBUG 时关闭,ENABLE_DEBUG=1 时开放且无需 token", () => {
    expect(isDebugEndpointEnabled()).toBe(false);

    process.env.QINGAGENT_ENABLE_DEBUG = "1";

    expect(isDebugEndpointEnabled()).toBe(true);
  });

  it("HOST=0.0.0.0 对外暴露:必须同时 ENABLE_DEBUG=1 且有 AUTH_TOKEN 才开放", () => {
    process.env.QINGAGENT_HOST = "0.0.0.0";

    expect(isDebugEndpointEnabled()).toBe(false);

    process.env.QINGAGENT_ENABLE_DEBUG = "1";
    expect(isDebugEndpointEnabled()).toBe(false);

    process.env.QINGAGENT_AUTH_TOKEN = "secret-xyz";
    expect(isDebugEndpointEnabled()).toBe(true);
  });

  it("PUBLIC=1 对外暴露:必须同时 ENABLE_DEBUG=1 且有 AUTH_TOKEN 才开放", () => {
    process.env.QINGAGENT_PUBLIC_DEPLOYMENT = "1";

    expect(isDebugEndpointEnabled()).toBe(false);

    process.env.QINGAGENT_ENABLE_DEBUG = "1";
    expect(isDebugEndpointEnabled()).toBe(false);

    process.env.QINGAGENT_AUTH_TOKEN = "secret-xyz";
    expect(isDebugEndpointEnabled()).toBe(true);
  });
});

async function loadDebugRouteApp() {
  vi.doMock("@qingagent/core", () => ({
    DEEPSEEK_CONTEXT_WINDOWS: { "deepseek-v4-flash": 1_000_000 },
    DEEPSEEK_MODEL_IDS: { flash: "deepseek-v4-flash" },
    describeToolsForDebug: vi.fn(async () => []),
    latestAgentUsageForSession: vi.fn(async () => null),
    readDisabledSet: vi.fn(async () => new Set<string>()),
  }));
  vi.doMock("../routes/skills", () => ({
    listAllSkillItems: vi.fn(async () => []),
  }));

  const { debugRoutes } = await import("../routes/debug");
  const app = new Hono();
  app.route("/api/v1", debugRoutes);
  return app;
}

async function loadDataAdminRouteApp() {
  vi.doMock("@qingagent/core", () => ({
    getDocumentsClient: vi.fn(() => ({
      execute: vi.fn(async () => ({ rows: [{ n: 0 }], rowsAffected: 0 })),
    })),
    listSessionThreads: vi.fn(async () => ({ threads: [] })),
  }));

  const { dataAdminRoutes } = await import("../routes/dataAdmin");
  const app = new Hono();
  app.route("/api/v1", dataAdminRoutes);
  return app;
}

describe("debug/dataAdmin 路由门", () => {
  it("debug 默认返回 404 且不暴露路由存在", async () => {
    const app = await loadDebugRouteApp();

    const res = await app.request("/api/v1/debug/skills");

    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toEqual({ error: "not found" });
  });

  it("debug 在回环形态显式 ENABLE_DEBUG=1 后放行到实际路由", async () => {
    process.env.QINGAGENT_ENABLE_DEBUG = "1";
    const app = await loadDebugRouteApp();

    const res = await app.request("/api/v1/debug/skills");

    expect(res.status).not.toBe(404);
  });

  it("dataAdmin 默认返回 404 且不暴露路由存在", async () => {
    const app = await loadDataAdminRouteApp();

    const res = await app.request("/api/v1/data/stats");

    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toEqual({ error: "not found" });
  });

  it("路径前缀精确匹配:参数恰为 data/debug 的兄弟路由不被门误拦", async () => {
    // Hono 子 app 的 use("*") 会看到后续兄弟路由;若门用 includes 判段名,
    // /api/v1/skills/data/enable 这类"参数恰为 data"的路径会被误 404。
    const debugApp = await loadDebugRouteApp();
    const dataApp = await loadDataAdminRouteApp();

    // 门未开(未设 ENABLE_DEBUG):非 debug/data 段路径必须放行(穿透到无匹配路由的原生 404,
    // 而非门的 {error:"not found"} JSON——用一个挂在后面的探针路由区分)。
    const probe = new Hono();
    probe.get("/api/v1/skills/data/enable-probe", (c) => c.json({ ok: true }));
    debugApp.route("/", probe);
    dataApp.route("/", probe);

    const viaDebugGate = await debugApp.request("/api/v1/skills/data/enable-probe");
    expect(viaDebugGate.status).toBe(200);
    const viaDataGate = await dataApp.request("/api/v1/skills/data/enable-probe");
    expect(viaDataGate.status).toBe(200);
  });
});
