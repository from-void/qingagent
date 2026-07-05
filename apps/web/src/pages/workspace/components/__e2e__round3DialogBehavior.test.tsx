// @vitest-environment jsdom
/**
 * Round 3 评测探针 — dialog 行为边界：disconnectConfirm Escape/Overlay 关闭对称性
 * 文件位置：apps/web/src/pages/workspace/components/__e2e__round3DialogBehavior.test.tsx
 * 跑法：cd apps/web && npx vitest run src/pages/workspace/components/__e2e__round3DialogBehavior.test.tsx
 */
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FolderSource } from "@qingagent/contract-ts";
import { resources } from "../../../system/resources";
import { ChatInput } from "./ChatInput";

let root: Root | null = null;
let host: HTMLDivElement | null = null;

const baseFolderSource: FolderSource = {
  id: "fld_test",
  sessionId: "s1",
  provider: "desktop-local",
  name: "客户资料",
  pathLabel: "~/Documents/客户资料",
  mountName: "source_test",
  mountPath: "/sources/source_test",
  readOnly: true,
  fileCount: 14,
  fileCountCapped: false,
  status: "connected",
  error: null,
  createdAt: "2026-06-18T00:00:00.000Z",
  updatedAt: "2026-06-18T00:00:00.000Z",
};

beforeEach(() => {
  resources.reset();
  window.localStorage.clear();
  vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => undefined)));
});

