// @vitest-environment jsdom

import { DEFAULT_DRAWIO_SOURCE } from "@qingagent/pm-schema";
import { readFileSync } from "node:fs";
import path from "node:path";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DRAWIO_AUTOSAVE_DEBOUNCE_MS,
  DRAWIO_CLOSE_WATCHDOG_MS,
  DRAWIO_EXPORT_TIMEOUT_MS,
  DRAWIO_FALLBACK_TIMEOUT_MS,
  type DrawioEditorResult,
} from "./drawioEmbedProtocol";
import { DrawioEditorOverlay } from "./DrawioEditorOverlay";
import { renderDrawio } from "./drawioRender";
import { ConfirmProvider } from "../../../system/ConfirmProvider";

const diagramEditorChromeCss = readFileSync(path.join(process.cwd(), "src/pages/workspace/components/diagramEditorChrome.css"), "utf8");
const drawioEditorCss = readFileSync(path.join(process.cwd(), "src/pages/workspace/components/DrawioEditorOverlay.css"), "utf8");

vi.mock("./drawioRender", () => ({
  renderDrawio: vi.fn(),
}));

let root: Root | null = null;
let host: HTMLDivElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  vi.useRealTimers();
  vi.mocked(renderDrawio).mockReset();
  vi.restoreAllMocks();
});

