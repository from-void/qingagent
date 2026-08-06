import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  chmodSync: vi.fn(),
  mkdirSync: vi.fn(),
  execute: vi.fn(),
  exportStorageState: vi.fn(),
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    chmodSync: (...args: Parameters<typeof actual.chmodSync>) => {
      mocks.chmodSync(...args);
      return actual.chmodSync(...args);
    },
    mkdirSync: (...args: Parameters<typeof actual.mkdirSync>) => {
      mocks.mkdirSync(...args);
      return actual.mkdirSync(...args);
    },
  };
});

vi.mock("@mastra/agent-browser", () => ({
  AgentBrowser: class {
    getTools() {
      return {
        browser_click: {
          id: "browser_click",
          execute: mocks.execute,
        },
      };
    }

    async exportStorageState(savePath: string) {
      return mocks.exportStorageState(savePath);
    }
  },
}));

import {
  getAgentBrowserTools,
  resetAgentBrowserForTest,
} from "./agentBrowser.js";

const ENV_KEYS = [
  "QINGAGENT_AGENT_BROWSER",
  "QINGAGENT_BROWSER_CDP_URL",
  "QINGAGENT_BROWSER_STORAGE_STATE",
  "QINGAGENT_BROWSER_PROFILE_DIR",
  "HTTPS_PROXY",
  "https_proxy",
  "HTTP_PROXY",
  "http_proxy",
];
const savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

describe("agent browser 凭据权限", () => {
  let testRoot: string;
  let savePath: string;

  beforeEach(() => {
    vi.useFakeTimers();
    resetAgentBrowserForTest();
    mocks.chmodSync.mockClear();
    mocks.mkdirSync.mockClear();
    mocks.execute.mockReset().mockResolvedValue({ success: true });
    mocks.exportStorageState.mockReset().mockImplementation((target: string) => {
      writeFileSync(target, "{}", { mode: 0o666 });
    });
    testRoot = mkdtempSync(join(tmpdir(), "agent-browser-permissions-"));
    savePath = join(testRoot, "private", "storage-state.json");
    for (const key of ENV_KEYS) delete process.env[key];
    process.env.QINGAGENT_AGENT_BROWSER = "1";
    process.env.QINGAGENT_BROWSER_STORAGE_STATE = savePath;
  });

  afterEach(() => {
    resetAgentBrowserForTest();
    vi.useRealTimers();
    for (const key of ENV_KEYS) {
      const value = savedEnv[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(testRoot, { recursive: true, force: true });
  });

  it("成功操作后以 0700 创建登录态目录并把文件收紧为 0600", async () => {
    const tools = getAgentBrowserTools() as Record<
      string,
      { execute: (...args: unknown[]) => unknown }
    >;
    const click = tools.browser_click;
    if (!click) throw new Error("browser_click 未注入");

    await click.execute({}, {});
    await vi.advanceTimersByTimeAsync(1_500);

    expect(mocks.exportStorageState).toHaveBeenCalledWith(savePath);
    expect(mocks.mkdirSync).toHaveBeenCalledWith(dirname(savePath), {
      recursive: true,
      mode: 0o700,
    });
    expect(mocks.chmodSync).toHaveBeenCalledWith(savePath, 0o600);
  });
});
