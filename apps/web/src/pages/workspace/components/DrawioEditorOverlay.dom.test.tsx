// @vitest-environment jsdom

import { DEFAULT_DRAWIO_SOURCE } from "@qingagent/pm-schema";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DRAWIO_EXPORT_TIMEOUT_MS,
  DRAWIO_FALLBACK_TIMEOUT_MS,
  type DrawioEditorResult,
} from "./drawioEmbedProtocol";
import { DrawioEditorOverlay } from "./DrawioEditorOverlay";
import { renderDrawio } from "./drawioRender";

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

  it("offline 模式仍精确恢复三个 embed 保存按钮", async () => {
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
    const buttonContainer = frameDocument.createElement("div");
    buttonContainer.className = "geButtonContainer";
    buttonContainer.style.display = "none";
    for (const label of ["保存", "保存并退出", "退出"]) {
      const button = frameDocument.createElement("button");
      button.textContent = label;
      buttonContainer.appendChild(button);
    }
    toolbar.appendChild(buttonContainer);
    frameBody.appendChild(toolbar);

    await act(async () => fake.iframe.dispatchEvent(new Event("load")));

    expect(
      frameDocument.getElementById("qingagent-drawio-embed-fixes")?.textContent,
    ).toContain(".geToolbarContainer > .geButtonContainer");
    expect(fake.frameWindow.getComputedStyle(buttonContainer).display).toBe("inline-flex");
    expect(Array.from(buttonContainer.children).map((button) => button.textContent)).toEqual([
      "保存",
      "保存并退出",
      "退出",
    ]);
  });

  it("保存不退出时按 snapshot 握手立即回写，并保持编辑器打开", async () => {
    const onSave = vi.fn();
    const onClose = vi.fn();
    const fake = await createFakeV31Embed(onSave, onClose);
    await fake.init();

    const source = drawioSource("保存后继续编辑");
    await fake.save(source, false);
    expect(postedAction(fake.postMessage, 1)).toEqual({ action: "snapshot" });
    expect(requireIframe().classList.contains("is-saving")).toBe(true);

    await fake.exportSvg(svgDataUri("保存后继续编辑", ' onload="x()"'));

    expect(onSave).toHaveBeenCalledWith({
      source,
      svg: expect.stringContaining("保存后继续编辑"),
    });
    expect(onSave.mock.calls[0]?.[0]?.svg).not.toContain("onload");
    expect(onClose).not.toHaveBeenCalled();
    expect(postedAction(fake.postMessage, 2)).toEqual({
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
      { action: "snapshot" },
    ]);
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
      "snapshot",
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
    expect(postedAction(fake.postMessage, 2)).toEqual({
      action: "status",
      modified: false,
    });
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

  it("取消按钮和 Escape 从未保存时都返回 null", async () => {
    const firstClose = vi.fn();
    await renderOverlay(vi.fn(), firstClose);
    const cancel = document.querySelector<HTMLButtonElement>(".drawio-editor-overlay__cancel");
    await act(async () => cancel?.click());
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

  it("保存导出等待期间取消不回写，且不会启动超时降级", async () => {
    vi.useFakeTimers();
    vi.mocked(renderDrawio).mockResolvedValue(
      '<svg xmlns="http://www.w3.org/2000/svg"><text>不应写入</text></svg>',
    );
    const onSave = vi.fn();
    const onClose = vi.fn();
    const fake = await createFakeV31Embed(onSave, onClose);
    await fake.init();
    await fake.save(drawioSource("取消修改"), true);

    await act(async () => {
      document.querySelector<HTMLButtonElement>(".drawio-editor-overlay__cancel")?.click();
      await vi.advanceTimersByTimeAsync(DRAWIO_EXPORT_TIMEOUT_MS);
    });

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledWith(null);
    expect(onSave).not.toHaveBeenCalled();
    expect(renderDrawio).not.toHaveBeenCalled();
  });
});

type FakeV31Embed = {
  iframe: HTMLIFrameElement;
  frameWindow: Window;
  postMessage: ReturnType<typeof vi.spyOn>;
  init: () => Promise<void>;
  save: (source: string, exit?: boolean) => Promise<void>;
  exportSvg: (data: string) => Promise<void>;
  exit: () => Promise<void>;
  dispatch: (origin: string, data: unknown) => Promise<void>;
  postedActions: () => Array<Record<string, unknown>>;
};

async function createFakeV31Embed(
  onSave: (result: DrawioEditorResult) => void,
  onClose: (result: DrawioEditorResult | null) => void,
): Promise<FakeV31Embed> {
  await renderOverlay(onSave, onClose);
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
) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(
      <DrawioEditorOverlay
        source={DEFAULT_DRAWIO_SOURCE}
        title="测试 drawio"
        onSave={onSave}
        onClose={onClose}
      />,
    );
  });
}

function requireIframe(): HTMLIFrameElement {
  const iframe = document.querySelector<HTMLIFrameElement>(".drawio-editor-overlay__frame");
  if (!iframe) throw new Error("drawio iframe 缺失");
  return iframe;
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
