import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const launch = vi.hoisted(() => vi.fn());

vi.mock("playwright", () => ({
  chromium: { launch },
}));
vi.mock("./systemBrowser.js", () => ({
  systemBrowserExecutablePath: () => null,
}));

const savedNoSandbox = process.env.QINGAGENT_ALLOW_NO_SANDBOX;
const proxyEnvKeys = [
  "HTTPS_PROXY",
  "https_proxy",
  "HTTP_PROXY",
  "http_proxy",
  "QINGAGENT_BROWSER_PROXY_ACL",
] as const;
const savedProxyEnv = Object.fromEntries(
  proxyEnvKeys.map((key) => [key, process.env[key]]),
);

describe("浏览器启动能力探测", () => {
  beforeEach(async () => {
    delete process.env.QINGAGENT_ALLOW_NO_SANDBOX;
    for (const key of proxyEnvKeys) delete process.env[key];
    launch.mockReset();
    const mod = await import("./pool.js");
    await mod.resetBrowserCapabilityForTest();
  });

  afterEach(async () => {
    const mod = await import("./pool.js");
    await mod.resetBrowserCapabilityForTest();
    if (savedNoSandbox === undefined) delete process.env.QINGAGENT_ALLOW_NO_SANDBOX;
    else process.env.QINGAGENT_ALLOW_NO_SANDBOX = savedNoSandbox;
    for (const key of proxyEnvKeys) {
      const value = savedProxyEnv[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    vi.restoreAllMocks();
  });

  it("sandbox 启动失败时把浏览器能力标为 unavailable，服务可据此禁用 PDF", async () => {
    launch.mockRejectedValue(new Error("No usable sandbox"));
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const mod = await import("./pool.js");

    const state = await mod.probeBrowserCapability();

    expect(state).toEqual({
      status: "unavailable",
      sandbox: "required",
      reason: "浏览器无法在当前环境启动；PDF 导出等浏览器能力已禁用",
    });
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining("PDF 导出等浏览器能力已禁用"),
      "No usable sandbox",
    );
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining("sandbox 已被显式关闭"));
  });

  it("已可用浏览器断连后的瞬时启动失败不会永久禁用后续重试", async () => {
    let connected = true;
    let disconnect: (() => void) | undefined;
    const firstBrowser = {
      isConnected: vi.fn(() => connected),
      on: vi.fn((event: string, listener: () => void) => {
        if (event === "disconnected") disconnect = listener;
      }),
      close: vi.fn(async () => undefined),
    };
    const recoveredBrowser = {
      isConnected: vi.fn(() => true),
      on: vi.fn(),
      close: vi.fn(async () => undefined),
    };
    launch
      .mockResolvedValueOnce(firstBrowser)
      .mockRejectedValueOnce(new Error("browser process temporarily unavailable"))
      .mockResolvedValueOnce(recoveredBrowser);
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const mod = await import("./pool.js");

    await expect(mod.probeBrowserCapability()).resolves.toMatchObject({
      status: "available",
    });
    connected = false;
    disconnect?.();

    await expect(mod.getBrowser()).rejects.toBeInstanceOf(
      mod.BrowserCapabilityUnavailableError,
    );
    expect(mod.getBrowserCapabilityState()).toMatchObject({
      status: "available",
      reason: null,
    });
    await expect(mod.getBrowser()).resolves.toBe(recoveredBrowser);
    expect(launch).toHaveBeenCalledTimes(3);
  });
});
