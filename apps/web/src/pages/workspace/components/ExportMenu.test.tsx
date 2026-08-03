// @vitest-environment jsdom
import { act, type ReactNode, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PmDoc } from "@qingagent/pm-schema";
import { ExportMenu, docHasNodeType } from "./ExportMenu";
import { DerivTabBar } from "./derivatives/DerivTabBar";
import type { ToastShow, ToastShowOptions } from "../../../system/ToastProvider";
import { resetOverlayDismissStackForTest } from "../../../system/overlayDismissStack";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("../../../overlays/settings/useSkills", () => ({
  useSkills: () => ({ skills: [] }),
}));

vi.mock("../../../stores/sessionStore", () => ({
  useSessionStore: (selector: (state: {
    currentSessionId: string;
    currentSessionTitle: string;
  }) => unknown) =>
    selector({
      currentSessionId: "session-1",
      currentSessionTitle: "测试文档",
    }),
}));

let root: Root | null = null;
let host: HTMLDivElement | null = null;

describe("ExportMenu", () => {
  afterEach(() => {
    if (root) {
      act(() => root?.unmount());
      root = null;
    }
    host?.remove();
    host = null;
    Object.defineProperty(window, "electron", { configurable: true, value: undefined });
    resetOverlayDismissStackForTest();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("导出与衍生菜单以 90–120ms 快速交替五轮后，每次 Esc 都只关闭当前菜单", async () => {
    vi.useFakeTimers();
    await render(<AlternatingMenusHarness />);
    const delays = [90, 120, 95, 110, 100];

    for (const delay of delays) {
      await act(async () => host?.querySelector<HTMLButtonElement>('[data-wf="RapidExportTrigger"]')?.click());
      expect(host?.querySelector('[data-wf="ExportMenu"]')).not.toBeNull();
      await act(async () => vi.advanceTimersByTimeAsync(delay));
      await pressEscape();
      expect(host?.querySelector('[data-wf="ExportMenu"]')).toBeNull();

      await act(async () => host?.querySelector<HTMLButtonElement>('[aria-label="新建稿件"]')?.click());
      expect(host?.querySelector(".ws-deriv-menu")).not.toBeNull();
      await act(async () => vi.advanceTimersByTimeAsync(delay));
      await pressEscape();
      expect(host?.querySelector(".ws-deriv-menu")).toBeNull();
    }
  });

  it("菜单打开时再点导出按钮只走按钮 toggle,不会被 outside-click 先关闭后重开", async () => {
    const onClose = vi.fn();
    await render(<ExportMenuHarness onClose={onClose} />);
    const trigger = getTrigger();

    await act(async () => {
      trigger.dispatchEvent(mouse("mousedown"));
      trigger.dispatchEvent(mouse("mouseup"));
      trigger.click();
    });

    expect(onClose).not.toHaveBeenCalled();
    expect(host?.querySelector('[data-wf="ExportMenu"]')).toBeNull();
  });

  it("点击 anchor 外部仍会关闭菜单", async () => {
    const onClose = vi.fn();
    await render(<ExportMenuHarness onClose={onClose} />);

    await act(async () => {
      document.body.dispatchEvent(mouse("mousedown"));
    });

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("R3-04/R3-03 导出 Markdown 前先 flush 未保存编辑", async () => {
    const flushPendingDocSave = vi.fn(async () => undefined);
    const fetchMock = vi.fn(async () => new Response(new Blob(["# md"])));
    vi.stubGlobal("fetch", fetchMock);
    Object.defineProperty(URL, "createObjectURL", { value: vi.fn(() => "blob:export"), configurable: true });
    Object.defineProperty(URL, "revokeObjectURL", { value: vi.fn(), configurable: true });
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    await render(<ExportMenuHarness onClose={() => undefined} flushPendingDocSave={flushPendingDocSave} />);

    const item = host?.querySelector<HTMLButtonElement>('[data-wf="ExportFormat-markdown"]');
    if (!item) throw new Error("Markdown export item not found");
    await act(async () => {
      item.click();
    });

    expect(flushPendingDocSave).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith("/api/v1/export/session-1?format=markdown");
  });

  it("导出 HTML 走 format=html", async () => {
    const fetchMock = vi.fn(async () => new Response(new Blob(["<html></html>"])));
    vi.stubGlobal("fetch", fetchMock);
    Object.defineProperty(URL, "createObjectURL", { value: vi.fn(() => "blob:export"), configurable: true });
    Object.defineProperty(URL, "revokeObjectURL", { value: vi.fn(), configurable: true });
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    await render(<ExportMenuHarness onClose={() => undefined} />);

    const item = host?.querySelector<HTMLButtonElement>('[data-wf="ExportFormat-html"]');
    if (!item) throw new Error("HTML export item not found");
    await act(async () => {
      item.click();
    });

    expect(fetchMock).toHaveBeenCalledWith("/api/v1/export/session-1?format=html");
  });

  it("专有图表回退官方布局时在成功 toast 提示画布布局未应用", async () => {
    const fetchMock = vi.fn(async () => new Response(
      new Blob(["<html></html>"]),
      { headers: { "X-Qingagent-Export-Notice": "specialized-diagram-overlay" } },
    ));
    vi.stubGlobal("fetch", fetchMock);
    Object.defineProperty(URL, "createObjectURL", { value: vi.fn(() => "blob:export"), configurable: true });
    Object.defineProperty(URL, "revokeObjectURL", { value: vi.fn(), configurable: true });
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    const onAction = vi.fn();
    await render(<ExportMenuHarness onClose={() => undefined} onAction={onAction} />);

    const item = host?.querySelector<HTMLButtonElement>('[data-wf="ExportFormat-html"]');
    if (!item) throw new Error("HTML export item not found");
    await act(async () => {
      item.click();
    });

    expect(onAction).toHaveBeenCalledWith(
      "HTML 已开始下载 · 专有图表已保留完整语义，画布布局未应用。",
      7000,
    );
  });

  it("HTML 导出先等待 drawio 补缓存并显示逐块进度，再保存和请求导出", async () => {
    const events: string[] = [];
    let finishPreparation: (() => void) | undefined;
    const preparation = new Promise<void>((resolve) => {
      finishPreparation = resolve;
    });
    const prepareDrawioForExport = vi.fn(
      async (onProgress: (current: number, total: number) => void) => {
        events.push("prepare");
        onProgress(3, 12);
        await preparation;
      },
    );
    const flushPendingDocSave = vi.fn(async () => {
      events.push("flush");
    });
    const fetchMock = vi.fn(async () => {
      events.push("fetch");
      return new Response(new Blob(["<html></html>"]));
    });
    vi.stubGlobal("fetch", fetchMock);
    Object.defineProperty(URL, "createObjectURL", { value: vi.fn(() => "blob:export"), configurable: true });
    Object.defineProperty(URL, "revokeObjectURL", { value: vi.fn(), configurable: true });
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    await render(
      <ExportMenuHarness
        onClose={() => undefined}
        prepareDrawioForExport={prepareDrawioForExport}
        flushPendingDocSave={flushPendingDocSave}
      />,
    );

    const item = host?.querySelector<HTMLButtonElement>('[data-wf="ExportFormat-html"]');
    if (!item) throw new Error("HTML export item not found");
    await act(async () => {
      item.click();
      await Promise.resolve();
    });

    expect(item.textContent).toContain("正在渲染图表 3/12");
    expect(events).toEqual(["prepare"]);

    await act(async () => {
      finishPreparation?.();
      await preparation;
    });
    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
    expect(events).toEqual(["prepare", "flush", "fetch"]);
  });

  it("递归识别 column/table/list/callout 内的节点类型", () => {
    expect(docHasNodeType(columnDoc(), "columnList")).toBe(true);
    expect(docHasNodeType(columnDoc(), "orderedList")).toBe(true);
    expect(docHasNodeType(columnDoc(), "tableCell")).toBe(true);
    expect(docHasNodeType(columnDoc(), "callout")).toBe(true);
    expect(docHasNodeType(columnDoc(), "paragraph")).toBe(true);
  });

  it("Markdown 导出遇到分栏时只推荐 HTML/PDF 并传 toast 时长", async () => {
    const fetchMock = vi.fn(async () => new Response(new Blob(["# md"])));
    vi.stubGlobal("fetch", fetchMock);
    Object.defineProperty(URL, "createObjectURL", { value: vi.fn(() => "blob:export"), configurable: true });
    Object.defineProperty(URL, "revokeObjectURL", { value: vi.fn(), configurable: true });
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    const onAction = vi.fn();
    const flushPendingDocSave = vi.fn(async () => undefined);
    await render(
      <ExportMenuHarness
        onClose={() => undefined}
        onAction={onAction}
        flushPendingDocSave={flushPendingDocSave}
        getLatestPmDoc={columnDoc}
      />,
    );

    const item = host?.querySelector<HTMLButtonElement>('[data-wf="ExportFormat-markdown"]');
    if (!item) throw new Error("Markdown export item not found");
    await act(async () => {
      item.click();
    });

    expect(flushPendingDocSave).toHaveBeenCalledTimes(1);
    expect(onAction).toHaveBeenCalledWith(
      "Markdown 已开始下载 · 分栏已拍平为纵向；需保留并排版式请导出 HTML 或 PDF。",
      7000,
    );
    expect(onAction).not.toHaveBeenCalledWith(expect.stringContaining("Word"), expect.anything());
  });

  it("桌面端把 Blob 字节交给 IPC，等主进程写盘成功后才提示且不创建 Blob URL", async () => {
    let finishDownload: ((result: ElectronExportDownloadResult) => void) | undefined;
    const saveExportDownload = vi.fn((_input: {
      filename: string;
      format: ElectronExportFormat;
      bytes: Uint8Array;
    }) => new Promise<ElectronExportDownloadResult>((resolve) => {
      finishDownload = resolve;
    }));
    const revealExportDownload = vi.fn(async () => true);
    Object.defineProperty(window, "electron", {
      configurable: true,
      value: {
        platform: "win32",
        isDesktop: true,
        saveExportDownload,
        revealExportDownload,
      },
    });
    const fetchMock = vi.fn(async () => new Response("%PDF"));
    vi.stubGlobal("fetch", fetchMock);
    const createObjectURL = vi.fn(() => "blob:export");
    const revokeObjectURL = vi.fn();
    Object.defineProperty(URL, "createObjectURL", { value: createObjectURL, configurable: true });
    Object.defineProperty(URL, "revokeObjectURL", { value: revokeObjectURL, configurable: true });
    const onAction = vi.fn();
    await render(<ExportMenuHarness onClose={() => undefined} onAction={onAction as ToastShow} />);

    const item = host?.querySelector<HTMLButtonElement>('[data-wf="ExportFormat-pdf"]');
    if (!item) throw new Error("PDF export item not found");
    await act(async () => {
      item.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    await vi.waitFor(() => {
      expect(saveExportDownload).toHaveBeenCalledTimes(1);
    });
    expect(item.textContent).toContain("正在保存");
    expect(onAction).not.toHaveBeenCalledWith(expect.objectContaining({ message: "PDF 已保存" }));
    const saveInput = saveExportDownload.mock.calls[0]?.[0];
    expect(saveInput?.format).toBe("pdf");
    expect(saveInput?.filename).toMatch(/^测试文档_\d{8}\.pdf$/);
    expect(saveInput?.bytes).toBeInstanceOf(Uint8Array);
    expect(new TextDecoder().decode(saveInput?.bytes)).toBe("%PDF");
    expect(createObjectURL).not.toHaveBeenCalled();
    expect(revokeObjectURL).not.toHaveBeenCalled();

    await act(async () => {
      finishDownload?.({
        saved: true,
        filename: "测试文档_20260729.pdf",
        path: "C:\\Users\\tester\\Downloads\\测试文档_20260729.pdf",
        revealToken: "reveal-pdf",
      });
      await Promise.resolve();
    });

    const success = onAction.mock.calls
      .map(([input]) => input)
      .find((input): input is ToastShowOptions => (
        typeof input === "object" && input?.message === "PDF 已保存"
    ));
    expect(success).toBeDefined();
    expect(success?.action?.label).toBe("打开所在文件夹");
    expect(createObjectURL).not.toHaveBeenCalled();
    expect(revokeObjectURL).not.toHaveBeenCalled();

    success?.action?.onClick();
    await vi.waitFor(() => {
      expect(revealExportDownload).toHaveBeenCalledWith("reveal-pdf");
    });
  });

  it.each([
    ["cancelled", "导出已取消"],
    ["interrupted", "导出未保存 · 请重试"],
    ["not-started", "导出未保存 · 请重试"],
    ["write-failed", "导出未保存 · 请重试"],
    ["timeout", "导出未保存 · 请重试"],
    ["window-closed", "导出未保存 · 请重试"],
  ] as const)("桌面端 %s 不误报成功并给可读失败文案", async (reason, expectedMessage) => {
    Object.defineProperty(window, "electron", {
      configurable: true,
      value: {
        platform: "win32",
        isDesktop: true,
        saveExportDownload: vi.fn(async () => ({
          saved: false as const,
          filename: "测试文档_20260729.docx",
          reason,
        })),
        revealExportDownload: vi.fn(async () => true),
      },
    });
    vi.stubGlobal("fetch", vi.fn(async () => new Response("PK")));
    const onAction = vi.fn();
    const onClose = vi.fn();
    await render(<ExportMenuHarness onClose={onClose} onAction={onAction as ToastShow} />);

    const item = host?.querySelector<HTMLButtonElement>('[data-wf="ExportFormat-docx"]');
    if (!item) throw new Error("Word export item not found");
    await act(async () => {
      item.click();
      await Promise.resolve();
    });

    await vi.waitFor(() => {
      expect(onAction).toHaveBeenCalledWith(expectedMessage);
    });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(host?.querySelector('[data-wf="ExportFormat-docx"]')).toBeNull();
    expect(onAction).not.toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining("已保存") }),
    );
  });
});

function ExportMenuHarness({
  onClose,
  onAction = (() => "test-toast") as ToastShow,
  prepareDrawioForExport,
  flushPendingDocSave,
  getLatestPmDoc,
}: {
  onClose: () => void;
  onAction?: ToastShow;
  prepareDrawioForExport?: (
    onProgress: (current: number, total: number) => void,
  ) => Promise<void>;
  flushPendingDocSave?: () => Promise<void>;
  getLatestPmDoc?: () => PmDoc | null;
}) {
  const [open, setOpen] = useState(true);
  const anchorRef = useRef<HTMLDivElement>(null);
  const close = () => {
    onClose();
    setOpen(false);
  };

  return (
    <div ref={anchorRef}>
      <button type="button" data-wf="ExportTrigger" onClick={() => setOpen((v) => !v)}>
        导出
      </button>
      {open && (
        <ExportMenu
          anchorRef={anchorRef}
          onClose={close}
          onAction={onAction}
          prepareDrawioForExport={prepareDrawioForExport}
          flushPendingDocSave={flushPendingDocSave}
          getLatestPmDoc={getLatestPmDoc}
        />
      )}
    </div>
  );
}

function AlternatingMenusHarness() {
  const [exportOpen, setExportOpen] = useState(false);
  const exportAnchorRef = useRef<HTMLDivElement>(null);
  return (
    <>
      <div ref={exportAnchorRef}>
        <button
          type="button"
          data-wf="RapidExportTrigger"
          onClick={() => setExportOpen((open) => !open)}
        >
          导出
        </button>
        {exportOpen ? (
          <ExportMenu
            anchorRef={exportAnchorRef}
            onClose={() => setExportOpen(false)}
            onAction={() => "test-toast"}
          />
        ) : null}
      </div>
      <DerivTabBar
        title="主文档"
        items={[]}
        activeTab="main"
        onActivate={() => undefined}
        onCreate={() => undefined}
        onRename={() => undefined}
      />
    </>
  );
}

function columnDoc(): PmDoc {
  return {
    type: "doc",
    attrs: { schemaVersion: 1 },
    content: [
      {
        type: "columnList",
        attrs: { blockId: "cols" },
        content: [
          {
            type: "column",
            attrs: { blockId: "col-1", widthRatio: 0.5 },
            content: [
              {
                type: "orderedList",
                attrs: { blockId: "ol", start: 1 },
                content: [
                  {
                    type: "listItem",
                    attrs: { blockId: "li" },
                    content: [{ type: "paragraph", attrs: { blockId: "li-p" }, content: [{ type: "text", text: "甲" }] }],
                  },
                ],
              },
            ],
          },
          {
            type: "column",
            attrs: { blockId: "col-2", widthRatio: 0.5 },
            content: [
              { type: "paragraph", attrs: { blockId: "p" }, content: [{ type: "text", text: "乙" }] },
              {
                type: "table",
                attrs: { blockId: "table" },
                content: [
                  {
                    type: "tableRow",
                    content: [
                      {
                        type: "tableCell",
                        content: [{ type: "paragraph", attrs: { blockId: "cell-p" }, content: [{ type: "text", text: "格" }] }],
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      },
      {
        type: "callout",
        attrs: { blockId: "callout", tone: "info", emoji: "i" },
        content: [{ type: "paragraph", attrs: { blockId: "callout-p" }, content: [{ type: "text", text: "提示" }] }],
      },
    ],
  };
}

async function render(element: ReactNode): Promise<void> {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(element);
  });
}

function getTrigger(): HTMLButtonElement {
  const trigger = host?.querySelector<HTMLButtonElement>('[data-wf="ExportTrigger"]');
  if (!trigger) throw new Error("Export trigger not found");
  return trigger;
}

function mouse(type: "mousedown" | "mouseup"): MouseEvent {
  return new MouseEvent(type, { bubbles: true, cancelable: true });
}

async function pressEscape(): Promise<void> {
  await act(async () => {
    window.dispatchEvent(new KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
      cancelable: true,
    }));
  });
}
