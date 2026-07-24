import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  spawn: vi.fn(),
  browserConfigs: [] as Array<Record<string, unknown>>,
}));

vi.mock("node:child_process", () => ({ spawn: mocks.spawn }));
vi.mock("playwright", () => ({
  chromium: { executablePath: () => "/test/chromium" },
}));
vi.mock("@mastra/agent-browser", () => ({
  AgentBrowser: class {
    constructor(config: Record<string, unknown>) {
      mocks.browserConfigs.push(config);
    }

    getTools() {
      return {};
    }

    async exportStorageState() {}
  },
}));

type FakeChild = EventEmitter & {
  exitCode: number | null;
  killed: boolean;
  kill: ReturnType<typeof vi.fn>;
  unref: ReturnType<typeof vi.fn>;
};

function fakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.exitCode = null;
  child.killed = false;
  child.kill = vi.fn(() => {
    child.killed = true;
    return true;
  });
  child.unref = vi.fn();
  return child;
}

const savedProxy = process.env.HTTPS_PROXY;
const savedProxyAcl = process.env.QINGAGENT_BROWSER_PROXY_ACL;

describe("代理 Chromium 进程所有权", () => {
  beforeEach(() => {
    mocks.spawn.mockReset();
    mocks.browserConfigs.length = 0;
    process.env.HTTPS_PROXY = "http://127.0.0.1:8080";
    process.env.QINGAGENT_BROWSER_PROXY_ACL = "deny-private";
    delete process.env.QINGAGENT_BROWSER_CDP_URL;
    process.env.QINGAGENT_AGENT_BROWSER = "1";
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    const mod = await import("./agentBrowser.js");
    mod.resetAgentBrowserForTest();
    if (savedProxy === undefined) delete process.env.HTTPS_PROXY;
    else process.env.HTTPS_PROXY = savedProxy;
    if (savedProxyAcl === undefined) delete process.env.QINGAGENT_BROWSER_PROXY_ACL;
    else process.env.QINGAGENT_BROWSER_PROXY_ACL = savedProxyAcl;
    delete process.env.QINGAGENT_AGENT_BROWSER;
  });

  it("停止函数只终止本模块实际 spawn 的进程", async () => {
    const child = fakeChild();
    mocks.spawn.mockReturnValue(child);
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockRejectedValueOnce(new Error("端口尚未监听"))
        .mockResolvedValue(
          new Response(JSON.stringify({ webSocketDebuggerUrl: "ws://127.0.0.1:9333/devtools/browser/owned" }), {
            status: 200,
          }),
        ),
    );

    const mod = await import("./agentBrowser.js");
    mod.getAgentBrowser();
    const cdpUrl = mocks.browserConfigs.at(-1)?.cdpUrl as () => Promise<string>;
    await expect(cdpUrl()).resolves.toContain("/owned");

    expect(mocks.spawn).toHaveBeenCalledTimes(1);
    const launchArgs = mocks.spawn.mock.calls[0]?.[1] as string[];
    expect(launchArgs).toContain("--disable-dev-shm-usage");
    expect(launchArgs).toContain("--proxy-bypass-list=<-loopback>");
    expect(launchArgs).not.toContain("--no-sandbox");
    expect(launchArgs).not.toContain("--disable-features=IsolateOrigins,site-per-process");
    expect(child.unref).toHaveBeenCalledOnce();
    expect(mod.stopProxiedChromium()).toBe(true);
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("9333 已有实例时只复用，停止函数不会关闭外部进程", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ webSocketDebuggerUrl: "ws://127.0.0.1:9333/devtools/browser/reused" }), {
          status: 200,
        }),
      ),
    );

    const mod = await import("./agentBrowser.js");
    mod.getAgentBrowser();
    const cdpUrl = mocks.browserConfigs.at(-1)?.cdpUrl as () => Promise<string>;
    await expect(cdpUrl()).resolves.toContain("/reused");

    expect(mocks.spawn).not.toHaveBeenCalled();
    expect(mod.stopProxiedChromium()).toBe(false);
  });
});
