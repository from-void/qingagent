import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const launch = vi.hoisted(() => vi.fn());

vi.mock("playwright", () => ({
  chromium: { launch },
}));
vi.mock("./systemBrowser.js", () => ({
  systemBrowserExecutablePath: () => null,
}));

const hookEvents = ["exit", "SIGINT", "SIGTERM"] as const;
const proxyEnvKeys = ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"] as const;
const savedProxyEnv = Object.fromEntries(
  proxyEnvKeys.map((key) => [key, process.env[key]]),
);

function hookCounts(): Record<(typeof hookEvents)[number], number> {
  return Object.fromEntries(
    hookEvents.map((event) => [event, process.listenerCount(event)]),
  ) as Record<(typeof hookEvents)[number], number>;
}

beforeEach(() => {
  for (const key of proxyEnvKeys) delete process.env[key];
  launch.mockReset();
});

afterEach(async () => {
  const mod = await import("./pool.js");
  await mod.resetBrowserCapabilityForTest();
  for (const key of proxyEnvKeys) {
    const value = savedProxyEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  vi.restoreAllMocks();
});

describe("browser pool 进程钩子", () => {
  it("只 import 模块时不注册宿主进程钩子", async () => {
    vi.resetModules();
    const before = hookCounts();

    await import("./pool.js");

    expect(hookCounts()).toEqual(before);
  });

  it("首次创建浏览器池时幂等注册钩子", async () => {
    vi.resetModules();
    const browser = {
      isConnected: vi.fn(() => true),
      on: vi.fn(),
      close: vi.fn(async () => undefined),
    };
    launch.mockResolvedValue(browser);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const before = hookCounts();
    const mod = await import("./pool.js");

    await mod.getBrowser();
    await mod.getBrowser();

    expect(hookCounts()).toEqual({
      exit: before.exit + 1,
      SIGINT: before.SIGINT + 1,
      SIGTERM: before.SIGTERM + 1,
    });
  });
});
