import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FolderSource } from "@qingagent/contract-ts";
import { AssetPreview } from "./AssetPreview";
import { LinkedFilesPanel } from "./LinkedFilesPanel";
import type { AssetSource } from "../data/sources";

let root: Root | null = null;
let host: HTMLDivElement | null = null;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  if (root) {
    act(() => root?.unmount());
    root = null;
  }
  host?.remove();
  host = null;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("文件入口融合 DOM 路径", () => {
  it("AssetPreview 能通过 folder /file URL 加载文本正文", async () => {
    const fileUrl = "/api/v1/sessions/s1/folder-sources/fld/file?path=notes.md&maxBytes=1048576";
    vi.stubGlobal("fetch", vi.fn(async () => new Response("真实 folder 文本", {
      status: 200,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    })));

    await render(
      <AssetPreview
        source={assetSource({
          id: "folder:fld:notes.md",
          tag: "yuque",
          name: "notes.md",
          mimeType: "text/markdown; charset=utf-8",
          preview: { kind: "url", url: fileUrl, strictTextContentType: true },
        })}
        sessionId="s1"
        onClose={() => undefined}
      />,
    );
    await flushMicrotasks();

    expect(host?.textContent).toContain("真实 folder 文本");
    expect(vi.mocked(fetch)).toHaveBeenCalledWith(fileUrl);
  });

  it("LinkedFilesPanel 不渲染预览按钮，点不支持类型走 toast 而不触发预览", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      entries: [
        { name: "notes.md", kind: "file", childCount: null, byteLen: 64 },
        { name: "archive.zip", kind: "file", childCount: null, byteLen: 128 },
      ],
      truncated: false,
    }), { status: 200, headers: { "Content-Type": "application/json" } })));
    const onPreviewFolderFile = vi.fn();
    const onToast = vi.fn();

    await render(
      <LinkedFilesPanel
        materialRows={[]}
        folderSource={mockFolderSource}
        onReference={vi.fn()}
        onPreviewFolderFile={onPreviewFolderFile}
        onToast={onToast}
        onAttachFolder={vi.fn()}
        onDetachFolder={vi.fn()}
      />,
    );
    click(linkedFilesBar());
    await clickAsync(folderRoot());

    const notesRow = rowByText("notes.md");
    const zipRow = rowByText("archive.zip");
    expect(queryButtonByText(notesRow, "预览")).toBeNull();
    expect(queryButtonByText(zipRow, "预览")).toBeNull();
    expect(buttonByText(zipRow, "引用")).not.toBeNull();

    click(notesRow);
    expect(onPreviewFolderFile).toHaveBeenCalledWith(expect.objectContaining({
      name: "notes.md",
      preview: expect.objectContaining({
        url: expect.stringContaining("/api/v1/sessions/s1/folder-sources/fld/file?"),
      }),
    }));

    click(zipRow);
    expect(onPreviewFolderFile).toHaveBeenCalledTimes(1);
    expect(onToast).toHaveBeenCalledWith("该文件不支持预览");
  });
});

async function render(node: ReactNode): Promise<void> {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(node);
  });
  await flushMicrotasks();
}

async function flushMicrotasks(times = 4): Promise<void> {
  await act(async () => {
    for (let i = 0; i < times; i += 1) await Promise.resolve();
  });
}

function click(el: HTMLElement): void {
  act(() => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

async function clickAsync(el: HTMLElement): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await flushMicrotasks();
}

function linkedFilesBar(): HTMLElement {
  const bar = host?.querySelector<HTMLElement>('[data-wf="LinkedFilesBar"]');
  if (!bar) throw new Error("LinkedFilesBar not found");
  return bar;
}

function folderRoot(): HTMLElement {
  const row = host?.querySelector<HTMLElement>('[data-wf="LinkedFolderRootRow"]');
  if (!row) throw new Error("LinkedFolderRootRow not found");
  return row;
}

function rowByText(text: string): HTMLElement {
  const row = Array.from(host?.querySelectorAll<HTMLElement>(".lf-row") ?? []).find((item) =>
    item.textContent?.includes(text),
  );
  if (!row) throw new Error(`row not found: ${text}`);
  return row;
}

function buttonByText(rootEl: ParentNode, text: string): HTMLButtonElement {
  const button = queryButtonByText(rootEl, text);
  if (!button) throw new Error(`button not found: ${text}`);
  return button;
}

function queryButtonByText(rootEl: ParentNode, text: string): HTMLButtonElement | null {
  return Array.from(rootEl.querySelectorAll<HTMLButtonElement>("button")).find((item) =>
    item.textContent?.includes(text),
  ) ?? null;
}

function assetSource(overrides: Partial<AssetSource> = {}): AssetSource {
  return {
    id: "mat-1",
    tag: "yuque",
    name: "材料.txt",
    meta: "文本",
    abstract: "",
    bodyText: "",
    ...overrides,
  };
}

const mockFolderSource: FolderSource = {
  id: "fld",
  sessionId: "s1",
  provider: "desktop-local",
  name: "客户资料",
  pathLabel: "~/Documents/客户资料",
  mountName: "source_test",
  mountPath: "/sources/source_test",
  readOnly: true,
  fileCount: 2,
  fileCountCapped: false,
  status: "connected",
  error: null,
  createdAt: "2026-07-04T00:00:00.000Z",
  updatedAt: "2026-07-04T00:00:00.000Z",
};
