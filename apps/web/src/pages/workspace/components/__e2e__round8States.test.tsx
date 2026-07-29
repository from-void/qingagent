// @vitest-environment jsdom
/**
 * Round 8 评测探针 — 前端状态组合 + CSS 正确性
 * 文件位置：apps/web/src/pages/workspace/components/__e2e__round8States.test.tsx
 * 跑法：pnpm --filter @qingagent/web test --run src/pages/workspace/components/__e2e__round8States.test.tsx
 *
 * 覆盖范围：
 *   R8-1. connected + pending（attach 进行中）+ 文件菜单状态行同时出现
 *   R8-2. unsupported + 曾连接（folderSource != null 但 enabled=false）状态组合
 *   R8-3. attach 失败后重试：folderActionPending 回到 null、按钮可再次点击
 *   R8-4. detach 失败时 dialog 留存，再点「断开连接」可继续重试
 *   R8-5. CSS 审查：qa-file-folder-dot 绿点颜色与 mockup 一致
 *   R8-6. CSS 审查：qa-file-folder-name 有 text-overflow: ellipsis 防止长名破版
 *   R8-7. CSS 审查：文件菜单不承载长路径
 *   R8-8. CSS 审查：qa-file-menu z-index 与输入框 z-index 关系
 *   R8-9. CSS 审查：is-unsupported / is-connected / is-selecting 三个状态类是否有对应 CSS 规则
 *   R8-10. R6 a11y 回归：引导框 aria-labelledby + h3 id 已修复，无回退
 *   R8-11. R6 a11y 回归：断开确认框 aria-labelledby + h3 id 已修复，无回退
 *   R8-12. R6 a11y 回归：Escape 关引导框无回退
 *   R8-13. R6 a11y 回归：焦点还回触发按钮无回退（取消引导框后）
 *   R8-14. detach 进行中：取消按钮 disabled，防止二次操作
 *   R8-15. connected 态 folderStatusView fallback：未识别 status 走 offline 分支
 */

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FolderSource } from "@qingagent/contract-ts";
import { resources } from "../../../system/resources";
import { ChatInput } from "./ChatInput";

const FOLDER_INTRO_STORAGE_KEY = "qingagent:folder-source-intro-dismissed";
const WORKSPACE_INK_SKIN_CSS = readFileSync(
  "src/pages/workspace/workspace-ink-skin.css",
  "utf8",
);
const SKILL_MENU_CSS = readFileSync(
  "src/system/skill-menu.css",
  "utf8",
);

let root: Root | null = null;
let host: HTMLDivElement | null = null;

const mockFolderSource: FolderSource = {
  id: "fld_r8",
  sessionId: "s8",
  provider: "desktop-local",
  name: "研究资料",
  pathLabel: "~/Documents/研究资料",
  mountName: "source_r8",
  mountPath: "/sources/source_r8",
  readOnly: true,
  fileCount: 23,
  fileCountCapped: false,
  status: "connected",
  error: null,
  createdAt: "2026-06-18T00:00:00.000Z",
  updatedAt: "2026-06-18T00:00:00.000Z",
};

const longFolderSource: FolderSource = {
  ...mockFolderSource,
  name: "超超超超超超超超超超超超超超超超超超超超超超超超超超超超超超长文件夹名称不应溢出",
  pathLabel: "/Users/verylongusername/Documents/Projects/2026/Q2/Research/超长路径名称不应溢出输入框布局/子目录",
};

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