describe("drawio 全屏编辑面板", () => {
  it("与 Mermaid 共用标题和关闭 chrome，右上角只显示关闭符号", async () => {
    await renderOverlay(vi.fn(), vi.fn());
    const overlay = document.querySelector<HTMLElement>(".drawio-editor-overlay");
    expect(overlay?.classList.contains("diagram-editor-chrome")).toBe(true);
    expect(overlay?.getAttribute("aria-label")).toBe("Drawio 编辑");
    expect(overlay?.querySelector(".diagram-editor-chrome__title")?.textContent).toBe("Drawio 编辑");
    const closeButton = overlay?.querySelector<HTMLButtonElement>(".diagram-editor-chrome__close");
    expect(closeButton?.textContent?.trim()).toBe("✕");
    expect(closeButton?.getAttribute("aria-label")).toBe("关闭");
    expect(overlay?.querySelectorAll(".diagram-editor-chrome__close")).toHaveLength(1);
    expect(diagramEditorChromeCss).toMatch(/\.diagram-editor-chrome__topbar\s*\{[^}]*background:\s*var\(--bg-paper-deep,\s*#f6f1e7\);/s);
    expect(drawioEditorCss).toMatch(/\.drawio-editor-overlay\s*\{[^}]*background:\s*var\(--bg-paper-deep\);/s);
  });

  it("启动期盖住 vendor 首屏，图表加载后揭开，自愈重载时重新盖住", async () => {
    const fake = await createFakeV31Embed(vi.fn(), vi.fn());

    expect(document.querySelector(".drawio-editor-overlay__boot")).not.toBeNull();

    await fake.init();
    expect(document.querySelector(".drawio-editor-overlay__boot")).not.toBeNull();

    await fake.dispatch(window.location.origin, { event: "load" });
    expect(document.querySelector(".drawio-editor-overlay__boot")).toBeNull();

    await act(async () => fake.iframe.dispatchEvent(new Event("load")));
    expect(document.querySelector(".drawio-editor-overlay__boot")).not.toBeNull();
  });

  it("只信任当前 iframe 的同源消息，并忽略没有 pending 保存的 export", async () => {
    const onSave = vi.fn();
    const onClose = vi.fn();
    const fake = await createFakeV31Embed(onSave, onClose);

    await fake.dispatch("https://evil.example", { event: "init" });
    await dispatchV31(window, window.location.origin, { event: "init" });
    await fake.exportSvg(svgDataUri("不应接收"));
    expect(fake.postMessage).not.toHaveBeenCalled();
    expect(onSave).not.toHaveBeenCalled();

    await fake.init();
    expect(postedAction(fake.postMessage, 0)).toMatchObject({
      action: "load",
      xml: DEFAULT_DRAWIO_SOURCE,
      saveAndExit: true,
    });
    expect(fake.postMessage.mock.calls[0]?.[1]).toBe(window.location.origin);
  });

  it("offline 模式按真实嵌套 DOM 保留「完成 / 退出」两个出口", async () => {
    const fake = await createFakeV31Embed(vi.fn(), vi.fn());
    const frameDocument = fake.iframe.contentDocument;
    if (!frameDocument) throw new Error("iframe contentDocument 缺失");
    const frameRoot = frameDocument.documentElement
      ?? frameDocument.appendChild(frameDocument.createElement("html"));
    if (!frameDocument.head) {
      frameRoot.appendChild(frameDocument.createElement("head"));
    }
    const frameBody = frameDocument.body
      ?? frameRoot.appendChild(frameDocument.createElement("body"));
    const toolbar = frameDocument.createElement("div");
    toolbar.className = "geToolbarContainer";
    const toolbarInner = frameDocument.createElement("div");
    const buttonContainer = frameDocument.createElement("div");
    buttonContainer.className = "geButtonContainer";
    buttonContainer.style.display = "none";
    for (const label of ["保存并退出", "退出"]) {
      const button = frameDocument.createElement("button");
      button.textContent = label;
      button.title = label === "保存并退出" ? "保存并退出 (Ctrl+S)" : label;
      buttonContainer.appendChild(button);
    }
    toolbarInner.appendChild(buttonContainer);
    toolbar.appendChild(toolbarInner);
    frameBody.appendChild(toolbar);

    await act(async () => fake.iframe.dispatchEvent(new Event("load")));

    expect(
      frameDocument.getElementById("qingagent-drawio-embed-fixes")?.textContent,
    ).toContain(".geButtonContainer");
    expect(fake.frameWindow.getComputedStyle(buttonContainer).display).toBe("inline-flex");
    expect(Array.from(buttonContainer.children).map((button) => ({
      label: button.textContent,
      display: fake.frameWindow.getComputedStyle(button).display,
    }))).toEqual([
      { label: "完成", display: expect.not.stringMatching(/^none$/) },
      { label: "退出", display: expect.not.stringMatching(/^none$/) },
    ]);
  });

  it("编辑标签后点击「完成」会通过保存并退出持久化最新 XML", async () => {
    const onSave = vi.fn();
    const onClose = vi.fn();
    const fake = await createFakeV31Embed(onSave, onClose);
    await fake.init();
    const latest = drawioSource("快递入站");
    const frameDocument = fake.iframe.contentDocument;
    if (!frameDocument) throw new Error("iframe contentDocument 缺失");
    const frameRoot = frameDocument.documentElement
      ?? frameDocument.appendChild(frameDocument.createElement("html"));
    if (!frameDocument.head) {
      frameRoot.appendChild(frameDocument.createElement("head"));
    }
    const frameBody = frameDocument.body
      ?? frameRoot.appendChild(frameDocument.createElement("body"));
    const toolbar = frameDocument.createElement("div");
    toolbar.className = "geToolbarContainer";
    const buttonContainer = frameDocument.createElement("div");
    buttonContainer.className = "geButtonContainer";
    const emit = (data: unknown) => {
      window.dispatchEvent(new MessageEvent("message", {
        source: fake.frameWindow,
        origin: window.location.origin,
        data: JSON.stringify(data),
      }));
    };
    const saveButton = frameDocument.createElement("button");
    saveButton.textContent = "保存";
    saveButton.addEventListener("click", () => emit({ event: "save", xml: latest }));
    const saveAndExitButton = frameDocument.createElement("button");
    saveAndExitButton.textContent = "保存并退出";
    saveAndExitButton.addEventListener("click", () => emit({
      event: "save",
      xml: latest,
      exit: true,
    }));
    const exitButton = frameDocument.createElement("button");
    exitButton.textContent = "退出";
    exitButton.addEventListener("click", () => emit({ event: "exit", modified: true }));
    buttonContainer.append(saveButton, saveAndExitButton, exitButton);
    toolbar.appendChild(buttonContainer);
    frameBody.appendChild(toolbar);

    await act(async () => fake.iframe.dispatchEvent(new Event("load")));
    const completeButton = Array.from(buttonContainer.children).find(
      (button) => button.textContent === "完成",
    ) as HTMLButtonElement | undefined;
    if (!completeButton) throw new Error("完成按钮缺失");

    await act(async () => completeButton.click());
    expect(fake.postedActions().slice(-2)).toEqual([
      { action: "status", modified: true },
      { action: "snapshot" },
    ]);
    expect(onClose).not.toHaveBeenCalled();

    await fake.exportSvg(svgDataUri("快递入站"));

    expect(onSave).toHaveBeenCalledWith({
      source: latest,
      svg: expect.stringContaining("快递入站"),
    });
    expect(onClose).toHaveBeenCalledWith(onSave.mock.calls[0]?.[0]);
  });

  it("未保存编辑点「退出」先确认，继续编辑保留内容，确认放弃后才关闭且不保存", async () => {
    vi.useFakeTimers();
    const onSave = vi.fn();
    const onClose = vi.fn();
    const fake = await createFakeV31Embed(onSave, onClose);
    await fake.init();
    const latest = drawioSource("尚未保存的节点");
    const frameDocument = fake.iframe.contentDocument;
    if (!frameDocument) throw new Error("iframe contentDocument 缺失");
    const frameRoot = frameDocument.documentElement
      ?? frameDocument.appendChild(frameDocument.createElement("html"));
    if (!frameDocument.head) frameRoot.appendChild(frameDocument.createElement("head"));
    const frameBody = frameDocument.body
      ?? frameRoot.appendChild(frameDocument.createElement("body"));
    const buttonContainer = frameDocument.createElement("div");
    buttonContainer.className = "geButtonContainer";
    const exitButton = frameDocument.createElement("button");
    exitButton.textContent = "退出";
    exitButton.title = "退出";
    const vendorExit = vi.fn(() => void fake.exit());
    exitButton.addEventListener("click", vendorExit);
    buttonContainer.appendChild(exitButton);
    frameBody.appendChild(buttonContainer);
    await act(async () => fake.iframe.dispatchEvent(new Event("load")));
    const configuredExitButton = buttonContainer.querySelector<HTMLButtonElement>(
      '[data-qingagent-drawio-exit-capture="true"]',
    );
    if (!configuredExitButton) throw new Error("宿主退出按钮缺失");

    await fake.autosave(latest);
    await act(async () => {
      configuredExitButton.click();
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(vendorExit).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(onSave).not.toHaveBeenCalled();
    expect(document.querySelector(".drawio-editor-overlay")).not.toBeNull();
    expect(document.querySelector('[data-wf="GlobalConfirm"]')?.textContent).toContain(
      "放弃本次修改？",
    );
    await act(async () => vi.advanceTimersByTimeAsync(DRAWIO_AUTOSAVE_DEBOUNCE_MS * 2));
    expect(onSave).not.toHaveBeenCalled();

    await clickButton("继续编辑");
    expect(onClose).not.toHaveBeenCalled();
    expect(onSave).not.toHaveBeenCalled();
    expect(document.querySelector(".drawio-editor-overlay")).not.toBeNull();

    await act(async () => {
      configuredExitButton.click();
      await vi.advanceTimersByTimeAsync(0);
    });
    await clickButton("放弃修改");

    expect(onSave).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledWith(null);
  });

  it("无改动点「退出」直接关闭，不弹确认", async () => {
    const onSave = vi.fn();
    const onClose = vi.fn();
    const fake = await createFakeV31Embed(onSave, onClose);
    await fake.init();

    await fake.exit();

    expect(document.querySelector('[data-wf="GlobalConfirm"]')).toBeNull();
    expect(onSave).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledWith(null);
  });

  it("autosave 事件约一秒防抖，只为最后一版启动 snapshot 写回", async () => {
    vi.useFakeTimers();
    const onSave = vi.fn();
    const fake = await createFakeV31Embed(onSave, vi.fn());
    await fake.init();
    const first = drawioSource("防抖第一版");
    const latest = drawioSource("防抖最后版");

    await fake.autosave(first);
    await act(async () => vi.advanceTimersByTimeAsync(DRAWIO_AUTOSAVE_DEBOUNCE_MS / 2));
    await fake.autosave(latest);
    await act(async () => vi.advanceTimersByTimeAsync(DRAWIO_AUTOSAVE_DEBOUNCE_MS - 1));
    expect(fake.postedActions().map((action) => action.action)).toEqual(["load"]);

    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(fake.postedActions().slice(-2)).toEqual([
      { action: "status", modified: true },
      { action: "snapshot" },
    ]);
    await fake.exportSvg(svgDataUri("防抖最后版"));
    expect(onSave).toHaveBeenCalledOnce();
    expect(onSave).toHaveBeenCalledWith({
      source: latest,
      svg: expect.stringContaining("防抖最后版"),
    });
  });

  it("上一笔 snapshot 未完成时不并发，完成后串行写回排队的最后一版", async () => {
    vi.useFakeTimers();
    const onSave = vi.fn();
    const fake = await createFakeV31Embed(onSave, vi.fn());
    await fake.init();
    const first = drawioSource("串行第一版");
    const latest = drawioSource("串行最后版");

    await fake.autosave(first);
    await act(async () => vi.advanceTimersByTimeAsync(DRAWIO_AUTOSAVE_DEBOUNCE_MS));
    await fake.autosave(latest);
    await act(async () => vi.advanceTimersByTimeAsync(DRAWIO_AUTOSAVE_DEBOUNCE_MS - 1));
    expect(fake.postedActions().filter((action) => action.action === "snapshot")).toHaveLength(1);

    await fake.exportSvg(svgDataUri("串行第一版"));
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(fake.postedActions().filter((action) => action.action === "snapshot")).toHaveLength(1);

    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(fake.postedActions().filter((action) => action.action === "snapshot")).toHaveLength(2);

    await fake.exportSvg(svgDataUri("串行最后版"));
    expect(onSave).toHaveBeenCalledTimes(2);
    expect(onSave.mock.calls[1]?.[0]).toMatchObject({
      source: latest,
      svg: expect.stringContaining("串行最后版"),
    });
  });

  it("点击关闭当场退出，防抖中的最后一版源码仍然落盘", async () => {
    vi.useFakeTimers();
    const onSave = vi.fn();
    const onClose = vi.fn();
    const fake = await createFakeV31Embed(onSave, onClose);
    await fake.init();
    const latest = drawioSource("关闭前最后一版");

    await fake.autosave(latest);
    await act(async () => {
      requireCloseButton().click();
    });

    // 关闭不再等任何一拍导出：当场结算，只把最后一版源码尽力写出去。
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ source: latest, svg: null }));
    expect(onClose).toHaveBeenCalledWith(onSave.mock.calls[0]?.[0]);
    expect(fake.postedActions().some((action) => action.action === "snapshot")).toBe(false);
    await expectQuiescent(fake, onSave, onClose);
  });

  it("保存不退出时按 snapshot 握手立即回写，并保持编辑器打开", async () => {
    const onSave = vi.fn();
    const onClose = vi.fn();
    const fake = await createFakeV31Embed(onSave, onClose);
    await fake.init();

    const source = drawioSource("保存后继续编辑");
    await fake.save(source, false);
    expect(postedAction(fake.postMessage, 1)).toEqual({
      action: "status",
      modified: true,
    });
    expect(postedAction(fake.postMessage, 2)).toEqual({ action: "snapshot" });
    expect(requireIframe().classList.contains("is-saving")).toBe(true);

    await fake.exportSvg(svgDataUri("保存后继续编辑", ' onload="x()"'));

    expect(onSave).toHaveBeenCalledWith({
      source,
      svg: expect.stringContaining("保存后继续编辑"),
    });
    expect(onSave.mock.calls[0]?.[0]?.svg).not.toContain("onload");
    expect(onClose).not.toHaveBeenCalled();
    expect(postedAction(fake.postMessage, 3)).toEqual({
      action: "status",
      modified: false,
    });
    expect(requireIframe().classList.contains("is-saving")).toBe(false);
  });

  it("保存并退出会等原生 SVG 完成后再关闭", async () => {
    const onSave = vi.fn();
    const onClose = vi.fn();
    const fake = await createFakeV31Embed(onSave, onClose);
    await fake.init();

    const source = drawioSource("保存并退出");
    await fake.save(source, true);
    // 即使 v31 紧邻发 exit，也不能抢在 pending snapshot 前结算。
    await fake.exit();
    expect(onClose).not.toHaveBeenCalled();

    await fake.exportSvg(svgDataUri("保存并退出"));

    const expected = {
      source,
      svg: expect.stringContaining("保存并退出"),
    };
    expect(onSave).toHaveBeenCalledWith(expected);
    expect(onClose).toHaveBeenCalledWith(expected);
    expect(fake.postedActions()).toEqual([
      expect.objectContaining({ action: "load" }),
      { action: "status", modified: true },
      { action: "snapshot" },
      { action: "status", modified: false },
    ]);
  });

  it("普通保存等待导出期间点退出先确认，继续编辑后保存仍可完成", async () => {
    const onSave = vi.fn();
    const onClose = vi.fn();
    const fake = await createFakeV31Embed(onSave, onClose);
    await fake.init();

    const source = drawioSource("保存期间退出");
    await fake.save(source, false);
    await fake.exit();
    expect(onClose).not.toHaveBeenCalled();
    expect(document.querySelector('[data-wf="GlobalConfirm"]')).not.toBeNull();

    await clickButton("继续编辑");

    await fake.exportSvg(svgDataUri("保存期间退出"));

    const expected = {
      source,
      svg: expect.stringContaining("保存期间退出"),
    };
    expect(onSave).toHaveBeenCalledWith(expected);
    expect(onClose).not.toHaveBeenCalled();

    await fake.exit();
    expect(onClose).toHaveBeenCalledWith(expected);
  });

  it("无改动关闭不触发 snapshot 或降级覆盖高保真", async () => {
    vi.useFakeTimers();
    const onSave = vi.fn();
    const onClose = vi.fn();
    const fake = await createFakeV31Embed(onSave, onClose);
    await fake.init();

    await fake.autosave(DEFAULT_DRAWIO_SOURCE);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(DRAWIO_AUTOSAVE_DEBOUNCE_MS);
      requireCloseButton().click();
    });

    expect(fake.postedActions()).toEqual([expect.objectContaining({ action: "load" })]);
    expect(renderDrawio).not.toHaveBeenCalled();
    expect(onSave).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledWith(null);
  });

  it("保存后立即保存并退出会复用上一轮高保真结果", async () => {
    vi.useFakeTimers();
    const onSave = vi.fn();
    const onClose = vi.fn();
    const fake = await createFakeV31Embed(onSave, onClose);
    await fake.init();

    const source = drawioSource("连续保存");
    await fake.save(source, false);
    await fake.exportSvg(svgDataUri("连续保存高保真"));
    const firstResult = onSave.mock.calls[0]?.[0];

    await fake.save(source, true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(DRAWIO_EXPORT_TIMEOUT_MS);
    });

    expect(renderDrawio).not.toHaveBeenCalled();
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledWith(firstResult);
    expect(fake.postedActions().map((action) => action.action)).toEqual([
      "load",
      "status",
      "snapshot",
      "status",
    ]);
  });

  it("连续多次保存只保留最近一条高保真结果", async () => {
    vi.useFakeTimers();
    const fallbackSvg = '<svg xmlns="http://www.w3.org/2000/svg"><text>低保真</text></svg>';
    vi.mocked(renderDrawio).mockResolvedValue(fallbackSvg);
    const onSave = vi.fn();
    const onClose = vi.fn();
    const fake = await createFakeV31Embed(onSave, onClose);
    await fake.init();

    const protectedSource = drawioSource("受保护");
    await fake.save(protectedSource, false);
    await fake.exportSvg(svgDataUri("受保护高保真"));

    const otherSource = drawioSource("另一版本");
    await fake.save(otherSource, false);
    await fake.exportSvg(svgDataUri("另一版本高保真"));

    await fake.save(protectedSource, true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(DRAWIO_EXPORT_TIMEOUT_MS);
    });

    expect(renderDrawio).toHaveBeenCalledWith(protectedSource);
    expect(onSave).toHaveBeenCalledTimes(3);
    expect(onSave.mock.calls[2]?.[0]).toEqual({
      source: protectedSource,
      svg: fallbackSvg,
      warning: "drawio 原生 SVG 导出超时，已改用本地渲染保存",
    });
    expect(onClose).toHaveBeenCalledWith(onSave.mock.calls[2]?.[0]);
  });

  it("退出且从未保存时不回写", async () => {
    const onSave = vi.fn();
    const onClose = vi.fn();
    const fake = await createFakeV31Embed(onSave, onClose);
    await fake.init();

    await fake.exit();

    expect(onSave).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledWith(null);
  });

  it("连续两轮保存每轮都接收无 message 回显的新鲜 SVG", async () => {
    const onSave = vi.fn();
    const onClose = vi.fn();
    const fake = await createFakeV31Embed(onSave, onClose);
    await fake.init();

    const firstSource = drawioSource("第一轮");
    await fake.save(firstSource, false);
    await fake.exportSvg(svgDataUri("第一轮 SVG"));

    const secondSource = drawioSource("第二轮");
    await fake.save(secondSource, false);
    await fake.exportSvg(svgDataUri("第二轮 SVG"));

    expect(onSave).toHaveBeenCalledTimes(2);
    expect(onSave.mock.calls[0]?.[0]).toMatchObject({
      source: firstSource,
      svg: expect.stringContaining("第一轮 SVG"),
    });
    expect(onSave.mock.calls[1]?.[0]).toMatchObject({
      source: secondSource,
      svg: expect.stringContaining("第二轮 SVG"),
    });
    expect(onSave.mock.calls[1]?.[0]?.svg).not.toContain("第一轮 SVG");
    expect(onClose).not.toHaveBeenCalled();
    expect(fake.postedActions().map((action) => action.action)).toEqual([
      "load",
      "status",
      "snapshot",
      "status",
      "status",
      "snapshot",
      "status",
    ]);

    await fake.exit();
    expect(onClose).toHaveBeenCalledWith(onSave.mock.calls[1]?.[0]);
  });

  it("原生 export 缺失 5 秒后仍用 maxGraph 保存，并保持非退出会话", async () => {
    vi.useFakeTimers();
    const fallbackSvg = '<svg xmlns="http://www.w3.org/2000/svg"><text>本地缓存</text></svg>';
    vi.mocked(renderDrawio).mockResolvedValue(fallbackSvg);
    const onSave = vi.fn();
    const onClose = vi.fn();
    const fake = await createFakeV31Embed(onSave, onClose);
    await fake.init();

    const source = drawioSource("超时保存");
    await fake.save(source, false);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(DRAWIO_EXPORT_TIMEOUT_MS);
    });

    expect(renderDrawio).toHaveBeenCalledWith(source);
    expect(onSave).toHaveBeenCalledWith({
      source,
      svg: fallbackSvg,
      warning: "drawio 原生 SVG 导出超时，已改用本地渲染保存",
    });
    expect(onClose).not.toHaveBeenCalled();
    expect(postedAction(fake.postMessage, 3)).toEqual({
      action: "status",
      modified: false,
    });
  });

  it("同一源码首次降级保存后再次保存仍会重试原生导出", async () => {
    vi.useFakeTimers();
    const fallbackSvg = '<svg xmlns="http://www.w3.org/2000/svg"><text>低保真缓存</text></svg>';
    vi.mocked(renderDrawio).mockResolvedValue(fallbackSvg);
    const onSave = vi.fn();
    const onClose = vi.fn();
    const fake = await createFakeV31Embed(onSave, onClose);
    await fake.init();

    const source = drawioSource("降级后重试");
    await fake.save(source, false);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(DRAWIO_EXPORT_TIMEOUT_MS);
    });

    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave.mock.calls[0]?.[0]).toEqual({
      source,
      svg: fallbackSvg,
      warning: "drawio 原生 SVG 导出超时，已改用本地渲染保存",
    });

    await fake.save(source, false);

    expect(onSave).toHaveBeenCalledTimes(1);
    expect(renderDrawio).toHaveBeenCalledTimes(1);
    expect(fake.postedActions().slice(-2)).toEqual([
      { action: "status", modified: true },
      { action: "snapshot" },
    ]);

    await fake.exportSvg(svgDataUri("重试得到高保真"));

    expect(onSave).toHaveBeenCalledTimes(2);
    expect(onSave.mock.calls[1]?.[0]).toEqual({
      source,
      svg: expect.stringContaining("重试得到高保真"),
    });
    expect(onClose).not.toHaveBeenCalled();
  });

  it("原生 export 与本地渲染均失败时仍保存 source，并丢弃旧缓存", async () => {
    vi.useFakeTimers();
    vi.mocked(renderDrawio).mockRejectedValue(new Error("无法测量图形边界"));
    const onSave = vi.fn();
    const onClose = vi.fn();
    const fake = await createFakeV31Embed(onSave, onClose);
    await fake.init();

    const source = drawioSource("只存源码");
    await fake.save(source, true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(DRAWIO_EXPORT_TIMEOUT_MS);
    });

    expect(onSave).toHaveBeenCalledWith({
      source,
      svg: null,
      warning: expect.stringMatching(/已保存可继续编辑的源码.*无法测量图形边界/),
    });
    expect(onClose).toHaveBeenCalledWith(onSave.mock.calls[0]?.[0]);
  });

  it("maxGraph 本地渲染无响应也会超时为 source-only 结果", async () => {
    vi.useFakeTimers();
    vi.mocked(renderDrawio).mockReturnValue(new Promise<string>(() => undefined));
    const onSave = vi.fn();
    const onClose = vi.fn();
    const fake = await createFakeV31Embed(onSave, onClose);
    await fake.init();

    const source = drawioSource("本地渲染超时");
    await fake.save(source, true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(DRAWIO_EXPORT_TIMEOUT_MS + DRAWIO_FALLBACK_TIMEOUT_MS);
    });

    expect(onSave).toHaveBeenCalledWith({
      source,
      svg: null,
      warning: expect.stringMatching(/已保存可继续编辑的源码.*maxGraph 本地渲染超时/),
    });
    expect(onClose).toHaveBeenCalledWith(onSave.mock.calls[0]?.[0]);
  });

  it("原生 export 返回坏 SVG 时立即转 maxGraph，不等待 export 超时", async () => {
    vi.useFakeTimers();
    const fallbackSvg = '<svg xmlns="http://www.w3.org/2000/svg"><text>坏缓存降级</text></svg>';
    vi.mocked(renderDrawio).mockResolvedValue(fallbackSvg);
    const onSave = vi.fn();
    const onClose = vi.fn();
    const fake = await createFakeV31Embed(onSave, onClose);
    await fake.init();

    const source = drawioSource("坏缓存降级");
    await fake.save(source, true);
    await fake.dispatch(window.location.origin, {
      event: "export",
      point: { x: 0, y: 0 },
      exit: false,
      data: "data:image/svg+xml,%3Cnot-svg%2F%3E",
    });

    expect(renderDrawio).toHaveBeenCalledWith(source);
    expect(onSave).toHaveBeenCalledWith({
      source,
      svg: fallbackSvg,
      warning: expect.stringContaining("drawio 原生 SVG 不可用"),
    });
    expect(onClose).toHaveBeenCalledWith(onSave.mock.calls[0]?.[0]);
  });

  it("关闭按钮和 Escape 在无改动时都返回 null", async () => {
    const firstClose = vi.fn();
    await renderOverlay(vi.fn(), firstClose);
    await act(async () => requireCloseButton().click());
    expect(firstClose).toHaveBeenCalledWith(null);

    act(() => root?.unmount());
    root = null;
    host?.remove();
    host = null;
    const secondClose = vi.fn();
    await renderOverlay(vi.fn(), secondClose);
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", cancelable: true }));
    });
    expect(secondClose).toHaveBeenCalledWith(null);
  });

  it("等待原生导出期间点击关闭当场退出，pending 源码落盘且不再触发本地渲染", async () => {
    vi.useFakeTimers();
    vi.mocked(renderDrawio).mockResolvedValue(
      '<svg xmlns="http://www.w3.org/2000/svg"><text>不应写入</text></svg>',
    );
    const onSave = vi.fn();
    const onClose = vi.fn();
    const fake = await createFakeV31Embed(onSave, onClose);
    await fake.init();
    await fake.save(drawioSource("取消修改"), false);

    await act(async () => {
      requireCloseButton().click();
    });

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledWith(onSave.mock.calls[0]?.[0]);
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({
      source: drawioSource("取消修改"),
      svg: null,
    }));

    // 退出后既有的导出/回退定时器全部作废，不会再有第二次结算。
    await expectQuiescent(fake, onSave, onClose);
    expect(renderDrawio).not.toHaveBeenCalled();
  });
});

