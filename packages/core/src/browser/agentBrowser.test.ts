import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  getAgentBrowserTools,
  isAgentBrowserEnabled,
  resetAgentBrowserForTest,
} from "./agentBrowser.js";

const ENV_KEYS = [
  "QINGAGENT_AGENT_BROWSER",
  "QINGAGENT_BROWSER_CDP_URL",
  "QINGAGENT_BROWSER_STORAGE_STATE",
  "QINGAGENT_BROWSER_HEADFUL",
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
});
