import { afterEach, describe, expect, it, vi } from "vitest";

const ENV_KEYS = [
  "QINGAGENT_AGENT_BROWSER",
  "QINGAGENT_BROWSER_CDP_URL",
  "QINGAGENT_BROWSER_STORAGE_STATE",
  "QINGAGENT_BROWSER_PROFILE_DIR",
  "QINGAGENT_BROWSER_HEADFUL",
  "QINGAGENT_BROWSER_ALLOW_DOMAINS",
  "QINGAGENT_BROWSER_PROXY_ACL",
  "HTTPS_PROXY",
  "https_proxy",
  "HTTP_PROXY",
  "http_proxy",
  "QINGAGENT_BROWSER_EXECUTABLE_PATH",
];

const savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

async function loadGotoToolWithFailure(error: unknown) {
  vi.resetModules();
  vi.doMock("@mastra/agent-browser", () => ({
    AgentBrowser: class {
      getTools() {
        return {
          browser_goto: {
            id: "browser_goto",
            execute: vi.fn(async () => {
              throw error;
            }),
          },
        };
      }

      async exportStorageState() {}
    },
  }));

  process.env.QINGAGENT_AGENT_BROWSER = "1";
  delete process.env.QINGAGENT_BROWSER_CDP_URL;
  delete process.env.QINGAGENT_BROWSER_STORAGE_STATE;
  delete process.env.QINGAGENT_BROWSER_ALLOW_DOMAINS;
  delete process.env.QINGAGENT_BROWSER_PROXY_ACL;
  delete process.env.HTTPS_PROXY;
  delete process.env.https_proxy;
  delete process.env.HTTP_PROXY;
  delete process.env.http_proxy;
  const mod = await import("./agentBrowser.js");
  const tools = mod.getAgentBrowserTools() as Record<string, { execute: (...args: unknown[]) => unknown }>;
  const goto = tools.browser_goto;
  if (!goto) throw new Error("browser_goto 未注入");
  return goto;
}

describe("agentBrowser 浏览器启动失败降级", () => {
  afterEach(() => {
    vi.doUnmock("@mastra/agent-browser");
    vi.resetModules();
    for (const key of ENV_KEYS) {
      const value = savedEnv[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it("browser_goto 遇到 spawn ENOENT 时返回结构化错误,不向外抛", async () => {
    const error = Object.assign(new Error("spawn /missing/chromium ENOENT"), {
      code: "ENOENT",
      syscall: "spawn /missing/chromium",
    });
    const goto = await loadGotoToolWithFailure(error);

    const result = await Promise.resolve(goto.execute({ url: "http://1.1.1.1/" }, {})) as {
      success?: boolean;
      code?: string;
      canRetry?: boolean;
      message?: string;
      recoveryHint?: string;
    };
    expect(result).toMatchObject({
      success: false,
      code: "browser_error",
      canRetry: false,
    });
    expect(result.message).toContain("未安装 Playwright 浏览器");
    expect(result.recoveryHint).toContain("npx playwright install chromium");
  });

  it("browser_goto 遇到 Playwright Executable doesn't exist 时返回安装指引", async () => {
    const error = new Error(
      "browserType.launch: Executable doesn't exist at /home/user/.cache/ms-playwright/chromium-1223/chrome-linux/chrome",
    );
    const goto = await loadGotoToolWithFailure(error);

    const result = await Promise.resolve(goto.execute({ url: "http://1.1.1.1/" }, {})) as {
      success?: boolean;
      message?: string;
      recoveryHint?: string;
    };

    expect(result.success).toBe(false);
    expect(result.message).toContain("未安装 Playwright 浏览器");
    expect(result.message).toContain("npx playwright install chromium");
    expect(result.recoveryHint).toContain("pnpm exec playwright install chromium");
  });

  it("代理 CDP 自启遇到真实 spawn ENOENT 时不触发进程崩溃", async () => {
    vi.doUnmock("@mastra/agent-browser");
    vi.resetModules();
    process.env.QINGAGENT_AGENT_BROWSER = "1";
    process.env.HTTPS_PROXY = "http://127.0.0.1:9";
    process.env.QINGAGENT_BROWSER_PROXY_ACL = "deny-private";
    delete process.env.https_proxy;
    delete process.env.HTTP_PROXY;
    delete process.env.http_proxy;
    process.env.QINGAGENT_BROWSER_EXECUTABLE_PATH = "/tmp/qingagent-missing-chromium-for-test";

    const mod = await import("./agentBrowser.js");
    const tools = mod.getAgentBrowserTools() as Record<string, { execute: (...args: unknown[]) => unknown }>;
    const goto = tools.browser_goto;
    if (!goto) throw new Error("browser_goto 未注入");

    const result = await Promise.resolve(goto.execute({ url: "http://1.1.1.1/" }, {})) as {
      success?: boolean;
      message?: string;
      recoveryHint?: string;
    };

    expect(result.success).toBe(false);
    expect(result.message).toContain("未安装 Playwright 浏览器");
    expect(result.recoveryHint).toContain("npx playwright install chromium");
    mod.resetAgentBrowserForTest();
  });
});