/**
 * 关闭路径异常态矩阵：浮层在任何异常态下都必须可关闭（用户拍板的铁律）。
 * 每种状态下点 ✕ 都必须：onClose 被调用一次、卸载后浮层消失、不留会继续干活的
 * 定时器、也不留还会响应的全局监听。
 */
describe("drawio 关闭路径异常态矩阵", () => {
  const DUPLICATED_PAGE_MODEL = `<mxGraphModel dx="0" dy="0" grid="1" page="1">
  <root>
    <mxCell id="0Bx9pQ-1-0"/>
    <mxCell id="0Bx9pQ-1-1" parent="0Bx9pQ-1-0"/>
    <mxCell id="0Bx9pQ-1-2" value="副本页" style="rounded=0;whiteSpace=wrap;html=0;fillColor=#efe3cc;strokeColor=#b08a3e;fontColor=#2f2a22;" vertex="1" parent="0Bx9pQ-1-1">
      <mxGeometry x="40" y="40" width="120" height="60" as="geometry"/>
    </mxCell>
  </root>
</mxGraphModel>`;
  const twoPageFile = (firstPageLabel: string) =>
    `<mxfile host="localhost" pages="2"><diagram id="page-1" name="第 1 页">${drawioSource(firstPageLabel)}</diagram><diagram id="page-2" name="第 1 页 的副本">${DUPLICATED_PAGE_MODEL}</diagram></mxfile>`;

  it("① 建了第 1 页的副本(多页文档)后仍可关闭，两页源码一起落盘", async () => {
    vi.useFakeTimers();
    const onSave = vi.fn();
    const onClose = vi.fn();
    const fake = await createFakeV31Embed(onSave, onClose, twoPageFile("开始"));
    await fake.init();

    await fake.autosave(twoPageFile("多页改动"));
    await act(async () => requireCloseButton().click());

    expect(onClose).toHaveBeenCalledTimes(1);
    const saved = onSave.mock.calls[0]?.[0]?.source as string;
    expect(saved).toContain("多页改动");
    expect(saved).toContain("副本页");
    expect(saved.match(/<diagram\b/g)).toHaveLength(2);
    await expectClosedCleanly(fake, onSave, onClose);
  });

  it("② 保存请求 pending 未返回时可关闭", async () => {
    vi.useFakeTimers();
    const onSave = vi.fn();
    const onClose = vi.fn();
    const fake = await createFakeV31Embed(onSave, onClose);
    await fake.init();

    await fake.save(drawioSource("请求未返回"), false);
    expect(fake.postedActions().some((action) => action.action === "snapshot")).toBe(true);
    await act(async () => requireCloseButton().click());

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ source: drawioSource("请求未返回") }));
    await expectClosedCleanly(fake, onSave, onClose);
  });

  it("③ 写回抛错(网络失败)后仍可关闭", async () => {
    vi.useFakeTimers();
    const onSave = vi.fn(() => {
      throw new Error("网络错误：写回失败");
    });
    const onClose = vi.fn();
    const fake = await createFakeV31Embed(onSave, onClose);
    await fake.init();

    await fake.save(drawioSource("写回会失败"), false);
    await fake.exportSvg(svgDataUri("写回会失败"));
    expect(onSave).toHaveBeenCalledTimes(1);

    await fake.autosave(drawioSource("失败后又改了"));
    await act(async () => requireCloseButton().click());

    expect(onClose).toHaveBeenCalledTimes(1);
    await expectClosedCleanly(fake, onSave, onClose);
  });

  it("④ iframe 还没加载完/加载失败时可关闭", async () => {
    vi.useFakeTimers();
    const onSave = vi.fn();
    const onClose = vi.fn();
    await renderOverlay(onSave, onClose);
    // 没有 init、没有 load：boot 遮罩还盖着。
    expect(document.querySelector(".drawio-editor-overlay__boot")).not.toBeNull();

    await act(async () => requireCloseButton().click());
    expect(onClose).toHaveBeenCalledWith(null);
    expect(onSave).not.toHaveBeenCalled();
    await expectQuiescentWithoutEmbed(onSave, onClose);
  });

  it("⑤ postMessage 状态机停在中间态(init 后没有 load)时可关闭", async () => {
    vi.useFakeTimers();
    const onSave = vi.fn();
    const onClose = vi.fn();
    const fake = await createFakeV31Embed(onSave, onClose);
    await fake.init();
    // 只走到 init，没有 load，也没有任何 export 回声。
    await fake.autosave(drawioSource("半路状态机"));
    await act(async () => vi.advanceTimersByTimeAsync(DRAWIO_AUTOSAVE_DEBOUNCE_MS));
    expect(fake.postedActions().some((action) => action.action === "snapshot")).toBe(true);

    await act(async () => requireCloseButton().click());
    expect(onClose).toHaveBeenCalledTimes(1);
    await expectClosedCleanly(fake, onSave, onClose);
  });

  it("⑥ 有未保存改动(防抖未到点)时可关闭且改动不丢", async () => {
    vi.useFakeTimers();
    const onSave = vi.fn();
    const onClose = vi.fn();
    const fake = await createFakeV31Embed(onSave, onClose);
    await fake.init();

    await fake.autosave(drawioSource("未保存改动"));
    await act(async () => requireCloseButton().click());

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({
      source: drawioSource("未保存改动"),
    }));
    await expectClosedCleanly(fake, onSave, onClose);
  });

  it("⑦ 「完成」等原生 SVG 超时也会被看门狗强制退出", async () => {
    vi.useFakeTimers();
    vi.mocked(renderDrawio).mockImplementation(() => new Promise(() => {}));
    const onSave = vi.fn();
    const onClose = vi.fn();
    const fake = await createFakeV31Embed(onSave, onClose);
    await fake.init();

    await fake.save(drawioSource("完成但没回声"), true);
    expect(onClose).not.toHaveBeenCalled();

    await act(async () => vi.advanceTimersByTimeAsync(DRAWIO_CLOSE_WATCHDOG_MS));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({
      source: drawioSource("完成但没回声"),
    }));
  });
});

