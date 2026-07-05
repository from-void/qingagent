// @vitest-environment jsdom
/**
 * Round 3 评测探针 — detach 进行中取消 dialog 的副作用 bug 验证
 * 文件位置：apps/web/src/pages/workspace/components/__e2e__round3DetachBug.test.tsx
 * 跑法：cd apps/web && npx vitest run src/pages/workspace/components/__e2e__round3DetachBug.test.tsx
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
// B1: detach 进行中取消 dialog → folderActionPending 仍为 detach
//     → 此后文件菜单断开入口锁死直到 detach 完成
// ────────────────────────────────────────────────────────────
describe("B1: detach 进行中取消 dialog 后的状态", () => {
  it("detach 进行中时取消按钮禁用，dialog 不会被取消关闭", async () => {
    // 构造一个永远不完成的 detach
    let resolveDetach: (() => void) | null = null;
    const hangingDetach = vi.fn(async () => {
      await new Promise<void>((res) => { resolveDetach = res; });
    });

    await renderChatInput(
      <ChatInput
        folderSource={baseFolderSource}
        folderCapability={{ enabled: true, reason: null }}
        onAttachFolder={vi.fn(async () => undefined)}
        onDetachFolder={hangingDetach}
        placeholder="输入"
        onSubmit={() => undefined}
      />,
    );

    // 打开断开确认框
    openDisconnectDialog();
    const disconnectBtn = host?.querySelector<HTMLButtonElement>(".ws-folder-modal-danger");
    expect(disconnectBtn).not.toBeNull();

    // 点击断开（开始 detach）
    act(() => { disconnectBtn!.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    await act(async () => {});

    // detach 进行中：「断开连接」按钮 disabled（正确）
    expect(host?.querySelector<HTMLButtonElement>(".ws-folder-modal-danger")?.disabled).toBe(true);

    const cancelBtn = Array.from(
      host?.querySelectorAll<HTMLButtonElement>(".ws-folder-modal-secondary") ?? [],
    ).find((btn) => btn.textContent?.includes("取消"));
    expect(cancelBtn).not.toBeNull();
    expect(cancelBtn!.disabled).toBe(true);
    act(() => { cancelBtn!.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    await act(async () => {});
    expect(host?.querySelector('[data-wf="WsFolderDisconnectOverlay"]')).not.toBeNull();

    // 清理：完成 detach
    act(() => { if (resolveDetach) resolveDetach(); });
    await act(async () => {});
  });

  it("detach 失败后 dialog 仍开着（可重试），folderActionPending 已重置", async () => {
    const failDetach = vi.fn(async () => {
      throw new Error("network error");
    });

    await renderChatInput(
      <ChatInput
        folderSource={baseFolderSource}
        folderCapability={{ enabled: true, reason: null }}
        onAttachFolder={vi.fn(async () => undefined)}
        onDetachFolder={failDetach}
        placeholder="输入"
        onSubmit={() => undefined}
      />,
    );

    // 打开断开确认框
    openDisconnectDialog();
    const disconnectBtn = host?.querySelector<HTMLButtonElement>(".ws-folder-modal-danger");
    expect(disconnectBtn).not.toBeNull();

    // 点击断开（触发失败的 detach）
    await act(async () => {
      disconnectBtn!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    // detach 失败后：
    // 1. dialog 应该仍然开着（允许重试）
    const dialogStillOpen = host?.querySelector('[data-wf="WsFolderDisconnectOverlay"]');
    expect(dialogStillOpen).not.toBeNull();

    // 2. 断开按钮应该不再 disabled（folderActionPending 重置为 null）
    const disconnectBtnAfter = host?.querySelector<HTMLButtonElement>(".ws-folder-modal-danger");
    expect(disconnectBtnAfter?.disabled).toBe(false);

    // 3. 文件按钮不被旧 folderActionPending 壳锁死
    expect(getFileButton().disabled).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────
// B2: detach 成功后 dialog 关闭时序（正常路径验证）
// ────────────────────────────────────────────────────────────
describe("B2: detach 成功路径", () => {
  it("detach 成功后 dialog 关闭，folderActionPending 重置", async () => {
    const successDetach = vi.fn(async () => { /* 立即成功 */ });

    await renderChatInput(
      <ChatInput
        folderSource={baseFolderSource}
        folderCapability={{ enabled: true, reason: null }}
        onAttachFolder={vi.fn(async () => undefined)}
        onDetachFolder={successDetach}
        placeholder="输入"
        onSubmit={() => undefined}
      />,
    );

    // 打开断开确认框
    openDisconnectDialog();
    const disconnectBtn = host?.querySelector<HTMLButtonElement>(".ws-folder-modal-danger");
    expect(disconnectBtn).not.toBeNull();

    // 确认断开
    await act(async () => {
      disconnectBtn!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    // detach 成功后：
    // 1. dialog 关闭
    expect(host?.querySelector('[data-wf="WsFolderDisconnectOverlay"]')).toBeNull();

    // 2. detach 被调用
    expect(successDetach).toHaveBeenCalledWith("fld_test");

    // 3. 文件按钮不被旧 folderActionPending 壳锁死（外部 folderSource prop 仍驱动连接态）
    // 注意：此时 folderSource prop 仍为 baseFolderSource（父组件尚未更新）
    // 文件按钮 not-disabled（folderActionPending=null 了）
    // 是否展示连接状态仍由父组件 folderSource prop 驱动
    // 这是期望行为——真实状态由父组件 dispatch 来驱动
  });
});

// ────────────────────────────────────────────────────────────
// B3: 引导框状态泄漏 — 验证取消时 folderIntroDismissChecked 的重置
// ────────────────────────────────────────────────────────────
describe("B3: 引导框 dismiss checkbox 状态在取消后重置", () => {
  it("多次打开/勾选/取消后 checkbox 始终重置为 false", async () => {
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

    // 3 轮：每次打开→勾选→取消，验证下次打开 checkbox 是未勾选的
    for (let round = 1; round <= 3; round++) {
      // 打开引导框
      openFileMenu();
      clickEl(getAttachFolderRow());

      const checkbox = host?.querySelector<HTMLInputElement>(
        '[data-wf="WsFolderIntroOverlay"] input[type="checkbox"]',
      );
      expect(checkbox).not.toBeNull();
      expect(checkbox!.checked).toBe(false);  // 每次打开应该是未勾选

      // 勾选
      act(() => { checkbox!.click(); });
      expect(checkbox!.checked).toBe(true);

      // 取消
      const cancelBtn = Array.from(
        host?.querySelectorAll<HTMLButtonElement>(".ws-folder-modal-secondary") ?? [],
      ).find((btn) => btn.textContent?.includes("取消"));
      act(() => { cancelBtn!.dispatchEvent(new MouseEvent("click", { bubbles: true })); });

      // localStorage 未写入
      expect(window.localStorage.getItem("qingagent:folder-source-intro-dismissed")).toBeNull();
    }
  });
});