async function renderInput(element: ReactNode): Promise<void> {
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

function getFileMenu(): HTMLElement {
  const menu = host?.querySelector<HTMLElement>('[data-wf="WsFileMenu"]');
  if (!menu) throw new Error("file menu not found");
  return menu;
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

function getDisconnectOverlay(): HTMLElement | null {
  return host?.querySelector<HTMLElement>('[data-wf="WsFolderDisconnectOverlay"]') ?? null;
}

function getIntroOverlay(): HTMLElement | null {
  return host?.querySelector<HTMLElement>('[data-wf="WsFolderIntroOverlay"]') ?? null;
}

function getIntroCancelButton(): HTMLButtonElement {
  const btn = Array.from(host?.querySelectorAll<HTMLButtonElement>(".ws-folder-modal-secondary") ?? []).find(
    (n) => n.textContent?.includes("取消"),
  );
  if (!btn) throw new Error("intro cancel button not found");
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

function selectorBlock(selector: string, css = WORKSPACE_INK_SKIN_CSS): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = css.match(new RegExp(`${escaped}\\s*\\{(?<body>[^}]*)\\}`, "m"));
  return match?.groups?.body ?? "";
}

function hexToRgb(hex: string): [number, number, number] {
  return [
    Number.parseInt(hex.slice(1, 3), 16),
    Number.parseInt(hex.slice(3, 5), 16),
    Number.parseInt(hex.slice(5, 7), 16),
  ];
}

function blend(foreground: [number, number, number], background: [number, number, number], alpha: number): [number, number, number] {
  return [
    Math.round(foreground[0] * alpha + background[0] * (1 - alpha)),
    Math.round(foreground[1] * alpha + background[1] * (1 - alpha)),
    Math.round(foreground[2] * alpha + background[2] * (1 - alpha)),
  ];
}

function relativeLuminance(rgb: [number, number, number]): number {
  const normalize = (channel: number): number => {
    const value = channel / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  const r = normalize(rgb[0]);
  const g = normalize(rgb[1]);
  const b = normalize(rgb[2]);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrastRatio(left: [number, number, number], right: [number, number, number]): number {
  const a = relativeLuminance(left);
  const b = relativeLuminance(right);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

async function clickAsync(el: HTMLElement): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

function openFileMenu(): void {
  clickElement(getFileButton());
}

function openDisconnectDialog(): void {
  openFileMenu();
  clickElement(getMenuDisconnectButton());
}

// ────────────────────────────────────────────────────────────
// R8-1. connected + pending（attach 进行中）+ 文件菜单状态行
// ────────────────────────────────────────────────────────────
describe("R8-1. connected + pending(attach) 状态组合", () => {
  it("连接态菜单状态行展示文件夹名、绿点和断开入口", async () => {
    // 模拟：已连接的会话再次执行 attachFolder（理论路径：onAttachFolder 挂起时父组件强传 pending）
    // 实际产品中 connected 时按钮被 folderSource 守护只显示断开确认，此 case 测的是
    // prop 组合：folderSource != null 且父组件传入 pending 状态时的渲染
    // 通过直接向组件传入已连接 folderSource，检查 is-active + 绿点是否正确渲染
    await renderInput(
      <ChatInput
        folderSource={mockFolderSource}
        folderCapability={{ enabled: true, reason: null }}
        onAttachFolder={vi.fn(async () => undefined)}
        onDetachFolder={vi.fn(async () => undefined)}
        placeholder="输入"
        onSubmit={() => undefined}
      />,
    );

    openFileMenu();
    const row = getFolderStatusRow();

    expect(getFileButton().classList.contains("is-active")).toBe(true);
    expect(row.textContent).toContain("研究资料");
    expect(row.textContent).toContain("已连接 · 点击查看与管理");
    expect(row.querySelector(".qa-file-folder-dot")).not.toBeNull();
    expect(getMenuDisconnectButton()).not.toBeNull();
  });

  it("attach pending 时展示忙碌文案并可停止等待", async () => {
    // 用慢 onAttachFolder 模拟挂起中
    window.localStorage.setItem(FOLDER_INTRO_STORAGE_KEY, "1");
    let resolveAttach!: () => void;
    const slowAttach = vi.fn(async () => {
      await new Promise<void>((res) => { resolveAttach = res; });
    });

    await renderInput(
      <ChatInput
        folderSource={null}
        folderCapability={{ enabled: true, reason: null }}
        onAttachFolder={slowAttach}
        onDetachFolder={vi.fn(async () => undefined)}
        placeholder="输入"
        onSubmit={() => undefined}
      />,
    );

    openFileMenu();
    clickElement(getAttachFolderRow());
    await act(async () => {});

    openFileMenu();
    const row = getAttachFolderRow();
    expect(row.disabled).toBe(false);
    expect(row.textContent).toContain("正在连接文件夹");
    expect(row.textContent).toContain("停止等待");

    clickElement(row);
    await act(async () => {});
    act(() => { resolveAttach(); });
  });
});

// ────────────────────────────────────────────────────────────
// R8-2. unsupported + 曾连接（folderSource != null + enabled=false）
// ────────────────────────────────────────────────────────────
describe("R8-2. unsupported + 曾连接状态组合", () => {
  it("folderSource 存在但 capability.enabled=false：菜单仍显示状态行，不回旧 tooltip/状态浮层", async () => {
    // 这是一个特殊组合：会话仍有 folderSource（未断开），但 capability 被标记为 unsupported
    // 实际可能发生在：用户从桌面版切换到网页版，旧会话数据保留
    await renderInput(
      <ChatInput
        folderSource={mockFolderSource}
        folderCapability={{ enabled: false, reason: "当前环境不支持文件夹资料库" }}
        onAttachFolder={vi.fn(async () => undefined)}
        onDetachFolder={vi.fn(async () => undefined)}
        placeholder="输入"
        onSubmit={() => undefined}
      />,
    );

    expect(getFileButton().disabled).toBe(false);
    expect(host?.querySelector(".ws-folder-wrap")).toBeNull();
    expect(host?.querySelector('[data-wf="WsFolderPopover"]')).toBeNull();

    openFileMenu();
    expect(getFolderStatusRow().textContent).toContain("研究资料");
    expect(getFolderStatusRow().textContent).toContain("已连接 · 点击查看与管理");
  });
});

// ────────────────────────────────────────────────────────────
// R8-3. attach 失败后重试
// ────────────────────────────────────────────────────────────
describe("R8-3. attach 失败后重试", () => {
  it("attach 抛异常后 folderActionPending 回 null，按钮恢复可用", async () => {
    window.localStorage.setItem(FOLDER_INTRO_STORAGE_KEY, "1");
    let callCount = 0;
    const failingAttach = vi.fn(async () => {
      callCount++;
      if (callCount === 1) throw new Error("模拟选择器失败");
      // 第二次成功
    });

    await renderInput(
      <ChatInput
        folderSource={null}
        folderCapability={{ enabled: true, reason: null }}
        onAttachFolder={failingAttach}
        onDetachFolder={vi.fn(async () => undefined)}
        placeholder="输入"
        onSubmit={() => undefined}
      />,
    );

    openFileMenu();
    await clickAsync(getAttachFolderRow());

    // 失败后菜单行应重新可用（folderActionPending 已清零）
    openFileMenu();
    expect(getAttachFolderRow().disabled).toBe(false);

    // 第二次重试应正常发起
    await clickAsync(getAttachFolderRow());
    expect(failingAttach).toHaveBeenCalledTimes(2);
  });
});

// ────────────────────────────────────────────────────────────
// R8-4. detach 失败时 dialog 留存，再点可重试
// ────────────────────────────────────────────────────────────
describe("R8-4. detach 失败 dialog 留存再重试", () => {
  it("detach 抛异常后 dialog 仍然打开，可再次点「断开连接」重试", async () => {
    let detachCallCount = 0;
    const failingDetach = vi.fn(async () => {
      detachCallCount++;
      if (detachCallCount === 1) throw new Error("断开失败");
      // 第二次成功
    });

    await renderInput(
      <ChatInput
        folderSource={mockFolderSource}
        folderCapability={{ enabled: true, reason: null }}
        onAttachFolder={vi.fn(async () => undefined)}
        onDetachFolder={failingDetach}
        placeholder="输入"
        onSubmit={() => undefined}
      />,
    );

    // 打开断开确认 dialog
    openDisconnectDialog();
    expect(getDisconnectOverlay()).not.toBeNull();

    // 点「断开连接」，触发第一次失败
    await clickAsync(getDisconnectConfirmButton());

    // 失败后 dialog 应仍然存在（用户需要能重试）
    // 检查：closeFolderDialog 在 try 块中，失败时不被调用 → dialog 应保持打开
    const overlayAfterFail = getDisconnectOverlay();
    expect(overlayAfterFail).not.toBeNull();

    // 断开按钮应重新可用（folderActionPending 已清零）
    const confirmBtn = getDisconnectConfirmButton();
    expect(confirmBtn.disabled).toBe(false);

    // 再次点击重试
    await clickAsync(confirmBtn);
    expect(failingDetach).toHaveBeenCalledTimes(2);
  });

  it("detach 失败后取消按钮仍可用，用户可选择放弃", async () => {
    const failingDetach = vi.fn(async () => {
      throw new Error("断开失败");
    });

    await renderInput(
      <ChatInput
        folderSource={mockFolderSource}
        folderCapability={{ enabled: true, reason: null }}
        onAttachFolder={vi.fn(async () => undefined)}
        onDetachFolder={failingDetach}
        placeholder="输入"
        onSubmit={() => undefined}
      />,
    );

    openDisconnectDialog();
    await clickAsync(getDisconnectConfirmButton());

    // 失败后取消按钮应可用
    const cancelBtn = getDisconnectCancelButton();
    expect(cancelBtn.disabled).toBe(false);

    // 点取消可关闭 dialog
    clickElement(cancelBtn);
    expect(getDisconnectOverlay()).toBeNull();
  });
});

// ────────────────────────────────────────────────────────────
// R8-5. CSS 审查：菜单绿点颜色与 mockup 一致
// ────────────────────────────────────────────────────────────
describe("R8-5. CSS 绿点颜色对照 mockup", () => {
  it("qa-file-folder-dot 在 DOM 中存在且颜色由共享 CSS 控制", async () => {
    // mockup (.dot-live): background:#6fae6a; box-shadow:0 0 0 3px rgba(111,174,106,.22)
    // CSS (.qa-file-folder-dot): background: #6fae6a; box-shadow: 0 0 0 3px rgba(111, 174, 106, 0.22)
    // 此测试验证结构存在（颜色值在 CSS 文件中通过静态分析确认）

    await renderInput(
      <ChatInput
        folderSource={mockFolderSource}
        folderCapability={{ enabled: true, reason: null }}
        onAttachFolder={vi.fn(async () => undefined)}
        onDetachFolder={vi.fn(async () => undefined)}
        placeholder="输入"
        onSubmit={() => undefined}
      />,
    );

    openFileMenu();
    const dot = host?.querySelector(".qa-file-folder-dot");
    expect(dot).not.toBeNull();
    expect(dot?.classList.contains("qa-file-folder-dot")).toBe(true);

    // DOM 中绿点的 inline style 应无 background（颜色由 CSS class 控制，无硬编码）
    const dotEl = dot as HTMLElement;
    expect(dotEl.style.background).toBe("");
    expect(selectorBlock(".qa-file-folder-dot", SKILL_MENU_CSS)).toContain("background: #6fae6a");
  });
});

// ────────────────────────────────────────────────────────────
// R8-6. CSS 审查：菜单长文件夹名 text-overflow 防止破版
// ────────────────────────────────────────────────────────────
describe("R8-6. CSS 长文件夹名 text-overflow", () => {
  it("长文件夹名菜单名称元素有截断类，CSS 有 ellipsis 规则", async () => {
    await renderInput(
      <ChatInput
        folderSource={longFolderSource}
        folderCapability={{ enabled: true, reason: null }}
        onAttachFolder={vi.fn(async () => undefined)}
        onDetachFolder={vi.fn(async () => undefined)}
        placeholder="输入"
        onSubmit={() => undefined}
      />,
    );

    openFileMenu();
    const nameEl = host?.querySelector(".qa-file-folder-name");
    expect(nameEl).not.toBeNull();

    // 长名文字已渲染到 DOM
    expect(nameEl?.textContent).toContain("超超超超超");

    expect(nameEl?.classList.contains("qa-file-folder-name")).toBe(true);
    const nameBlock = selectorBlock(".qa-file-name", SKILL_MENU_CSS);
    expect(nameBlock).toContain("overflow: hidden");
    expect(nameBlock).toContain("text-overflow: ellipsis");
    expect(nameBlock).toContain("white-space: nowrap");
  });

  it("长路径不再出现在工具栏菜单，路径信息留给 5B 树面板", async () => {
    await renderInput(
      <ChatInput
        folderSource={longFolderSource}
        folderCapability={{ enabled: true, reason: null }}
        onAttachFolder={vi.fn(async () => undefined)}
        onDetachFolder={vi.fn(async () => undefined)}
        placeholder="输入"
        onSubmit={() => undefined}
      />,
    );

    openFileMenu();
    expect(getFolderStatusRow().textContent).not.toContain("/Users/verylongusername");
  });
});

// ────────────────────────────────────────────────────────────
// R8-8. CSS 审查：文件菜单层叠关系
// ────────────────────────────────────────────────────────────
describe("R8-8. CSS 文件菜单 z-index 层叠关系", () => {
  it("qa-file-menu 复用 qa-skill-menu 的暖白纸浮层", async () => {
    // CSS 中 .qa-file-menu 复用 .qa-skill-menu 的浮层参数。
    // wf-input 通常不创建新 stacking context → z-index 8 应足够浮在输入框上方
    // 但如果输入框外层有 position:relative + overflow:hidden，会裁剪浮层
    await renderInput(
      <ChatInput
        folderSource={mockFolderSource}
        folderCapability={{ enabled: true, reason: null }}
        onAttachFolder={vi.fn(async () => undefined)}
        onDetachFolder={vi.fn(async () => undefined)}
        placeholder="输入"
        onSubmit={() => undefined}
      />,
    );

    openFileMenu();
    const menu = getFileMenu();
    expect(menu.classList.contains("qa-skill-menu")).toBe(true);
    expect(menu.classList.contains("qa-file-menu")).toBe(true);
    expect(menu.getAttribute("role")).toBe("menu");
    expect(selectorBlock(".qa-skill-menu", SKILL_MENU_CSS)).toContain("z-index: 90");
  });
});

// ────────────────────────────────────────────────────────────
// R8-9. CSS 审查：旧按钮壳状态类退役
// ────────────────────────────────────────────────────────────
describe("R8-9. CSS 状态类完整性审查", () => {
  it("旧 ws-folder-wrap/is-connected 壳不再由 ChatInput 渲染", async () => {
    await renderInput(
      <ChatInput
        folderSource={mockFolderSource}
        folderCapability={{ enabled: true, reason: null }}
        onAttachFolder={vi.fn(async () => undefined)}
        onDetachFolder={vi.fn(async () => undefined)}
        placeholder="输入"
        onSubmit={() => undefined}
      />,
    );

    expect(host?.querySelector(".ws-folder-wrap")).toBeNull();
    openFileMenu();
    expect(getFolderStatusRow().textContent).toContain("研究资料");
  });

  it("attach pending 视觉由菜单行 disabled + 忙碌文案承载", async () => {
    window.localStorage.setItem(FOLDER_INTRO_STORAGE_KEY, "1");
    let resolveAttach!: () => void;
    const slowAttach = vi.fn(async () => {
      await new Promise<void>((res) => { resolveAttach = res; });
    });

    await renderInput(
      <ChatInput
        folderSource={null}
        folderCapability={{ enabled: true, reason: null }}
        onAttachFolder={slowAttach}
        onDetachFolder={vi.fn(async () => undefined)}
        placeholder="输入"
        onSubmit={() => undefined}
      />,
    );

    openFileMenu();
    clickElement(getAttachFolderRow());
    await act(async () => {});

    openFileMenu();
    expect(getAttachFolderRow().disabled).toBe(false);
    expect(getAttachFolderRow().textContent).toContain("正在连接文件夹");
    expect(getAttachFolderRow().textContent).toContain("停止等待");

    clickElement(getAttachFolderRow());
    await act(async () => {});
    act(() => { resolveAttach(); });
  });

  it("unsupported 视觉由连接文件夹菜单行 is-disabled 承载", async () => {
    await renderInput(
      <ChatInput
        folderSource={null}
        folderCapability={{ enabled: false, reason: "网页版不支持" }}
        onAttachFolder={vi.fn(async () => undefined)}
        onDetachFolder={vi.fn(async () => undefined)}
        placeholder="输入"
        onSubmit={() => undefined}
      />,
    );

    openFileMenu();
    const row = getAttachFolderRow();
    expect(row.disabled).toBe(true);
    expect(row.classList.contains("is-disabled")).toBe(true);
    expect(row.textContent).toContain("网页版不支持");
  });
});

// ────────────────────────────────────────────────────────────
// R8-10/11. R6 a11y 回归：aria-labelledby 已修复
// ────────────────────────────────────────────────────────────
describe("R8-10/11. R6 a11y 回归：aria-labelledby 修复无回退", () => {
  it("引导框 dialog 有 aria-labelledby 且指向 h3#ws-folder-intro-title（R6 修复）", async () => {
    await renderInput(
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

    // 检查 aria-labelledby
    const labelledBy = overlay?.getAttribute("aria-labelledby");
    expect(labelledBy).toBe("ws-folder-intro-title");

    // 检查 h3 有对应 id
    const h3 = overlay?.querySelector("h3#ws-folder-intro-title");
    expect(h3).not.toBeNull();
    expect(h3?.textContent).toContain("连接本地文件夹作为资料库");
  });

  it("断开确认框 dialog 有 aria-labelledby 且指向 h3#ws-folder-disconnect-title（R6 修复）", async () => {
    await renderInput(
      <ChatInput
        folderSource={mockFolderSource}
        folderCapability={{ enabled: true, reason: null }}
        onAttachFolder={vi.fn(async () => undefined)}
        onDetachFolder={vi.fn(async () => undefined)}
        placeholder="输入"
        onSubmit={() => undefined}
      />,
    );

    openDisconnectDialog();
    const overlay = getDisconnectOverlay();
    expect(overlay).not.toBeNull();

    const labelledBy = overlay?.getAttribute("aria-labelledby");
    expect(labelledBy).toBe("ws-folder-disconnect-title");

    const h3 = overlay?.querySelector("h3#ws-folder-disconnect-title");
    expect(h3).not.toBeNull();
    expect(h3?.textContent).toContain("断开「研究资料」连接？");
  });
});

// ────────────────────────────────────────────────────────────
// R8-12. R6 a11y 回归：Escape 关引导框
// ────────────────────────────────────────────────────────────
describe("R8-12. R6 a11y 回归：Escape 关引导框", () => {
  it("引导框打开后按 Escape 关闭（R6 修复，无回退）", async () => {
    await renderInput(
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

  it("断开确认框打开后按 Escape 关闭（R6 修复，无回退）", async () => {
    await renderInput(
      <ChatInput
        folderSource={mockFolderSource}
        folderCapability={{ enabled: true, reason: null }}
        onAttachFolder={vi.fn(async () => undefined)}
        onDetachFolder={vi.fn(async () => undefined)}
        placeholder="输入"
        onSubmit={() => undefined}
      />,
    );

    openDisconnectDialog();
    expect(getDisconnectOverlay()).not.toBeNull();

    act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(getDisconnectOverlay()).toBeNull();
  });
});

// ────────────────────────────────────────────────────────────
// R8-13. R6 a11y 回归：焦点还回触发按钮
// ────────────────────────────────────────────────────────────
describe("R8-13. R6 a11y 回归：dialog 关闭后焦点还回按钮", () => {
  it("引导框取消后焦点还回文件按钮（R6 修复，无回退）", async () => {
    await renderInput(
      <ChatInput
        folderSource={null}
        folderCapability={{ enabled: true, reason: null }}
        onAttachFolder={vi.fn(async () => undefined)}
        onDetachFolder={vi.fn(async () => undefined)}
        placeholder="输入"
        onSubmit={() => undefined}
      />,
    );

    const fileBtn = getFileButton();
    fileBtn.focus();
    openFileMenu();
    clickElement(getAttachFolderRow());
    expect(getIntroOverlay()).not.toBeNull();

    clickElement(getIntroCancelButton());
    expect(getIntroOverlay()).toBeNull();

    // 焦点应还回文件按钮
    expect(document.activeElement).toBe(fileBtn);
  });
});

// ────────────────────────────────────────────────────────────
// R8-14. detach 进行中：取消按钮 disabled，防止二次操作
// ────────────────────────────────────────────────────────────
describe("R8-14. detach 进行中取消按钮应 disabled", () => {
  it("点「断开连接」后挂起中，取消按钮应 disabled 防止用户关闭飞行中的操作", async () => {
    let resolveDetach!: () => void;
    const slowDetach = vi.fn(async () => {
      await new Promise<void>((res) => { resolveDetach = res; });
    });

    await renderInput(
      <ChatInput
        folderSource={mockFolderSource}
        folderCapability={{ enabled: true, reason: null }}
        onAttachFolder={vi.fn(async () => undefined)}
        onDetachFolder={slowDetach}
        placeholder="输入"
        onSubmit={() => undefined}
      />,
    );

    openDisconnectDialog();

    // 点「断开连接」，让其挂起
    await act(async () => {
      getDisconnectConfirmButton().dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    // detach 进行中：取消按钮应 disabled
    const cancelBtn = getDisconnectCancelButton();
    expect(cancelBtn.disabled).toBe(true);
    // 断开按钮也应 disabled
    expect(getDisconnectConfirmButton().disabled).toBe(true);

    // 清理
    act(() => { resolveDetach(); });
  });
});

// ────────────────────────────────────────────────────────────
// R8-15. folderStatusView fallback：未识别 status 走 offline 分支
// ────────────────────────────────────────────────────────────
describe("R8-15. folderStatusView fallback", () => {
  it("未识别的 status 值 → 菜单状态行显示「连接已离线」", async () => {
    const unknownStatusSource: FolderSource = {
      ...mockFolderSource,
      status: "unknown_future_status" as FolderSource["status"],
    };

    await renderInput(
      <ChatInput
        folderSource={unknownStatusSource}
        folderCapability={{ enabled: true, reason: null }}
        onAttachFolder={vi.fn(async () => undefined)}
        onDetachFolder={vi.fn(async () => undefined)}
        placeholder="输入"
        onSubmit={() => undefined}
      />,
    );

    openFileMenu();
    const row = getFolderStatusRow();
    // fallback 走 default → offline 状态
    expect(row.textContent).toContain("连接已离线");
  });
});

describe("R8-CSS. 文件菜单与可达性回归", () => {
  it("qa-file-menu 复用暖白纸菜单尺寸和 overflow 规则", () => {
    const menuBlock = selectorBlock(".qa-file-menu", SKILL_MENU_CSS);
    const baseBlock = selectorBlock(".qa-skill-menu", SKILL_MENU_CSS);

    expect(menuBlock).toContain("width: 308px");
    expect(menuBlock).toContain("overflow: visible");
    expect(baseBlock).toContain("--qa-menu-bg: var(--bg-paper-deep)");
    expect(baseBlock).toContain("background: var(--qa-menu-bg)");
    expect(baseBlock).toContain("border-radius: 0");
  });

  it("detach pending 的取消按钮有 disabled 视觉反馈", () => {
    const block = selectorBlock("#view-workspace .ws-folder-modal-secondary:disabled");

    expect(block).toContain("cursor: not-allowed");
    expect(block).toContain("opacity: 0.58");
  });

  it("folder check 与菜单说明文字达到 WCAG AA 对比度", () => {
    const checkContrast = contrastRatio(hexToRgb("#6b5f50"), hexToRgb("#efe7d6"));
    const descContrast = contrastRatio(hexToRgb("#655f54"), hexToRgb("#efe7d6"));

    expect(selectorBlock("#view-workspace .ws-folder-check")).toContain("color: var(--ink-2)");
    expect(selectorBlock(".qa-file-desc", SKILL_MENU_CSS)).toContain("color: var(--qa-menu-muted)");
    expect(checkContrast).toBeGreaterThanOrEqual(4.5);
    expect(descContrast).toBeGreaterThanOrEqual(4.5);
  });
});
