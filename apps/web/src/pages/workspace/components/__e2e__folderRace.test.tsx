// @vitest-environment jsdom
/**
 * Round 2 评测探针 — 文件菜单连接行并发/竞态测试
 * 文件位置：apps/web/src/pages/workspace/components/__e2e__folderRace.test.tsx
 * 跑法：cd apps/web && npx vitest run src/pages/workspace/components/__e2e__folderRace.test.tsx
 */
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resources } from "../../../system/resources";
import { ChatInput } from "./ChatInput";

const FOLDER_INTRO_STORAGE_KEY = "qingagent:folder-source-intro-dismissed";

let root: Root | null = null;
let host: HTMLDivElement | null = null;

beforeEach(() => {
  resources.reset();
  window.localStorage.clear();
  window.localStorage.setItem(FOLDER_INTRO_STORAGE_KEY, "1"); // 跳过引导框
  vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => undefined)));
});

afterEach(() => {
  if (root) {
    act(() => root?.unmount());
    root = null;
  }
  host?.remove();
  host = null;
  resources.reset();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function renderChatInput(element: ReactNode): Promise<void> {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(element);
  });
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

function clickSync(el: HTMLElement): void {
  act(() => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

describe("文件菜单连接行竞态测试", () => {
  it("【BUG候选】双击：同步点击连接行时不会绕过 attach 防重入", async () => {
    // 文件菜单连接行触发 requestAttach，hook 内的同步 ref guard 应阻止第二次 attach。

    // 构造一个慢速 onAttachFolder，验证双击
    let attachCallCount = 0;
    let resolve!: () => void;
    const slowAttach = vi.fn(async () => {
      attachCallCount++;
      await new Promise<void>((res) => { resolve = res; });
    });

    await renderChatInput(
      <ChatInput
        folderSource={null}
        folderCapability={{ enabled: true, reason: null }}
        onAttachFolder={slowAttach}
        onDetachFolder={vi.fn(async () => undefined)}
        placeholder="输入"
        onSubmit={() => undefined}
      />,
    );

    clickSync(getFileButton());

    // 在同一个 act 内立即两次点击菜单行，模拟快速双击。
    const row = getAttachFolderRow();
    act(() => {
      row.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      row.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    // 等待 React 更新
    await act(async () => { /* flush */ });

    const callCount = slowAttach.mock.calls.length;
    if (callCount > 1) {
      console.warn(`[BUG CONFIRMED] 双击绕过 folderActionPending guard: onAttachFolder 被调用了 ${callCount} 次`);
    } else {
      console.log(`[PASS] 双击未绕过 guard: onAttachFolder 只被调用了 ${callCount} 次`);
    }

    // 记录实际行为
    expect(callCount).toBe(1);

    // 清理
    act(() => { if (resolve) resolve(); });
  });

  it("folderActionPending=attach 时再次点击停止等待，不重复 attach", async () => {
    let resolve!: () => void;
    let observedSignal: AbortSignal | undefined;
    const slowAttach = vi.fn(async (signal?: AbortSignal) => {
      observedSignal = signal;
      await new Promise<void>((res, reject) => {
        resolve = res;
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    });

    await renderChatInput(
      <ChatInput
        folderSource={null}
        folderCapability={{ enabled: true, reason: null }}
        onAttachFolder={slowAttach}
        onDetachFolder={vi.fn(async () => undefined)}
        placeholder="输入"
        onSubmit={() => undefined}
      />,
    );

    clickSync(getFileButton());

    // 第一次点击连接行，等 React 更新
    await act(async () => {
      getAttachFolderRow().dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    // React 已更新，folderActionPending=attach。菜单关闭后再次打开，连接行可停止等待。
    clickSync(getFileButton());
    expect(getAttachFolderRow().disabled).toBe(false);
    expect(getAttachFolderRow().textContent).toContain("停止等待");

    // 再次点击停止等待。
    clickSync(getAttachFolderRow());
    await act(async () => {});

    // 确认只调用了一次，入口已恢复。
    expect(slowAttach).toHaveBeenCalledTimes(1);
    expect(observedSignal?.aborted).toBe(true);
    clickSync(getFileButton());
    expect(getAttachFolderRow().textContent).toContain("连接本地文件夹");

    // 清理
    act(() => { if (resolve) resolve(); });
  });
});