/** 关闭后既不该再有后续结算，卸载后也不该再有任何全局监听在响应。 */
async function expectClosedCleanly(
  fake: FakeV31Embed,
  onSave: ReturnType<typeof vi.fn>,
  onClose: ReturnType<typeof vi.fn>,
) {
  await expectQuiescent(fake, onSave, onClose);
  act(() => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  expect(document.querySelector(".drawio-editor-overlay")).toBeNull();
  expect(document.body.style.overflow).toBe("");
  await expectQuiescentWithoutEmbed(onSave, onClose);
}

/** 时间快进到所有超时都过期，仍不该再触发任何回调或 postMessage。 */
async function expectQuiescent(
  fake: FakeV31Embed,
  onSave: ReturnType<typeof vi.fn>,
  onClose: ReturnType<typeof vi.fn>,
) {
  const saves = onSave.mock.calls.length;
  const closes = onClose.mock.calls.length;
  const posts = fake.postMessage.mock.calls.length;
  await act(async () => {
    await vi.advanceTimersByTimeAsync(DRAWIO_CLOSE_WATCHDOG_MS * 2);
  });
  expect(onSave.mock.calls.length).toBe(saves);
  expect(onClose.mock.calls.length).toBe(closes);
  expect(fake.postMessage.mock.calls.length).toBe(posts);
}

async function expectQuiescentWithoutEmbed(
  onSave: ReturnType<typeof vi.fn>,
  onClose: ReturnType<typeof vi.fn>,
) {
  const saves = onSave.mock.calls.length;
  const closes = onClose.mock.calls.length;
  await act(async () => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", cancelable: true }));
    window.dispatchEvent(new MessageEvent("message", {
      source: window,
      origin: window.location.origin,
      data: JSON.stringify({ event: "exit" }),
    }));
    await vi.advanceTimersByTimeAsync(DRAWIO_CLOSE_WATCHDOG_MS * 2);
  });
  expect(onSave.mock.calls.length).toBe(saves);
  expect(onClose.mock.calls.length).toBe(closes);
}

