// @vitest-environment jsdom
import { act, type ReactNode, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PmDoc } from "@qingagent/pm-schema";
import { ExportMenu, docHasNodeType } from "./ExportMenu";

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
    vi.restoreAllMocks();
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
      "Markdown 已生成 · 分栏已拍平为纵向；需保留并排版式请导出 HTML 或 PDF。",
      7000,
    );
    expect(onAction).not.toHaveBeenCalledWith(expect.stringContaining("Word"), expect.anything());
  });
});

function ExportMenuHarness({
  onClose,
  onAction = () => undefined,
  flushPendingDocSave,
  getLatestPmDoc,
}: {
  onClose: () => void;
  onAction?: (message: string, durationMs?: number) => void;
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
          flushPendingDocSave={flushPendingDocSave}
          getLatestPmDoc={getLatestPmDoc}
        />
      )}
    </div>
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
