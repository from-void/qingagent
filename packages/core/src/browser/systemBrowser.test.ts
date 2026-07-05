import { afterEach, describe, expect, it } from "vitest";
import {
  __resetSystemBrowserMemoForTest,
  systemBrowserCandidates,
  systemBrowserExecutablePath,
} from "./systemBrowser.js";

// 系统浏览器探测:各平台候选路径(Edge 优先)+ env 覆盖优先 + 探测缓存。
describe("systemBrowserCandidates", () => {
  it("Windows:Edge 路径排在 Chrome 之前", () => {
    const list = systemBrowserCandidates("win32");
    expect(list.some((p) => p.toLowerCase().includes("msedge.exe"))).toBe(true);
    expect(list.some((p) => p.toLowerCase().includes("chrome.exe"))).toBe(true);
    const firstEdge = list.findIndex((p) => p.toLowerCase().includes("edge"));
    const firstChrome = list.findIndex((p) => p.toLowerCase().includes("chrome"));
    expect(firstEdge).toBeLessThan(firstChrome);
  });

  it("macOS:.app 包内可执行路径", () => {
    const list = systemBrowserCandidates("darwin");
    expect(list).toContain("/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge");
    expect(list).toContain("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome");
  });

  it("Linux:/usr/bin 下的 edge/chrome", () => {
    const list = systemBrowserCandidates("linux");
    expect(list.every((p) => p.startsWith("/"))).toBe(true);
    expect(list.some((p) => p.includes("microsoft-edge"))).toBe(true);
    expect(list.some((p) => p.includes("google-chrome"))).toBe(true);
  });
});

describe("systemBrowserExecutablePath", () => {
  const orig = process.env.QINGAGENT_BROWSER_EXECUTABLE_PATH;
  afterEach(() => {
    if (orig === undefined) delete process.env.QINGAGENT_BROWSER_EXECUTABLE_PATH;
    else process.env.QINGAGENT_BROWSER_EXECUTABLE_PATH = orig;
    __resetSystemBrowserMemoForTest();
  });

  it("env 覆盖优先,原样返回(信任用户路径,不做存在性探测)", () => {
    process.env.QINGAGENT_BROWSER_EXECUTABLE_PATH = "/custom/edge";
    expect(systemBrowserExecutablePath()).toBe("/custom/edge");
  });

  it("env 两侧空白被 trim;纯空白视为未设置", () => {
    process.env.QINGAGENT_BROWSER_EXECUTABLE_PATH = "  /custom/chrome  ";
    expect(systemBrowserExecutablePath()).toBe("/custom/chrome");
  });
});
