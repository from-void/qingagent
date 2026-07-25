// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { awaitPendingStylesheets } from "./awaitStyles";

function addStylesheet(href: string, loaded: boolean): HTMLLinkElement {
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = href;
  // jsdom 不真的去取样式表,sheet 恒为 null;用 defineProperty 模拟「已落地/仍在下载」。
  Object.defineProperty(link, "sheet", {
    configurable: true,
    get: () => (loaded ? ({} as CSSStyleSheet) : null),
  });
  document.head.appendChild(link);
  return link;
}

describe("awaitPendingStylesheets", () => {
  afterEach(() => {
    document.head.innerHTML = "";
    vi.restoreAllMocks();
  });

  it("没有 pending 样式表时立即 resolve", async () => {
    addStylesheet("/assets/WorkspacePage.css", true);
    await expect(awaitPendingStylesheets(50)).resolves.toBeUndefined();
  });

  it("等 pending 样式表 load —— 这是修「编辑页先挂载、皮肤 CSS 后到」的关键", async () => {
    const link = addStylesheet("/assets/WorkspacePage.css", false);
    let settled = false;
    const promise = awaitPendingStylesheets(5000).then(() => {
      settled = true;
    });

    await Promise.resolve();
    expect(settled).toBe(false); // 还在等,不该提前放行去切页

    link.dispatchEvent(new Event("load"));
    await promise;
    expect(settled).toBe(true);
  });

  it("样式表加载失败也放行(切页优先于皮肤)", async () => {
    const link = addStylesheet("/assets/WorkspacePage.css", false);
    const promise = awaitPendingStylesheets(5000);
    link.dispatchEvent(new Event("error"));
    await expect(promise).resolves.toBeUndefined();
  });

  it("超时放行,不把导航卡死", async () => {
    vi.useFakeTimers();
    addStylesheet("/assets/WorkspacePage.css", false);
    const promise = awaitPendingStylesheets(400);
    vi.advanceTimersByTime(400);
    await expect(promise).resolves.toBeUndefined();
    vi.useRealTimers();
  });

  it("忽略跨域样式表(被墙的字体 CDN 不该拖住切页)", async () => {
    addStylesheet("https://fonts.googleapis.com/css2?family=Noto+Serif+SC", false);
    await expect(awaitPendingStylesheets(50)).resolves.toBeUndefined();
  });
});