type FakeV31Embed = {
  iframe: HTMLIFrameElement;
  frameWindow: Window;
  postMessage: ReturnType<typeof vi.spyOn>;
  init: () => Promise<void>;
  save: (source: string, exit?: boolean) => Promise<void>;
  autosave: (source: string) => Promise<void>;
  exportSvg: (data: string) => Promise<void>;
  exit: () => Promise<void>;
  dispatch: (origin: string, data: unknown) => Promise<void>;
  postedActions: () => Array<Record<string, unknown>>;
};

async function createFakeV31Embed(
  onSave: (result: DrawioEditorResult) => void,
  onClose: (result: DrawioEditorResult | null) => void,
  source: string = DEFAULT_DRAWIO_SOURCE,
): Promise<FakeV31Embed> {
  await renderOverlay(onSave, onClose, source);
  const iframe = requireIframe();
  const frameWindow = iframe.contentWindow;
  if (!frameWindow) throw new Error("iframe contentWindow 缺失");
  const postMessage = vi.spyOn(frameWindow, "postMessage").mockImplementation(() => undefined);
  const dispatch = (origin: string, data: unknown) =>
    dispatchV31(frameWindow, origin, data);
  return {
    iframe,
    frameWindow,
    postMessage,
    init: () => dispatch(window.location.origin, { event: "init" }),
    save: (source, exit = false) =>
      dispatch(window.location.origin, {
        event: "save",
        pageVisible: true,
        bounds: { x: 0, y: 0, width: 120, height: 80 },
        xml: source,
        ...(exit ? { exit: true } : {}),
      }),
    autosave: (source) =>
      dispatch(window.location.origin, {
        event: "autosave",
        xml: source,
      }),
    exportSvg: (data) =>
      dispatch(window.location.origin, {
        event: "export",
        point: { x: 0, y: 0 },
        exit: false,
        data,
      }),
    exit: () => dispatch(window.location.origin, { event: "exit", modified: false }),
    dispatch,
    postedActions: () => postedActions(postMessage),
  };
}

