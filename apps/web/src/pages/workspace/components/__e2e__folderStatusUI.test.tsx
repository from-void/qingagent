// @vitest-environment jsdom
/**
 * Round 2 评测探针 — 状态/可达性 bug 精确验证
 * 文件位置：apps/web/src/pages/workspace/components/__e2e__folderStatusUI.test.tsx
 * 跑法：cd apps/web && npx vitest run src/pages/workspace/components/__e2e__folderStatusUI.test.tsx
 */
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FolderSource, FolderSourceStatus } from "@qingagent/contract-ts";
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

function getIntroOverlay(): HTMLElement | null {
  return host?.querySelector<HTMLElement>('[data-wf="WsFolderIntroOverlay"]') ?? null;
}

function getFileButton(): HTMLButtonElement {
  const btn = host?.querySelector<HTMLButtonElement>('[data-wf="WsFileBtn"]');
  if (!btn) throw new Error("file button not found");
  return btn;
}

function getAttachFolderRow(): HTMLButtonElement {
  const row = host?.querySelector<HTMLButtonElement>('[data-wf="WsFileMenuAttachFolder"]');
  if (!row) throw new Error("attach folder row not found");
  return row;
}

function getFolderStatusRow(): HTMLElement {
  const row = host?.querySelector<HTMLElement>('[data-wf="WsFileMenuFolderStatus"]');
  if (!row) throw new Error("folder status row not found");
  return row;
}

function clickElement(el: HTMLElement): void {
  act(() => { el.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
}

function openFileMenu(): void {
  clickElement(getFileButton());
}

// ────────────────────────────────────────────────────────────
// 回归验证 1：引导框有关闭路径
// ────────────────────────────────────────────────────────────
describe("引导框关闭路径", () => {
  it("引导框内有取消按钮，关闭时不触发连接", async () => {
    const onAttachFolder = vi.fn(async () => undefined);
    await renderChatInput(
      <ChatInput
        folderSource={null}
        folderCapability={{ enabled: true, reason: null }}
        onAttachFolder={onAttachFolder}
        onDetachFolder={vi.fn(async () => undefined)}
        placeholder="输入"
        onSubmit={() => undefined}
      />,
    );
    openFileMenu();
    clickElement(getAttachFolderRow());
    const overlay = getIntroOverlay();
    expect(overlay).not.toBeNull();

    const allButtons = Array.from(overlay!.querySelectorAll<HTMLButtonElement>("button"));
    const cancelBtn = allButtons.find((btn) => btn.textContent?.includes("取消"));
    expect(cancelBtn).toBeDefined();
    clickElement(cancelBtn!);
    expect(getIntroOverlay()).toBeNull();
    expect(onAttachFolder).not.toHaveBeenCalled();
    expect(window.localStorage.getItem("qingagent:folder-source-intro-dismissed")).toBeNull();
  });

  it("按下 Escape 键可关闭引导框", async () => {
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
    clickElement(getAttachFolderRow());
    expect(getIntroOverlay()).not.toBeNull();

    act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });

    expect(getIntroOverlay()).toBeNull();
  });
});

// ────────────────────────────────────────────────────────────
// 回归验证 2：非 connected 状态的 UI 表示
// ────────────────────────────────────────────────────────────
describe("folderSource.status 非 connected 时菜单状态行显示差异化状态", () => {
  const expected: Record<FolderSourceStatus, string> = {
    connected: "已连接为资料库",
    offline: "连接已离线",
    missing: "文件夹找不到",
    permission_required: "需要重新授权",
    error: "连接异常",
  };
  const nonConnectedStatuses: FolderSourceStatus[] = ["offline", "missing", "permission_required", "error"];

  for (const status of nonConnectedStatuses) {
    it(`status=${status} 时菜单状态行显示对应状态`, async () => {
      await renderChatInput(
        <ChatInput
          folderSource={{ ...baseFolderSource, status }}
          folderCapability={{ enabled: true, reason: null }}
          onAttachFolder={vi.fn(async () => undefined)}
          onDetachFolder={vi.fn(async () => undefined)}
          placeholder="输入"
          onSubmit={() => undefined}
        />,
      );
      openFileMenu();
      const row = getFolderStatusRow();
      expect(row.textContent).toContain(expected[status]);
      expect(row.textContent).not.toContain("已连接 · 点击查看与管理");
    });
  }

  it("status=error 且有 error 字段时，菜单状态行展示错误信息", async () => {
    await renderChatInput(
      <ChatInput
        folderSource={{ ...baseFolderSource, status: "error", error: "EACCES: permission denied" }}
        folderCapability={{ enabled: true, reason: null }}
        onAttachFolder={vi.fn(async () => undefined)}
        onDetachFolder={vi.fn(async () => undefined)}
        placeholder="输入"
        onSubmit={() => undefined}
      />,
    );
    openFileMenu();
    const row = getFolderStatusRow();
    expect(row.textContent).toContain("EACCES");
  });
});

// ────────────────────────────────────────────────────────────
// 确认通过：断开确认框的 overlay 背景点击不关闭
// ────────────────────────────────────────────────────────────
describe("弹框 overlay 背景点击行为", () => {
  it("引导框：点击 overlay 背景（非模态内容区域）关闭弹框", async () => {
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
    clickElement(getAttachFolderRow());
    const overlay = getIntroOverlay();
    expect(overlay).not.toBeNull();

    clickElement(overlay!);

    expect(getIntroOverlay()).toBeNull();
  });
});

// ────────────────────────────────────────────────────────────
// 确认通过：folderSource 的 is-connected CSS 类
// ────────────────────────────────────────────────────────────
describe("旧文件夹按钮壳退役", () => {
  it("folderSource 存在时不再渲染 ws-folder-wrap，改由文件菜单状态行承载", async () => {
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
    expect(host?.querySelector(".ws-folder-wrap")).toBeNull();
    openFileMenu();
    expect(getFolderStatusRow().textContent).toContain("客户资料");
  });

  it("folderSource=null 时菜单渲染连接文件夹动作行", async () => {
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
    expect(host?.querySelector(".ws-folder-wrap")).toBeNull();
    openFileMenu();
    expect(getAttachFolderRow().textContent).toContain("连接本地文件夹");
  });

  it("unsupported 时连接文件夹动作行置灰并展示 reason", async () => {
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
    expect(getAttachFolderRow().classList.contains("is-disabled")).toBe(true);
    expect(getAttachFolderRow().textContent).toContain("网页版暂未开放");
  });
});
