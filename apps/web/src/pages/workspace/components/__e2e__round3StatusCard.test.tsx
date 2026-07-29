// @vitest-environment jsdom
/**
 * Round 3 评测探针 — status 感知文件菜单状态行 + 非 connected 态行为 + folderActionPending 叠加
 * 文件位置：apps/web/src/pages/workspace/components/__e2e__round3StatusCard.test.tsx
 * 跑法：cd apps/web && npx vitest run src/pages/workspace/components/__e2e__round3StatusCard.test.tsx
 */
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FolderSource, FolderSourceStatus } from "@qingagent/contract-ts";
import { resources } from "../../../system/resources";
import { ChatInput } from "./ChatInput";

const FOLDER_INTRO_STORAGE_KEY = "qingagent:folder-source-intro-dismissed";

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
  window.localStorage.setItem(FOLDER_INTRO_STORAGE_KEY, "1");
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
  const row = host?.querySelector<HTMLButtonElement>('[data-wf="WsFileMenuAttachFolder"]');
  if (!row) throw new Error("attach folder row not found");
  return row;
}

function getFolderStatusRow(): HTMLElement {
  const row = host?.querySelector<HTMLElement>('[data-wf="WsFileMenuFolderStatus"]');
  if (!row) throw new Error("folder status row not found");
  return row;
}

function getMenuDisconnectButton(): HTMLButtonElement {
  const button = host?.querySelector<HTMLButtonElement>('[data-wf="WsFileMenuDisconnect"]');
  if (!button) throw new Error("menu disconnect button not found");
  return button;
}

