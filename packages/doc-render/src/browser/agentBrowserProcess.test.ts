import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  spawn: vi.fn(),
  browserConfigs: [] as Array<Record<string, unknown>>,
  readFile: vi.fn(),
  mkdirSync: vi.fn(),
}));

vi.mock("node:child_process", () => ({ spawn: mocks.spawn }));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    mkdirSync: (...args: Parameters<typeof actual.mkdirSync>) => {
      mocks.mkdirSync(...args);
      return actual.mkdirSync(...args);
    },
  };
});
vi.mock("node:fs/promises", () => ({
  readFile: mocks.readFile,
}));
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
const savedProfileDir = process.env.QINGAGENT_BROWSER_PROFILE_DIR;
const savedNoSandbox = process.env.QINGAGENT_ALLOW_NO_SANDBOX;

describe("代理 Chromium 进程所有权", () => {
  let testRoot: string;
  let profileDir: string;

  beforeEach(() => {
    mocks.spawn.mockReset();
    mocks.browserConfigs.length = 0;
    mocks.readFile.mockReset();
    mocks.mkdirSync.mockClear();
    testRoot = mkdtempSync(join(tmpdir(), "agent-browser-process-"));
    profileDir = join(testRoot, "profile");
    process.env.HTTPS_PROXY = "http://127.0.0.1:8080";
    process.env.QINGAGENT_BROWSER_PROXY_ACL = "deny-private";
    delete process.env.QINGAGENT_ALLOW_NO_SANDBOX;
    delete process.env.QINGAGENT_BROWSER_CDP_URL;
    process.env.QINGAGENT_BROWSER_PROFILE_DIR = profileDir;
    process.env.QINGAGENT_AGENT_BROWSER = "1";
  });

  afterEach(async () => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    const mod = await import("./agentBrowser.js");
    mod.resetAgentBrowserForTest();
    if (savedProxy === undefined) delete process.env.HTTPS_PROXY;
    else process.env.HTTPS_PROXY = savedProxy;
    if (savedProxyAcl === undefined) delete process.env.QINGAGENT_BROWSER_PROXY_ACL;
    else process.env.QINGAGENT_BROWSER_PROXY_ACL = savedProxyAcl;
    if (savedProfileDir === undefined) delete process.env.QINGAGENT_BROWSER_PROFILE_DIR;
    else process.env.QINGAGENT_BROWSER_PROFILE_DIR = savedProfileDir;
    if (savedNoSandbox === undefined) delete process.env.QINGAGENT_ALLOW_NO_SANDBOX;
    else process.env.QINGAGENT_ALLOW_NO_SANDBOX = savedNoSandbox;
    delete process.env.QINGAGENT_AGENT_BROWSER;
    rmSync(testRoot, { recursive: true, force: true });
  });

  it("停止函数只终止本模块实际 spawn 的进程", async () => {
    const child = fakeChild();
    mocks.spawn.mockReturnValue(child);
    mocks.readFile
      .mockRejectedValueOnce(new Error("no stale marker"))
      .mockResolvedValue("42123\n/devtools/browser/owned\n");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ webSocketDebuggerUrl: "ws://127.0.0.1:42123/devtools/browser/owned" }), {
          status: 200,
        }),
      ),
    );

    const mod = await import("./agentBrowser.js");
    mod.getAgentBrowser();
    const cdpUrl = mocks.browserConfigs.at(-1)?.cdpUrl as () => Promise<string>;
    await expect(cdpUrl()).resolves.toContain("/owned");

    expect(mocks.mkdirSync).toHaveBeenCalledWith(profileDir, {
      recursive: true,
      mode: 0o700,
    });
    expect(mocks.spawn).toHaveBeenCalledTimes(1);
    const launchArgs = mocks.spawn.mock.calls[0]?.[1] as string[];
    expect(launchArgs).toContain("--disable-dev-shm-usage");
    expect(launchArgs).toContain("--remote-debugging-port=0");
    expect(launchArgs).toContain("--proxy-bypass-list=<-loopback>");
    expect(launchArgs).not.toContain("--no-sandbox");
    expect(launchArgs).not.toContain("--disable-features=IsolateOrigins,site-per-process");
    expect(child.unref).toHaveBeenCalledOnce();
    expect(mod.stopProxiedChromium()).toBe(true);
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("不探测或复用外部 9333，只连接本进程随机端口端点", async () => {
    process.env.QINGAGENT_ALLOW_NO_SANDBOX = "1";
    const child = fakeChild();
    mocks.spawn.mockReturnValue(child);
    mocks.readFile
      .mockRejectedValueOnce(new Error("no stale marker"))
      .mockResolvedValue("42124\n/devtools/browser/owned-random\n");
    const fetchMock = vi.fn(async (url: string) => {
      expect(url).toBe("http://127.0.0.1:42124/json/version");
      return new Response(
        JSON.stringify({
          webSocketDebuggerUrl: "ws://127.0.0.1:42124/devtools/browser/owned-random",
        }),
        { status: 200 },
      );
    });
    vi.stubGlobal(
      "fetch",
      fetchMock,
    );

    const mod = await import("./agentBrowser.js");
    mod.getAgentBrowser();
    const cdpUrl = mocks.browserConfigs.at(-1)?.cdpUrl as () => Promise<string>;
    await expect(cdpUrl()).resolves.toContain("/owned-random");

    expect(mocks.spawn).toHaveBeenCalledOnce();
    expect(mocks.spawn.mock.calls[0]?.[1]).toContain("--no-sandbox");
    expect(fetchMock).not.toHaveBeenCalledWith(
      "http://127.0.0.1:9333/json/version",
    );
    expect(mod.stopProxiedChromium()).toBe(true);
  });

  it("没有本进程生成的 DevToolsActivePort 时 fail-closed", async () => {
    vi.useFakeTimers();
    const child = fakeChild();
    mocks.spawn.mockReturnValue(child);
    mocks.readFile.mockRejectedValue(new Error("not ready"));
    vi.stubGlobal("fetch", vi.fn());

    const mod = await import("./agentBrowser.js");
    mod.getAgentBrowser();
    const cdpUrl = mocks.browserConfigs.at(-1)?.cdpUrl as () => Promise<string>;
    const pending = cdpUrl();
    const rejected = expect(pending).rejects.toThrow(/CDP 端点未就绪/);
    await vi.advanceTimersByTimeAsync(15_000);

    await rejected;
    expect(fetch).not.toHaveBeenCalled();
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  });
});