afterEach(() => {
  if (root) { act(() => root?.unmount()); root = null; }
  host?.remove(); host = null;
  resources.reset();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function renderChatInput(element: ReactNode): Promise<void> {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => { root?.render(element); });
}

function getFileButton(): HTMLButtonElement {
  const btn = host?.querySelector<HTMLButtonElement>('[data-wf="WsFileBtn"]');
  if (!btn) throw new Error("file button not found");
  return btn;
}

function getAttachFolderRow(): HTMLButtonElement {
  const btn = host?.querySelector<HTMLButtonElement>('[data-wf="WsFileMenuAttachFolder"]');
  if (!btn) throw new Error("attach folder row not found");
  return btn;
}

function getFolderStatusRow(): HTMLElement {
  const row = host?.querySelector<HTMLElement>('[data-wf="WsFileMenuFolderStatus"]');
  if (!row) throw new Error("folder status row not found");
  return row;
}

function getMenuDisconnectButton(): HTMLButtonElement {
  const btn = host?.querySelector<HTMLButtonElement>('[data-wf="WsFileMenuDisconnect"]');
  if (!btn) throw new Error("menu disconnect button not found");
  return btn;
}

function clickEl(el: HTMLElement): void {
  act(() => { el.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
}

function openFileMenu(): void {
  clickEl(getFileButton());
}

function openDisconnectDialog(): void {
  openFileMenu();
  clickEl(getMenuDisconnectButton());
}

// ────────────────────────────────────────────────────────────
// D1: disconnectConfirm 的 Escape 和 overlay 行为
// ────────────────────────────────────────────────────────────
describe("D1: disconnectConfirm dialog 的关闭行为", () => {
  it("disconnectConfirm 弹框：按 Escape 键取消关闭且不触发断开", async () => {
    const onDetachFolder = vi.fn(async () => undefined);
    await renderChatInput(
      <ChatInput
        folderSource={baseFolderSource}
        folderCapability={{ enabled: true, reason: null }}
        onAttachFolder={vi.fn(async () => undefined)}
        onDetachFolder={onDetachFolder}
        placeholder="输入"
        onSubmit={() => undefined}
      />,
    );

    openDisconnectDialog();
    expect(host?.querySelector('[data-wf="WsFolderDisconnectOverlay"]')).not.toBeNull();

    // 按 Escape
    act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });

    const overlayAfterEscape = host?.querySelector('[data-wf="WsFolderDisconnectOverlay"]');
    console.log(`[PROBE] disconnectConfirm Escape 后 overlay: ${overlayAfterEscape ? "仍存在" : "已关闭"}`);
    expect(overlayAfterEscape).toBeNull();
    expect(onDetachFolder).not.toHaveBeenCalled();
  });

  it("disconnectConfirm 弹框：点击 overlay 背景不关闭（防误操作）", async () => {
    await renderChatInput(
      <ChatInput
        folderSource={baseFolderSource}
        folderCapability={{ enabled: true, reason: null }}
        onAttachFolder={vi.fn(async () => undefined)}
        onDetachFolder={vi.fn(async () => undefined)}
        placeholder="输入"
        onSubmit={() => undefined}
      />,
    );

    openDisconnectDialog();
    const overlay = host?.querySelector<HTMLElement>('[data-wf="WsFolderDisconnectOverlay"]');
    expect(overlay).not.toBeNull();

    // 点击 overlay 背景
    act(() => {
      overlay!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    // 不应关闭
    expect(host?.querySelector('[data-wf="WsFolderDisconnectOverlay"]')).not.toBeNull();
  });

  it("disconnectConfirm 弹框：显式取消按钮关闭，无 onDetachFolder 调用", async () => {
    const onDetachFolder = vi.fn(async () => undefined);
    await renderChatInput(
      <ChatInput
        folderSource={baseFolderSource}
        folderCapability={{ enabled: true, reason: null }}
        onAttachFolder={vi.fn(async () => undefined)}
        onDetachFolder={onDetachFolder}
        placeholder="输入"
        onSubmit={() => undefined}
      />,
    );

    openDisconnectDialog();
    const cancelBtn = Array.from(
      host?.querySelectorAll<HTMLButtonElement>(".ws-folder-modal-secondary") ?? [],
    ).find((btn) => btn.textContent?.includes("取消"));
    expect(cancelBtn).not.toBeNull();
    clickEl(cancelBtn!);

    expect(host?.querySelector('[data-wf="WsFolderDisconnectOverlay"]')).toBeNull();
    expect(onDetachFolder).not.toHaveBeenCalled();
  });
});

// ────────────────────────────────────────────────────────────
// D2: intro dialog 与 disconnectConfirm dialog 的交互隔离
// ────────────────────────────────────────────────────────────
describe("D2: 两个 dialog 的互斥性", () => {
  it("intro dialog 打开时不存在 disconnectConfirm", async () => {
    window.localStorage.removeItem("qingagent:folder-source-intro-dismissed");
    await renderChatInput(
      <ChatInput
        folderSource={null}
        folderCapability={{ enabled: true, reason: null }}
        onAttachFolder={vi.fn(async () => undefined)}
        onDetachFolder={vi.fn(async () => undefined)}
        placeholder="输入"
        onSubmit={() => undefined}
      />,
    );

    openFileMenu();
    clickEl(getAttachFolderRow());

    expect(host?.querySelector('[data-wf="WsFolderIntroOverlay"]')).not.toBeNull();
    expect(host?.querySelector('[data-wf="WsFolderDisconnectOverlay"]')).toBeNull();
  });

  it("disconnectConfirm dialog 打开时不存在 intro overlay", async () => {
    await renderChatInput(
      <ChatInput
        folderSource={baseFolderSource}
        folderCapability={{ enabled: true, reason: null }}
        onAttachFolder={vi.fn(async () => undefined)}
        onDetachFolder={vi.fn(async () => undefined)}
        placeholder="输入"
        onSubmit={() => undefined}
      />,
    );

    openDisconnectDialog();

    expect(host?.querySelector('[data-wf="WsFolderDisconnectOverlay"]')).not.toBeNull();
    expect(host?.querySelector('[data-wf="WsFolderIntroOverlay"]')).toBeNull();
  });
});

// ────────────────────────────────────────────────────────────
// D3: folderButtonDisabled 的计算逻辑验证
// ────────────────────────────────────────────────────────────
describe("D3: folderButtonDisabled 边界条件", () => {
  it("folderCapability.enabled=false 时连接文件夹菜单行 disabled（unsupported）", async () => {
    await renderChatInput(
      <ChatInput
        folderSource={null}
        folderCapability={{ enabled: false, reason: "网页版暂未开放" }}
        onAttachFolder={vi.fn(async () => undefined)}
        onDetachFolder={vi.fn(async () => undefined)}
        placeholder="输入"
        onSubmit={() => undefined}
      />,
    );
    openFileMenu();
    expect(getAttachFolderRow().disabled).toBe(true);
    expect(getAttachFolderRow().textContent).toContain("网页版暂未开放");
  });

  it("disabled=true（ChatInput 整体禁用）时文件按钮 disabled", async () => {
    await renderChatInput(
      <ChatInput
        disabled={true}
        folderSource={null}
        folderCapability={{ enabled: true, reason: null }}
        onAttachFolder={vi.fn(async () => undefined)}
        onDetachFolder={vi.fn(async () => undefined)}
        placeholder="输入"
        onSubmit={() => undefined}
      />,
    );
    expect(getFileButton().disabled).toBe(true);
  });

  it("disabled=true 时文件按钮点击无效（不打开引导框）", async () => {
    window.localStorage.removeItem("qingagent:folder-source-intro-dismissed");
    await renderChatInput(
      <ChatInput
        disabled={true}
        folderSource={null}
        folderCapability={{ enabled: true, reason: null }}
        onAttachFolder={vi.fn(async () => undefined)}
        onDetachFolder={vi.fn(async () => undefined)}
        placeholder="输入"
        onSubmit={() => undefined}
      />,
    );

    act(() => {
      getFileButton().dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    // disabled=true 时不应打开 intro
    expect(host?.querySelector('[data-wf="WsFolderIntroOverlay"]')).toBeNull();
  });
});

// ────────────────────────────────────────────────────────────
// D4: fileCount 格式化的边界条件
// ────────────────────────────────────────────────────────────
describe("D4: fileCount 格式化", () => {
  it("fileCount=null 不再显示在工具栏菜单状态行", async () => {
    await renderChatInput(
      <ChatInput
        folderSource={{ ...baseFolderSource, fileCount: null }}
        folderCapability={{ enabled: true, reason: null }}
        onAttachFolder={vi.fn(async () => undefined)}
        onDetachFolder={vi.fn(async () => undefined)}
        placeholder="输入"
        onSubmit={() => undefined}
      />,
    );
    openFileMenu();
    expect(getFolderStatusRow().textContent).not.toContain("文件数暂未统计");
  });

  it("fileCountCapped=true 不再显示在工具栏菜单状态行", async () => {
    await renderChatInput(
      <ChatInput
        folderSource={{ ...baseFolderSource, fileCount: 100, fileCountCapped: true }}
        folderCapability={{ enabled: true, reason: null }}
        onAttachFolder={vi.fn(async () => undefined)}
        onDetachFolder={vi.fn(async () => undefined)}
        placeholder="输入"
        onSubmit={() => undefined}
      />,
    );
    openFileMenu();
    expect(getFolderStatusRow().textContent).not.toContain("100+");
  });

  it("fileCount=0 不再显示在工具栏菜单状态行", async () => {
    await renderChatInput(
      <ChatInput
        folderSource={{ ...baseFolderSource, fileCount: 0 }}
        folderCapability={{ enabled: true, reason: null }}
        onAttachFolder={vi.fn(async () => undefined)}
        onDetachFolder={vi.fn(async () => undefined)}
        placeholder="输入"
        onSubmit={() => undefined}
      />,
    );
    openFileMenu();
    expect(getFolderStatusRow().textContent).not.toContain("0 个文件");
  });

  it("pathLabel=null 时工具栏菜单仍只展示文件夹名", async () => {
    await renderChatInput(
      <ChatInput
        folderSource={{ ...baseFolderSource, pathLabel: null }}
        folderCapability={{ enabled: true, reason: null }}
        onAttachFolder={vi.fn(async () => undefined)}
        onDetachFolder={vi.fn(async () => undefined)}
        placeholder="输入"
        onSubmit={() => undefined}
      />,
    );
    openFileMenu();
    expect(getFolderStatusRow().textContent).toContain("客户资料");
    expect(getFolderStatusRow().textContent).not.toContain("/sources/source_test");
  });
});