async function renderOverlay(
  onSave: (result: DrawioEditorResult) => void,
  onClose: (result: DrawioEditorResult | null) => void,
  source: string = DEFAULT_DRAWIO_SOURCE,
) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(
      <ConfirmProvider>
        <DrawioEditorOverlay
          source={source}
          title="测试 drawio"
          onSave={onSave}
          onClose={onClose}
        />
      </ConfirmProvider>,
    );
  });
}

function requireIframe(): HTMLIFrameElement {
  const iframe = document.querySelector<HTMLIFrameElement>(".drawio-editor-overlay__frame");
  if (!iframe) throw new Error("drawio iframe 缺失");
  return iframe;
}

function requireCloseButton(): HTMLButtonElement {
  const button = document.querySelector<HTMLButtonElement>('button[aria-label="关闭"]');
  if (!button) throw new Error("drawio 关闭按钮缺失");
  return button;
}

async function clickButton(label: string): Promise<void> {
  const button = Array.from(document.querySelectorAll("button")).find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  if (!(button instanceof HTMLButtonElement)) throw new Error(`按钮缺失：${label}`);
  await act(async () => button.click());
}

async function dispatchV31(source: MessageEventSource, origin: string, data: unknown) {
  await act(async () => {
    window.dispatchEvent(new MessageEvent("message", {
      source,
      origin,
      data: JSON.stringify(data),
    }));
  });
}

function postedAction(spy: ReturnType<typeof vi.spyOn>, callIndex: number): Record<string, unknown> {
  const data = spy.mock.calls[callIndex]?.[0];
  if (typeof data !== "string") {
    throw new Error(`第 ${callIndex + 1} 个 postMessage 不是 JSON 字符串`);
  }
  return JSON.parse(data) as Record<string, unknown>;
}

function postedActions(spy: ReturnType<typeof vi.spyOn>): Array<Record<string, unknown>> {
  return spy.mock.calls.map((_call, index) => postedAction(spy, index));
}

function drawioSource(label: string): string {
  return DEFAULT_DRAWIO_SOURCE.replace('value="开始"', `value="${label}"`);
}

function svgDataUri(label: string, rootAttributes = ""): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg"${rootAttributes}><text>${label}</text></svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}
