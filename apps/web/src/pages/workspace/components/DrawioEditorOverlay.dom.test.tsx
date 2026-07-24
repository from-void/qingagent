// @vitest-environment jsdom

import { DEFAULT_DRAWIO_SOURCE } from "@qingagent/pm-schema";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DrawioEditorOverlay } from "./DrawioEditorOverlay";

let root: Root | null = null;
let host: HTMLDivElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  vi.restoreAllMocks();
});

describe("drawio 全屏编辑面板", () => {
  it("只信任当前 iframe 的同源消息，保存后等待匹配 nonce 的安全 SVG", async () => {
    const onClose = vi.fn();
    await renderOverlay(onClose);
    const iframe = requireIframe();
    const frameWindow = iframe.contentWindow;
    if (!frameWindow) throw new Error("iframe contentWindow 缺失");
    const postMessage = vi.spyOn(frameWindow, "postMessage").mockImplementation(() => undefined);

    await dispatch(frameWindow, "https://evil.example", { event: "init" });
    await dispatch(window, window.location.origin, { event: "init" });
    expect(postMessage).not.toHaveBeenCalled();

    await dispatch(frameWindow, window.location.origin, { event: "init" });
    const load = postedAction(postMessage, 0);
    expect(load).toMatchObject({
      action: "load",
      xml: DEFAULT_DRAWIO_SOURCE,
      saveAndExit: true,
    });

    const source = DEFAULT_DRAWIO_SOURCE.replace('value="开始"', 'value="已保存"');
    await dispatch(frameWindow, window.location.origin, { event: "save", xml: source, exit: true });
    const exportAction = postedAction(postMessage, 1);
    expect(exportAction).toMatchObject({
      action: "export",
      format: "svg",
      xml: source,
      embedImages: true,
      embedFonts: true,
    });
    expect(typeof exportAction.message).toBe("string");

    // saveAndExit 后紧跟的 exit 不能抢先把有效保存判为取消。
    await dispatch(frameWindow, window.location.origin, { event: "exit" });
    expect(onClose).not.toHaveBeenCalled();

    const rawSvg = '<svg xmlns="http://www.w3.org/2000/svg" onload="x()"><text>已保存</text></svg>';
    await dispatch(frameWindow, window.location.origin, {
      event: "export",
      format: "svg",
      message: "qingagent-drawio-export:wrong",
      data: `data:image/svg+xml,${encodeURIComponent(rawSvg)}`,
    });
    expect(onClose).not.toHaveBeenCalled();

    await dispatch(frameWindow, window.location.origin, {
      event: "export",
      format: "svg",
      message: exportAction.message,
      data: `data:image/svg+xml,${encodeURIComponent(rawSvg)}`,
    });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledWith({
      source,
      svg: expect.stringContaining("已保存"),
    });
    expect(onClose.mock.calls[0]?.[0]?.svg).not.toContain("onload");
  });

  it("取消按钮和 Escape 都返回 null，且不生成保存动作", async () => {
    const onClose = vi.fn();
    await renderOverlay(onClose);
    const cancel = document.querySelector<HTMLButtonElement>(".drawio-editor-overlay__cancel");
    expect(cancel).not.toBeNull();
    await act(async () => cancel?.click());
    expect(onClose).toHaveBeenCalledWith(null);

    const secondClose = vi.fn();
    act(() => root?.unmount());
    root = null;
    host?.remove();
    host = null;
    await renderOverlay(secondClose);
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", cancelable: true }));
    });
    expect(secondClose).toHaveBeenCalledWith(null);
  });
});

async function renderOverlay(onClose: (result: unknown) => void) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(
      <DrawioEditorOverlay
        source={DEFAULT_DRAWIO_SOURCE}
        title="测试 drawio"
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

async function dispatch(source: MessageEventSource, origin: string, data: unknown) {
  await act(async () => {
    window.dispatchEvent(new MessageEvent("message", { source, origin, data }));
  });
}

function postedAction(spy: ReturnType<typeof vi.spyOn>, callIndex: number): Record<string, unknown> {
  const data = spy.mock.calls[callIndex]?.[0];
  if (typeof data !== "string") throw new Error(`第 ${callIndex + 1} 个 postMessage 不是 JSON 字符串`);
  return JSON.parse(data) as Record<string, unknown>;
}
