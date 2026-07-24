import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BrowserContext } from "playwright";
import {
  getAgentBrowser,
  getAgentBrowserTools,
  installAgentBrowserRequestPolicy,
  isAgentBrowserEnabled,
  resetAgentBrowserForTest,
} from "./agentBrowser.js";

const ENV_KEYS = [
  "QINGAGENT_AGENT_BROWSER",
  "QINGAGENT_BROWSER_CDP_URL",
  "QINGAGENT_BROWSER_STORAGE_STATE",
  "QINGAGENT_BROWSER_HEADFUL",
  "QINGAGENT_BROWSER_ALLOW_DOMAINS",
  "QINGAGENT_BROWSER_PROXY_ACL",
  "HTTPS_PROXY",
  "https_proxy",
  "HTTP_PROXY",
  "http_proxy",
];

describe("agentBrowser 接入", () => {
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const k of ENV_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    resetAgentBrowserForTest();
  });
  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    resetAgentBrowserForTest();
  });

  it("默认关闭:未配置任何环境变量 → 不启用、无工具", () => {
    expect(isAgentBrowserEnabled()).toBe(false);
    expect(getAgentBrowserTools()).toEqual({});
  });

  it("QINGAGENT_AGENT_BROWSER=1 → 启用", () => {
    process.env.QINGAGENT_AGENT_BROWSER = "1";
    expect(isAgentBrowserEnabled()).toBe(true);
  });

  it("配了持久 Chrome cdpUrl → 启用", () => {
    process.env.QINGAGENT_BROWSER_CDP_URL = "ws://127.0.0.1:9222/devtools/browser/abc";
    expect(isAgentBrowserEnabled()).toBe(true);
  });

  it("显式 CDP 标记为外部浏览器并打印 ACL 不可验证审计告警", () => {
    process.env.QINGAGENT_BROWSER_CDP_URL = "ws://127.0.0.1:9222/devtools/browser/abc";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      getAgentBrowser();
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/外部浏览器.*ACL 不可验证/));
    } finally {
      warn.mockRestore();
    }
  });

  it("代理安全模式拒绝显式外部 CDP，避免绕过受控 --proxy-server", () => {
    process.env.QINGAGENT_BROWSER_CDP_URL = "ws://127.0.0.1:9222/devtools/browser/abc";
    process.env.HTTPS_PROXY = "http://127.0.0.1:8080";
    process.env.QINGAGENT_BROWSER_PROXY_ACL = "deny-private";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      expect(() => getAgentBrowser()).toThrow(/代理安全模式拒绝.*外部浏览器/);
    } finally {
      warn.mockRestore();
    }
  });

  it("启用后注入 browser_* 工具:含核心读取/登录工具,排除高风险/无用工具", () => {
    process.env.QINGAGENT_AGENT_BROWSER = "1";
    const tools = getAgentBrowserTools();
    const names = Object.keys(tools);
    expect(names.length).toBeGreaterThan(0);
    // 三级抓取末级需要的核心工具齐全
    for (const need of [
      "browser_goto",
      "browser_snapshot",
      "browser_click",
      "browser_type",
      "browser_press",
      "browser_wait",
    ]) {
      expect(names).toContain(need);
    }
    // 高风险/无用工具被排除
    for (const ex of ["browser_screenshot", "browser_evaluate", "browser_drag", "browser_tabs"]) {
      expect(names).not.toContain(ex);
    }
  });

  describe("browser_goto SSRF 守卫(校验在真正导航前抛出,不会启动浏览器)", () => {
    function gotoExec() {
      process.env.QINGAGENT_AGENT_BROWSER = "1";
      const tools = getAgentBrowserTools() as Record<string, { execute: (...a: unknown[]) => unknown }>;
      const goto = tools.browser_goto;
      if (!goto) throw new Error("browser_goto 未注入");
      return goto.execute;
    }

    it("拒绝私网/本机/元数据/非 http(s) 地址", async () => {
      const exec = gotoExec();
      for (const url of [
        "http://127.0.0.1:8080/",
        "http://localhost:9222/",
        "http://169.254.169.254/latest/meta-data/",
        "http://10.0.0.5/",
        "file:///etc/passwd",
      ]) {
        await expect(Promise.resolve(exec({ url }, {}))).rejects.toThrow();
      }
    });

    it("配了白名单后,公网地址但不在白名单 → 拒绝", async () => {
      process.env.QINGAGENT_BROWSER_ALLOW_DOMAINS = "example.com,medium.com";
      const exec = gotoExec();
      // 1.1.1.1 是公网字面 IP(通过私网校验),但不在白名单 → 应被拒
      await expect(Promise.resolve(exec({ url: "http://1.1.1.1/" }, {}))).rejects.toThrow(/白名单/);
    });
  });

  describe("Playwright context 逐请求守卫", () => {
    function mockContext() {
      const route = vi.fn<
        (url: string, handler: (route: unknown) => Promise<void>) => Promise<void>
      >(async () => undefined);
      const routeWebSocket = vi.fn<
        (url: string, handler: (route: unknown) => Promise<void>) => Promise<void>
      >(async () => undefined);
      return {
        context: { route, routeWebSocket } as unknown as BrowserContext,
        route,
        routeWebSocket,
      };
    }

    it("同一 context 只安装一次 HTTP 与 WebSocket 路由", async () => {
      const mocked = mockContext();
      await Promise.all([
        installAgentBrowserRequestPolicy(mocked.context),
        installAgentBrowserRequestPolicy(mocked.context),
      ]);

      expect(mocked.route).toHaveBeenCalledTimes(1);
      expect(mocked.route).toHaveBeenCalledWith("**/*", expect.any(Function));
      expect(mocked.routeWebSocket).toHaveBeenCalledTimes(1);
      expect(mocked.routeWebSocket).toHaveBeenCalledWith("**/*", expect.any(Function));
    });

    it("HTTP(S) 每次请求都校验地址与 scheme，私网/file 中止，公网与本地无网络 scheme 放行", async () => {
      const mocked = mockContext();
      await installAgentBrowserRequestPolicy(mocked.context);
      const handler = mocked.route.mock.calls[0]?.[1] as (route: unknown) => Promise<void>;

      const execute = async (url: string) => {
        const continueRequest = vi.fn(async () => undefined);
        const abort = vi.fn(async () => undefined);
        await handler({
          request: () => ({ url: () => url }),
          continue: continueRequest,
          abort,
        });
        return { continueRequest, abort };
      };

      expect((await execute("https://1.1.1.1/app.js")).continueRequest).toHaveBeenCalledOnce();
      expect((await execute("data:text/plain,ok")).continueRequest).toHaveBeenCalledOnce();
      expect((await execute("http://127.0.0.1/admin")).abort).toHaveBeenCalledWith(
        "blockedbyclient",
      );
      expect((await execute("file:///etc/passwd")).abort).toHaveBeenCalledWith("blockedbyclient");
    });

    it("WebSocket 独立校验：公网连接，私网以 policy violation 关闭", async () => {
      const mocked = mockContext();
      await installAgentBrowserRequestPolicy(mocked.context);
      const handler = mocked.routeWebSocket.mock.calls[0]?.[1] as (
        route: unknown,
      ) => Promise<void>;

      const publicRoute = {
        url: () => "wss://1.1.1.1/socket",
        connectToServer: vi.fn(),
        close: vi.fn(async () => undefined),
      };
      await handler(publicRoute);
      expect(publicRoute.connectToServer).toHaveBeenCalledOnce();
      expect(publicRoute.close).not.toHaveBeenCalled();

      const privateRoute = {
        url: () => "ws://169.254.169.254/latest/meta-data",
        connectToServer: vi.fn(),
        close: vi.fn(async () => undefined),
      };
      await handler(privateRoute);
      expect(privateRoute.connectToServer).not.toHaveBeenCalled();
      expect(privateRoute.close).toHaveBeenCalledWith(
        expect.objectContaining({ code: 1008 }),
      );
    });

    it("代理模式要求 deny-private ACL，且 WebSocket 继续复用同一网络边界", async () => {
      process.env.HTTPS_PROXY = "http://127.0.0.1:8080";
      const rejected = mockContext();
      await expect(installAgentBrowserRequestPolicy(rejected.context)).rejects.toThrow(
        /QINGAGENT_BROWSER_PROXY_ACL=deny-private/,
      );

      process.env.QINGAGENT_BROWSER_PROXY_ACL = "deny-private";
      const allowed = mockContext();
      await installAgentBrowserRequestPolicy(allowed.context);
      const handler = allowed.routeWebSocket.mock.calls[0]?.[1] as (
        route: unknown,
      ) => Promise<void>;
      const websocketRoute = {
        url: () => "wss://1.1.1.1/socket",
        connectToServer: vi.fn(),
        close: vi.fn(async () => undefined),
      };
      await handler(websocketRoute);
      expect(websocketRoute.connectToServer).toHaveBeenCalledOnce();
      expect(websocketRoute.close).not.toHaveBeenCalled();
    });
  });
});