function clickEl(el: HTMLElement): void {
  act(() => { el.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
}

async function clickElAsync(el: HTMLElement): Promise<void> {
  await act(async () => { el.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
}

function openFileMenu(): void {
  clickEl(getFileButton());
}

function openDisconnectDialog(): void {
  openFileMenu();
  clickEl(getMenuDisconnectButton());
}

// ────────────────────────────────────────────────────────────
// S1: 所有状态菜单行文案精确验证
// ────────────────────────────────────────────────────────────
describe("S1: 所有 FolderSourceStatus 菜单行文案精确验证", () => {
  type StatusSpec = {
    status: FolderSourceStatus;
    expectedLabel: string;
  };

  const specs: StatusSpec[] = [
    {
      status: "connected",
      expectedLabel: "已连接 · 点击查看与管理",
    },
    {
      status: "offline",
      expectedLabel: "连接已离线",
    },
    {
      status: "missing",
      expectedLabel: "文件夹找不到",
    },
    {
      status: "permission_required",
      expectedLabel: "需要重新授权",
    },
    {
      status: "error",
      expectedLabel: "连接异常",
    },
  ];

  for (const spec of specs) {
    it(`status=${spec.status}: label="${spec.expectedLabel}"`, async () => {
      await renderChatInput(
        <ChatInput
          folderSource={{ ...baseFolderSource, status: spec.status }}
          folderCapability={{ enabled: true, reason: null }}
          onAttachFolder={vi.fn(async () => undefined)}
          onDetachFolder={vi.fn(async () => undefined)}
          placeholder="输入"
          onSubmit={() => undefined}
        />,
      );

      openFileMenu();
      const row = getFolderStatusRow();
      expect(row.textContent).toContain(spec.expectedLabel);
      if (spec.status === "connected") {
        expect(row.querySelector(".qa-file-folder-dot")).not.toBeNull();
        expect(getMenuDisconnectButton().textContent).toContain("断开");
      } else {
        expect(row.querySelector(".qa-file-folder-dot")).toBeNull();
      }
    });
  }

  it("status=connected 时 hint 显示在 popover 内，不含非 connected 字样", async () => {
    await renderChatInput(
      <ChatInput
        folderSource={{ ...baseFolderSource, status: "connected" }}
        folderCapability={{ enabled: true, reason: null }}
        onAttachFolder={vi.fn(async () => undefined)}
        onDetachFolder={vi.fn(async () => undefined)}
        placeholder="输入"
        onSubmit={() => undefined}
      />,
    );
    openFileMenu();
    const row = getFolderStatusRow();
    expect(row.textContent).not.toContain("文件夹找不到");
    expect(row.textContent).not.toContain("连接已离线");
    expect(row.textContent).not.toContain("需要重新授权");
    expect(row.textContent).not.toContain("连接异常");
  });
});

// ────────────────────────────────────────────────────────────
// S2: 非 connected 态 error 字段的条件渲染
// ────────────────────────────────────────────────────────────
describe("S2: error 字段条件渲染", () => {
  it("error=null 时菜单状态行只展示状态标签", async () => {
    await renderChatInput(
      <ChatInput
        folderSource={{ ...baseFolderSource, status: "error", error: null }}
        folderCapability={{ enabled: true, reason: null }}
        onAttachFolder={vi.fn(async () => undefined)}
        onDetachFolder={vi.fn(async () => undefined)}
        placeholder="输入"
        onSubmit={() => undefined}
      />,
    );
    openFileMenu();
    expect(getFolderStatusRow().textContent).toContain("连接异常");
    expect(getFolderStatusRow().textContent).not.toContain("ENOENT");
  });

  it("error 有内容时菜单状态行包含真实错误文本", async () => {
    await renderChatInput(
      <ChatInput
        folderSource={{ ...baseFolderSource, status: "error", error: "ENOENT: no such file or directory" }}
        folderCapability={{ enabled: true, reason: null }}
        onAttachFolder={vi.fn(async () => undefined)}
        onDetachFolder={vi.fn(async () => undefined)}
        placeholder="输入"
        onSubmit={() => undefined}
      />,
    );
    openFileMenu();
    expect(getFolderStatusRow().textContent).toContain("ENOENT");
  });

  it("status=connected 且 error 非 null：菜单仍按 connected 主状态展示", async () => {
    // 这种情况在实际产品中不应该发生，但 UI 层应该能处理
    await renderChatInput(
      <ChatInput
        folderSource={{ ...baseFolderSource, status: "connected", error: "某个告警" }}
        folderCapability={{ enabled: true, reason: null }}
        onAttachFolder={vi.fn(async () => undefined)}
        onDetachFolder={vi.fn(async () => undefined)}
        placeholder="输入"
        onSubmit={() => undefined}
      />,
    );
    openFileMenu();
    const row = getFolderStatusRow();
    expect(row.textContent).toContain("已连接 · 点击查看与管理");
    expect(row.textContent).not.toContain("某个告警");
  });
});

// ────────────────────────────────────────────────────────────
// S3: 非 connected 态下点击菜单断开入口的行为
// ────────────────────────────────────────────────────────────
describe("S3: 非 connected 态下点击菜单断开入口的行为", () => {
  // 任何状态下只要 folderSource != null，点击菜单断开入口应该弹出断开确认
  // 而不是尝试重新 attach（那是错误的行为）
  const nonConnectedStatuses: FolderSourceStatus[] = ["offline", "missing", "permission_required", "error"];

  for (const status of nonConnectedStatuses) {
    it(`status=${status}: 点击菜单断开打开断开确认框，不调 onAttachFolder`, async () => {
      const onAttachFolder = vi.fn(async () => undefined);
      const onDetachFolder = vi.fn(async () => undefined);

      await renderChatInput(
        <ChatInput
          folderSource={{ ...baseFolderSource, status }}
          folderCapability={{ enabled: true, reason: null }}
          onAttachFolder={onAttachFolder}
          onDetachFolder={onDetachFolder}
          placeholder="输入"
          onSubmit={() => undefined}
        />,
      );

      openDisconnectDialog();

      // 期望：打开断开确认框
      const disconnectOverlay = host?.querySelector('[data-wf="WsFolderDisconnectOverlay"]');
      expect(disconnectOverlay).not.toBeNull();

      // 期望：不触发 attach
      expect(onAttachFolder).not.toHaveBeenCalled();
    });
  }

  it("非 connected 态，确认断开后调用 onDetachFolder 并传正确 folderId", async () => {
    const onDetachFolder = vi.fn(async () => undefined);

    await renderChatInput(
      <ChatInput
        folderSource={{ ...baseFolderSource, status: "error", error: "EACCES" }}
        folderCapability={{ enabled: true, reason: null }}
        onAttachFolder={vi.fn(async () => undefined)}
        onDetachFolder={onDetachFolder}
        placeholder="输入"
        onSubmit={() => undefined}
      />,
    );

    openDisconnectDialog();
    const disconnectBtn = host?.querySelector<HTMLButtonElement>(".ws-folder-modal-danger");
    expect(disconnectBtn).not.toBeNull();

    await clickElAsync(disconnectBtn!);
    expect(onDetachFolder).toHaveBeenCalledWith("fld_test");
  });
});

// ────────────────────────────────────────────────────────────
// S4: folderActionPending 与 dialog 叠加态验证
// ────────────────────────────────────────────────────────────
describe("S4: folderActionPending 与 dialog 叠加态", () => {
  it("detach 进行中：断开确认框的「断开连接」按钮禁用", async () => {
    let resolveDetach!: () => void;
    const slowDetach = vi.fn(async () => {
      await new Promise<void>((res) => { resolveDetach = res; });
    });

    await renderChatInput(
      <ChatInput
        folderSource={baseFolderSource}
        folderCapability={{ enabled: true, reason: null }}
        onAttachFolder={vi.fn(async () => undefined)}
        onDetachFolder={slowDetach}
        placeholder="输入"
        onSubmit={() => undefined}
      />,
    );

    // 打开断开确认框
    openDisconnectDialog();
    const disconnectBtn = host?.querySelector<HTMLButtonElement>(".ws-folder-modal-danger");
    expect(disconnectBtn).not.toBeNull();
    expect(disconnectBtn!.disabled).toBe(false);

    // 点击确认断开（开始 detach 操作）
    act(() => { disconnectBtn!.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    // 等待 React 渲染 folderActionPending = "detach"
    await act(async () => {});

    // detach 进行中：按钮应该 disabled
    const disconnectBtnAfter = host?.querySelector<HTMLButtonElement>(".ws-folder-modal-danger");
    expect(disconnectBtnAfter?.disabled).toBe(true);

    // 清理
    act(() => { if (resolveDetach) resolveDetach(); });
  });

  it("attach 进行中：展示忙碌文案并允许停止等待", async () => {
    let resolveAttach!: () => void;
    const slowAttach = vi.fn(async () => {
      await new Promise<void>((res) => { resolveAttach = res; });
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

    // 触发 attach（已勾选跳过引导框）
    openFileMenu();
    clickEl(getAttachFolderRow());
    await act(async () => {});

    openFileMenu();
    const row = getAttachFolderRow();
    expect(row.disabled).toBe(false);
    expect(row.textContent).toContain("正在连接文件夹");
    expect(row.textContent).toContain("停止等待");

    clickEl(row);
    await act(async () => {});
    openFileMenu();
    expect(getAttachFolderRow().textContent).toContain("连接本地文件夹");
    act(() => { if (resolveAttach) resolveAttach(); });
  });

  it("detach 进行中时菜单断开按钮也应该 disabled", async () => {
    let resolveDetach!: () => void;
    const slowDetach = vi.fn(async () => {
      await new Promise<void>((res) => { resolveDetach = res; });
    });

    await renderChatInput(
      <ChatInput
        folderSource={baseFolderSource}
        folderCapability={{ enabled: true, reason: null }}
        onAttachFolder={vi.fn(async () => undefined)}
        onDetachFolder={slowDetach}
        placeholder="输入"
        onSubmit={() => undefined}
      />,
    );

    // 打开断开确认框并确认
    openDisconnectDialog();
    act(() => {
      host?.querySelector<HTMLButtonElement>(".ws-folder-modal-danger")
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await act(async () => {});

    openFileMenu();
    expect(getMenuDisconnectButton().disabled).toBe(true);

    // 清理
    act(() => { if (resolveDetach) resolveDetach(); });
  });
});

// ────────────────────────────────────────────────────────────
// S5: 引导框取消路径 + 无副作用验证（扩展 Round2 覆盖）
// ────────────────────────────────────────────────────────────
describe("S5: 引导框取消/Escape/遮罩关闭后的状态清理", () => {
  it("取消引导框后 folderIntroDismissChecked 重置为 false（下次再打开不勾选）", async () => {
    // 先清掉 localStorage（还原"未 dismiss"状态）
    window.localStorage.removeItem(FOLDER_INTRO_STORAGE_KEY);
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

    // 第一次：打开引导框，勾选 checkbox，但取消
    openFileMenu();
    clickEl(getAttachFolderRow());
    const checkbox = host?.querySelector<HTMLInputElement>(
      '[data-wf="WsFolderIntroOverlay"] input[type="checkbox"]',
    );
    expect(checkbox).not.toBeNull();
    act(() => { checkbox!.click(); });
    expect(checkbox!.checked).toBe(true);

    // 取消
    const cancelBtn = Array.from(
      host?.querySelectorAll<HTMLButtonElement>(".ws-folder-modal-secondary") ?? [],
    ).find((btn) => btn.textContent?.includes("取消"));
    expect(cancelBtn).not.toBeNull();
    act(() => { cancelBtn!.dispatchEvent(new MouseEvent("click", { bubbles: true })); });

    // 引导框已关闭，localStorage 未写入
    expect(host?.querySelector('[data-wf="WsFolderIntroOverlay"]')).toBeNull();
    expect(window.localStorage.getItem(FOLDER_INTRO_STORAGE_KEY)).toBeNull();

    // 第二次：重新打开引导框，checkbox 应该是未勾选的
    openFileMenu();
    clickEl(getAttachFolderRow());
    const checkbox2 = host?.querySelector<HTMLInputElement>(
      '[data-wf="WsFolderIntroOverlay"] input[type="checkbox"]',
    );
    expect(checkbox2).not.toBeNull();
    expect(checkbox2!.checked).toBe(false);  // 应该重置为 false
    expect(onAttachFolder).not.toHaveBeenCalled();
  });

  it("Escape 关闭引导框后 localStorage 未写入，不触发 attach", async () => {
    window.localStorage.removeItem(FOLDER_INTRO_STORAGE_KEY);

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

    act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });

    expect(host?.querySelector('[data-wf="WsFolderIntroOverlay"]')).toBeNull();
    expect(window.localStorage.getItem(FOLDER_INTRO_STORAGE_KEY)).toBeNull();
  });

  it("断开确认框没有 overlay 点击关闭（设计行为：防误操作）", async () => {
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

    // 打开断开确认框
    openDisconnectDialog();
    const disconnectOverlay = host?.querySelector<HTMLElement>('[data-wf="WsFolderDisconnectOverlay"]');
    expect(disconnectOverlay).not.toBeNull();

    // 点击 overlay 背景（不同于引导框，断开确认框没有 onClick handler）
    act(() => {
      disconnectOverlay!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    // 断开确认框不应该关闭（保持设计意图）
    // 注意：如果产品实际希望 overlay 点击不关闭，那这个测试是期望行为
    // 如果关闭了，需要检查产品设计是否一致
    const disconnectOverlayAfter = host?.querySelector('[data-wf="WsFolderDisconnectOverlay"]');
    // 断开确认框的 overlay 没有 onClick 关闭 handler，所以应该仍然存在
    expect(disconnectOverlayAfter).not.toBeNull();
  });
});
