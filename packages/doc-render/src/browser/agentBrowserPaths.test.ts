import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  resolveAgentBrowserProfileDir,
  resolveAgentBrowserStorageStatePath,
} from "./agentBrowserPaths.js";

describe("agent browser 敏感数据路径", () => {
  it("server/CLI 默认把登录态与 profile 放到用户目录，不依赖 cwd", () => {
    const env = {};

    expect(
      resolveAgentBrowserStorageStatePath({ env, enabled: true }),
    ).toBe(join(homedir(), ".qingagent", ".qingagent-browser-state.json"));
    expect(resolveAgentBrowserProfileDir({ env })).toBe(
      join(homedir(), ".qingagent", ".qingagent-browser-profile"),
    );
  });

  it("显式 storage state 与 profile 覆盖保持最高优先级", () => {
    const env = {
      QINGAGENT_BROWSER_STORAGE_STATE: "  /custom/auth-state.json  ",
      QINGAGENT_BROWSER_PROFILE_DIR: "  /custom/browser-profile  ",
    };

    expect(
      resolveAgentBrowserStorageStatePath({ env, enabled: true }),
    ).toBe("/custom/auth-state.json");
    expect(resolveAgentBrowserProfileDir({ env })).toBe(
      "/custom/browser-profile",
    );
  });

  it("浏览器关闭且没有显式覆盖时不创建默认登录态路径", () => {
    expect(
      resolveAgentBrowserStorageStatePath({ env: {}, enabled: false }),
    ).toBeUndefined();
  });
});
