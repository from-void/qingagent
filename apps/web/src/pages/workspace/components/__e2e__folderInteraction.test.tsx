// @vitest-environment jsdom
/**
 * Round 2 评测探针 — 文件夹交互状态机深挖
 * 文件位置：apps/web/src/pages/workspace/components/__e2e__folderInteraction.test.tsx
 * 跑法：cd apps/web && npx vitest run src/pages/workspace/components/__e2e__folderInteraction.test.tsx
 */
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FolderSource } from "@qingagent/contract-ts";
import { resources } from "../../../system/resources";
import { ChatInput, type ChatInputProps } from "./ChatInput";

const FOLDER_INTRO_STORAGE_KEY = "qingagent:folder-source-intro-dismissed";

let root: Root | null = null;
let host: HTMLDivElement | null = null;

const mockFolderSource: FolderSource = {
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

const mockFolderSourceCapped: FolderSource = {
  ...mockFolderSource,
  fileCount: 200,
  fileCountCapped: true,
};

const mockFolderSourceNullCount: FolderSource = {
  ...mockFolderSource,
  fileCount: null,
};

type FolderInputProps = Pick<
  ChatInputProps,
  "folderSource" | "folderCapability" | "onAttachFolder" | "onDetachFolder"
>;

function baseFolderProps(overrides: Partial<FolderInputProps> = {}): FolderInputProps {
  return {
    folderSource: null,
    folderCapability: { enabled: true, reason: null },
    onAttachFolder: vi.fn(async () => undefined),
    onDetachFolder: vi.fn(async () => undefined),
    ...overrides,
  };
}

beforeEach(() => {
  resources.reset();
  window.localStorage.clear();
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
  const button = host?.querySelector<HTMLButtonElement>('[data-wf="WsFileBtn"]');
  if (!button) throw new Error("file button not found");
  return button;
}

function getFileMenu(): HTMLElement | null {
  return host?.querySelector<HTMLElement>('[data-wf="WsFileMenu"]') ?? null;
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
  const btn = host?.querySelector<HTMLButtonElement>('[data-wf="WsFileMenuDisconnect"]');
  if (!btn) throw new Error("menu disconnect button not found");
  return btn;
}

function getIntroOverlay(): HTMLElement | null {
  return host?.querySelector<HTMLElement>('[data-wf="WsFolderIntroOverlay"]') ?? null;
}

function getDisconnectOverlay(): HTMLElement | null {
  return host?.querySelector<HTMLElement>('[data-wf="WsFolderDisconnectOverlay"]') ?? null;
}

function getIntroContinueButton(): HTMLButtonElement {
  const btn = Array.from(host?.querySelectorAll<HTMLButtonElement>(".ws-folder-modal-primary") ?? []).find(
    (n) => n.textContent?.includes("我知道了，选择文件夹"),
  );
  if (!btn) throw new Error("intro continue button not found");
  return btn;
}

function getDisconnectConfirmButton(): HTMLButtonElement {
  const btn = Array.from(host?.querySelectorAll<HTMLButtonElement>(".ws-folder-modal-danger") ?? []).find(
    (n) => n.textContent?.includes("断开连接"),
  );
  if (!btn) throw new Error("disconnect confirm button not found");
  return btn;
}

function getDisconnectCancelButton(): HTMLButtonElement {
  const btn = Array.from(host?.querySelectorAll<HTMLButtonElement>(".ws-folder-modal-secondary") ?? []).find(
    (n) => n.textContent?.includes("取消"),
  );
  if (!btn) throw new Error("disconnect cancel button not found");
  return btn;
}

function clickElement(el: HTMLElement): void {
  act(() => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

async function clickElementAsync(el: HTMLElement): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

function openFileMenu(): void {
  clickElement(getFileButton());
}

// ────────────────────────────────────────────────────────────
// 场景 1：三按钮顺序
// ────────────────────────────────────────────────────────────
describe("工具栏按钮顺序与存在性", () => {
  it("技能/文件 顺序固定，旧文件夹按钮退役", async () => {
    await renderChatInput(
      <ChatInput
        {...baseFolderProps()}
        placeholder="输入"
        onSubmit={() => undefined}
      />,
    );
    const buttons = Array.from(
      host?.querySelectorAll<HTMLButtonElement>('[data-wf="WsFileBtn"], [data-wf="WsSkillBtn"]') ?? [],
    );
    expect(buttons.map((b) => b.dataset.wf)).toEqual(["WsSkillBtn", "WsFileBtn"]);
    expect(host?.querySelector('[data-wf="WsFolderBtn"]')).toBeNull();
  });
});

// ────────────────────────────────────────────────────────────
// 场景 2：capability 三态
// ────────────────────────────────────────────────────────────
describe("capability 三态", () => {
  it("enabled=true 时菜单连接文件夹行可点击", async () => {
    await renderChatInput(
      <ChatInput
        {...baseFolderProps({ folderCapability: { enabled: true, reason: null } })}
        placeholder="输入"
        onSubmit={() => undefined}
      />,
    );
    openFileMenu();
    expect(getAttachFolderRow().disabled).toBe(false);
  });

  it("enabled=false 且 reason='网页版暂未开放' 时菜单行禁用并展示原因", async () => {
    await renderChatInput(
      <ChatInput
        {...baseFolderProps({ folderCapability: { enabled: false, reason: "网页版暂未开放" } })}
        placeholder="输入"
        onSubmit={() => undefined}
      />,
    );
    openFileMenu();
    const row = getAttachFolderRow();
    expect(row.disabled).toBe(true);
    expect(row.classList.contains("is-disabled")).toBe(true);
    expect(row.textContent).toContain("网页版暂未开放");
  });

  it("unsupported 灰态时点击不调 onAttachFolder", async () => {
    const onAttachFolder = vi.fn(async () => undefined);
    await renderChatInput(
      <ChatInput
        {...baseFolderProps({ folderCapability: { enabled: false, reason: "网页版暂未开放" }, onAttachFolder })}
        placeholder="输入"
        onSubmit={() => undefined}
      />,
    );
    openFileMenu();
    clickElement(getAttachFolderRow());
    expect(onAttachFolder).not.toHaveBeenCalled();
  });
});

// ────────────────────────────────────────────────────────────
// 场景 3：引导框 localStorage 流
// ────────────────────────────────────────────────────────────
describe("引导框与 localStorage", () => {
  it("首次点击显示引导框，不调 onAttachFolder", async () => {
    const onAttachFolder = vi.fn(async () => undefined);
    await renderChatInput(
      <ChatInput
        {...baseFolderProps({ onAttachFolder })}
        placeholder="输入"
        onSubmit={() => undefined}
      />,
    );
    openFileMenu();
    clickElement(getAttachFolderRow());
    expect(getIntroOverlay()).not.toBeNull();
    expect(onAttachFolder).not.toHaveBeenCalled();
  });

  it("引导框默认 checkbox 未勾，继续但不写 localStorage", async () => {
    const onAttachFolder = vi.fn(async () => undefined);
    await renderChatInput(
      <ChatInput
        {...baseFolderProps({ onAttachFolder })}
        placeholder="输入"
        onSubmit={() => undefined}
      />,
    );
    openFileMenu();
    clickElement(getAttachFolderRow());
    const checkbox = getIntroOverlay()?.querySelector<HTMLInputElement>('input[type="checkbox"]');
    expect(checkbox?.checked).toBe(false);
    await clickElementAsync(getIntroContinueButton());
    // 未勾：localStorage 不应写 "1"
    expect(window.localStorage.getItem(FOLDER_INTRO_STORAGE_KEY)).not.toBe("1");
    expect(onAttachFolder).toHaveBeenCalledTimes(1);
    expect(getIntroOverlay()).toBeNull();
  });

  it("勾选 '不再显示' 后写 localStorage，下次跳过引导框直接 attach", async () => {
    const onAttachFolder = vi.fn(async () => undefined);
    await renderChatInput(
      <ChatInput
        {...baseFolderProps({ onAttachFolder })}
        placeholder="输入"
        onSubmit={() => undefined}
      />,
    );
    // 第一次：勾选后继续
    openFileMenu();
    clickElement(getAttachFolderRow());
    const checkbox = getIntroOverlay()?.querySelector<HTMLInputElement>('input[type="checkbox"]');
    if (!checkbox) throw new Error("checkbox not found");
    await act(async () => { checkbox.click(); });
    await clickElementAsync(getIntroContinueButton());
    expect(window.localStorage.getItem(FOLDER_INTRO_STORAGE_KEY)).toBe("1");
    expect(onAttachFolder).toHaveBeenCalledTimes(1);

    // 第二次：直接触发 attach，不弹引导框
    openFileMenu();
    await clickElementAsync(getAttachFolderRow());
    expect(getIntroOverlay()).toBeNull();
    expect(onAttachFolder).toHaveBeenCalledTimes(2);
  });
});

// ────────────────────────────────────────────────────────────
// 场景 4：连接态菜单状态行
// ────────────────────────────────────────────────────────────
describe("连接态文件菜单", () => {
  it("folderSource 存在时状态行展示绿点", async () => {
    await renderChatInput(
      <ChatInput
        {...baseFolderProps({ folderSource: mockFolderSource })}
        placeholder="输入"
        onSubmit={() => undefined}
      />,
    );
    openFileMenu();
    const row = getFolderStatusRow();
    expect(row.textContent).toContain("客户资料");
    expect(row.querySelector(".qa-file-folder-dot")).not.toBeNull();
  });

  it("状态行包含 名称/已连接说明/断开按钮", async () => {
    await renderChatInput(
      <ChatInput
        {...baseFolderProps({ folderSource: mockFolderSource })}
        placeholder="输入"
        onSubmit={() => undefined}
      />,
    );
    openFileMenu();
    const row = getFolderStatusRow();
    expect(row.textContent).toContain("客户资料");
    expect(row.textContent).toContain("已连接 · 点击查看与管理");
    expect(getMenuDisconnectButton()).not.toBeNull();
    expect(host?.querySelector('[data-wf="WsFolderPopover"]')).toBeNull();
  });

  it("fileCountCapped=true 时工具栏菜单不再显示计数", async () => {
    await renderChatInput(
      <ChatInput
        {...baseFolderProps({ folderSource: mockFolderSourceCapped })}
        placeholder="输入"
        onSubmit={() => undefined}
      />,
    );
    openFileMenu();
    expect(getFolderStatusRow().textContent).not.toContain("200+ 个文件");
  });

  it("fileCount=null 时工具栏菜单仍只展示连接状态", async () => {
    await renderChatInput(
      <ChatInput
        {...baseFolderProps({ folderSource: mockFolderSourceNullCount })}
        placeholder="输入"
        onSubmit={() => undefined}
      />,
    );
    openFileMenu();
    expect(getFolderStatusRow().textContent).toContain("已连接 · 点击查看与管理");
  });

  it("folderSource=null 时不渲染状态行也无绿点", async () => {
    await renderChatInput(
      <ChatInput
        {...baseFolderProps({ folderSource: null })}
        placeholder="输入"
        onSubmit={() => undefined}
      />,
    );
    openFileMenu();
    expect(host?.querySelector('[data-wf="WsFileMenuFolderStatus"]')).toBeNull();
    expect(host?.querySelector(".qa-file-folder-dot")).toBeNull();
  });

  it("pathLabel 为 null 时菜单仍展示文件夹名称", async () => {
    const src = { ...mockFolderSource, pathLabel: null };
    await renderChatInput(
      <ChatInput
        {...baseFolderProps({ folderSource: src })}
        placeholder="输入"
        onSubmit={() => undefined}
      />,
    );
    openFileMenu();
    expect(getFolderStatusRow().textContent).toContain("客户资料");
  });
});

// ────────────────────────────────────────────────────────────
// 场景 5：已连接 → 断开二次确认流
// ────────────────────────────────────────────────────────────
describe("断开连接二次确认", () => {
  it("点击菜单断开按钮只弹断开确认框，不调 onAttachFolder/selectFolder", async () => {
    const onAttachFolder = vi.fn(async () => undefined);
    await renderChatInput(
      <ChatInput
        {...baseFolderProps({ folderSource: mockFolderSource, onAttachFolder })}
        placeholder="输入"
        onSubmit={() => undefined}
      />,
    );
    openFileMenu();
    clickElement(getMenuDisconnectButton());
    expect(getDisconnectOverlay()).not.toBeNull();
    expect(onAttachFolder).not.toHaveBeenCalled();
    expect(getIntroOverlay()).toBeNull();
  });

  it("断开确认框：取消后关闭弹框，不调 onDetachFolder", async () => {
    const onDetachFolder = vi.fn(async () => undefined);
    await renderChatInput(
      <ChatInput
        {...baseFolderProps({ folderSource: mockFolderSource, onDetachFolder })}
        placeholder="输入"
        onSubmit={() => undefined}
      />,
    );
    openFileMenu();
    clickElement(getMenuDisconnectButton());
    clickElement(getDisconnectCancelButton());
    expect(getDisconnectOverlay()).toBeNull();
    expect(onDetachFolder).not.toHaveBeenCalled();
  });

  it("断开确认框：确认后调 onDetachFolder(folderId)", async () => {
    const onDetachFolder = vi.fn(async () => undefined);
    await renderChatInput(
      <ChatInput
        {...baseFolderProps({ folderSource: mockFolderSource, onDetachFolder })}
        placeholder="输入"
        onSubmit={() => undefined}
      />,
    );
    openFileMenu();
    clickElement(getMenuDisconnectButton());
    await clickElementAsync(getDisconnectConfirmButton());
    expect(onDetachFolder).toHaveBeenCalledWith("fld_test");
  });

  it("断开成功后弹框自动关闭", async () => {
    const onDetachFolder = vi.fn(async () => undefined);
    await renderChatInput(
      <ChatInput
        {...baseFolderProps({ folderSource: mockFolderSource, onDetachFolder })}
        placeholder="输入"
        onSubmit={() => undefined}
      />,
    );
    openFileMenu();
    clickElement(getMenuDisconnectButton());
    await clickElementAsync(getDisconnectConfirmButton());
    expect(getDisconnectOverlay()).toBeNull();
  });

  it("断开失败后弹框仍留着（可重试），folderActionPending 清空", async () => {
    const onDetachFolder = vi.fn(async () => { throw new Error("network error"); });
    await renderChatInput(
      <ChatInput
        {...baseFolderProps({ folderSource: mockFolderSource, onDetachFolder })}
        placeholder="输入"
        onSubmit={() => undefined}
      />,
    );
    openFileMenu();
    clickElement(getMenuDisconnectButton());
    await clickElementAsync(getDisconnectConfirmButton());
    // 弹框应该仍然存在（允许重试）
    expect(getDisconnectOverlay()).not.toBeNull();
    // 断开按钮不应是 disabled（pending 已重置）
    expect(getDisconnectConfirmButton().disabled).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────
// 场景 6：folderActionPending 禁用状态
// ────────────────────────────────────────────────────────────
describe("folderActionPending 禁用", () => {
  it("attach 进行中：连接文件夹行禁用并展示忙碌文案", async () => {
    // 构造一个永不 resolve 的 onAttachFolder
    let resolve!: () => void;
    const slowAttach = vi.fn(
      () => new Promise<void>((res) => { resolve = res; }),
    );
    window.localStorage.setItem(FOLDER_INTRO_STORAGE_KEY, "1");
    await renderChatInput(
      <ChatInput
        {...baseFolderProps({ onAttachFolder: slowAttach })}
        placeholder="输入"
        onSubmit={() => undefined}
      />,
    );
    // 点击触发 attach（已 dismiss 引导框）
    openFileMenu();
    clickElement(getAttachFolderRow());
    await act(async () => undefined);
    openFileMenu();
    expect(getAttachFolderRow().disabled).toBe(true);
    expect(getAttachFolderRow().textContent).toContain("正在连接文件夹");
    // 清理：resolve promise
    act(() => { resolve(); });
  });

  it("detach 进行中：断开确认框里的断开按钮被禁用", async () => {
    let resolve!: () => void;
    const slowDetach = vi.fn(
      () => new Promise<void>((res) => { resolve = res; }),
    );
    await renderChatInput(
      <ChatInput
        {...baseFolderProps({ folderSource: mockFolderSource, onDetachFolder: slowDetach })}
        placeholder="输入"
        onSubmit={() => undefined}
      />,
    );
    openFileMenu();
    clickElement(getMenuDisconnectButton());
    act(() => {
      getDisconnectConfirmButton().dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    // detach 进行中，断开按钮应被禁用
    expect(getDisconnectConfirmButton().disabled).toBe(true);
    act(() => { resolve(); });
  });

  it("【回归】折叠测试：disabled=true 时文件按钮禁用", async () => {
    await renderChatInput(
      <ChatInput
        {...baseFolderProps()}
        disabled={true}
        placeholder="输入"
        onSubmit={() => undefined}
      />,
    );
    expect(getFileButton().disabled).toBe(true);
  });

  it("【bug候选】disabled=true 时断开确认框中的断开按钮未检查外层 disabled", async () => {
    // 手动构造场景：先渲染 enabled 状态，打开弹框，然后通过 props 变化为 disabled
    // 在 jsdom 里只能测试静态 props 下的行为
    // 直接以 disabled=true + folderSource 渲染，验证弹框里按钮行为
    // 注意：disabled=true 时 handleFolderButton 直接 return（第一行 guard），
    // 所以弹框根本无法被打开——这个路径在正常流程下不可达
    // 但如果存在 folderDialog 被绕过设置的边界情况，按钮会不正确
    // 结论：此场景在组件正常使用下不可触发，属于防御性分析
    const onDetachFolder = vi.fn(async () => undefined);
    await renderChatInput(
      <ChatInput
        {...baseFolderProps({ folderSource: mockFolderSource, onDetachFolder })}
        disabled={true}
        placeholder="输入"
        onSubmit={() => undefined}
      />,
    );
    // disabled=true 时点击不应打开弹框
    clickElement(getFileButton());
    expect(getDisconnectOverlay()).toBeNull();
    expect(onDetachFolder).not.toHaveBeenCalled();
  });
});

// ────────────────────────────────────────────────────────────
// 场景 7：引导框取消路径（关闭弹框而不附加）
// ────────────────────────────────────────────────────────────
describe("引导框关闭路径", () => {
  it("取消按钮关闭引导框且不附加文件夹", async () => {
    const onAttachFolder = vi.fn(async () => undefined);
    await renderChatInput(
      <ChatInput
        {...baseFolderProps({ onAttachFolder })}
        placeholder="输入"
        onSubmit={() => undefined}
      />,
    );
    openFileMenu();
    clickElement(getAttachFolderRow());
    const overlay = getIntroOverlay();
    expect(overlay).not.toBeNull();
    const cancelBtn = Array.from(overlay!.querySelectorAll<HTMLButtonElement>("button")).find((button) =>
      button.textContent?.includes("取消"),
    );
    expect(cancelBtn).toBeDefined();
    clickElement(cancelBtn!);
    expect(getIntroOverlay()).toBeNull();
    expect(onAttachFolder).not.toHaveBeenCalled();
  });
});

// ────────────────────────────────────────────────────────────
// 场景 8：folderSource.status 变体 – 非 connected 状态
// ────────────────────────────────────────────────────────────
describe("folderSource 非 connected 状态", () => {
  it("status=offline 时菜单状态行显示离线状态", async () => {
    const offlineSource: FolderSource = { ...mockFolderSource, status: "offline" };
    await renderChatInput(
      <ChatInput
        {...baseFolderProps({ folderSource: offlineSource })}
        placeholder="输入"
        onSubmit={() => undefined}
      />,
    );
    openFileMenu();
    const row = getFolderStatusRow();
    expect(row.textContent).toContain("连接已离线");
    expect(row.textContent).not.toContain("已连接 · 点击查看与管理");
  });
});
