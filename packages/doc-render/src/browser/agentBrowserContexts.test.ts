import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BrowserContext, Page } from "playwright";

const mocks = vi.hoisted(() => ({
  installPolicy: vi.fn(async () => undefined),
  manager: undefined as unknown,
  superEnsureReady: vi.fn(async () => undefined),
}));

vi.mock("./browserSecurity.js", () => ({
  installBrowserRequestPolicy: mocks.installPolicy,
}));

vi.mock("@mastra/agent-browser", () => ({
  AgentBrowser: class {
    async ensureReady() {
      await mocks.superEnsureReady();
    }

    async getManagerForThread() {
      return mocks.manager;
    }

    getTools() {
      return {};
    }

    async exportStorageState() {}
  },
}));

import { getAgentBrowser, resetAgentBrowserForTest } from "./agentBrowser.js";

const savedCdpUrl = process.env.QINGAGENT_BROWSER_CDP_URL;
const savedProxyAcl = process.env.QINGAGENT_BROWSER_PROXY_ACL;

describe("AgentBrowser 多 context 请求策略", () => {
  beforeEach(() => {
    mocks.installPolicy.mockClear();
    mocks.superEnsureReady.mockClear();
    process.env.QINGAGENT_BROWSER_CDP_URL = "ws://127.0.0.1:9222/devtools/browser/test";
    process.env.QINGAGENT_BROWSER_PROXY_ACL = "deny-private";
    resetAgentBrowserForTest();
  });

  afterEach(() => {
    resetAgentBrowserForTest();
    if (savedCdpUrl === undefined) delete process.env.QINGAGENT_BROWSER_CDP_URL;
    else process.env.QINGAGENT_BROWSER_CDP_URL = savedCdpUrl;
    if (savedProxyAcl === undefined) delete process.env.QINGAGENT_BROWSER_PROXY_ACL;
    else process.env.QINGAGENT_BROWSER_PROXY_ACL = savedProxyAcl;
  });

  it("从全部页面反查唯一 context，并为新页面所属的第二个 context 安装策略", async () => {
    const firstContext = {} as BrowserContext;
    const secondContext = {} as BrowserContext;
    const firstPage = { context: () => firstContext } as unknown as Page;
    const secondPage = { context: () => secondContext } as unknown as Page;
    const anotherSecondPage = { context: () => secondContext } as unknown as Page;
    mocks.manager = {
      getContext: () => firstContext,
      getPages: () => [firstPage, secondPage, anotherSecondPage],
    };

    await getAgentBrowser().ensureReady();

    expect(mocks.superEnsureReady).toHaveBeenCalledOnce();
    expect(mocks.installPolicy).toHaveBeenCalledTimes(2);
    expect(mocks.installPolicy).toHaveBeenCalledWith(firstContext, {
      outboundProxyAcl: false,
    });
    expect(mocks.installPolicy).toHaveBeenCalledWith(secondContext, {
      outboundProxyAcl: false,
    });
  });

  it("manager 与页面都没有可用 context 时保持抛错", async () => {
    mocks.manager = {
      getContext: () => null,
      getPages: () => [],
    };

    await expect(getAgentBrowser().ensureReady()).rejects.toThrow(/context 未就绪/);
    expect(mocks.installPolicy).not.toHaveBeenCalled();
  });
});
