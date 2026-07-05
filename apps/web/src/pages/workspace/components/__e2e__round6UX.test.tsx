// @vitest-environment jsdom
/**
 * Round 6 评测探针 — 前端 UX/可达性深挖
 * 文件位置：apps/web/src/pages/workspace/components/__e2e__round6UX.test.tsx
 * 跑法：cd apps/web && npx vitest run src/pages/workspace/components/__e2e__round6UX.test.tsx
 *
 * 覆盖范围：
 *   A. dialog aria 属性（aria-labelledby 缺失）
 *   B. 断开确认框 Escape 键支持缺失
 *   C. dialog 打开时焦点不自动移入
 *   D. dialog 关闭后焦点不还回触发按钮
 *   E. focus trap 缺失（Tab 可逃出 dialog）
 *   F. 文件菜单连接行快速双击竞态
 *   G. unsupported 状态在文件菜单中的可达性
 *   H. 长文件夹名在文件菜单与断开弹层中不丢失
 *   I. dialog 叠加（引导框开着时再点别的区域不开第二个 dialog）
 *   J. 引导框 Escape 键（已修，回归无回退）
 *   K. disconnectConfirm 无遮罩点击关闭（设计如此 or bug？）
 */
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FolderSource } from "@qingagent/contract-ts";
import { resources } from "../../../system/resources";
import { ChatInput } from "./ChatInput";

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

// 超长文件夹名：50个汉字
const longFolderName = "超超超超超超超超超超超超超超超超超超超超超超超超超超超超超超超超超超超超超超超超长文件夹名称测试";
const longFolderSource: FolderSource = {
  ...mockFolderSource,
  name: longFolderName,
  pathLabel: "/Users/verylongusernamepath/Documents/Projects/2026/Q2/ClientData/Research/超长路径测试/資料夾",
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

function getIntroCancelButton(): HTMLButtonElement {
  const btn = Array.from(host?.querySelectorAll<HTMLButtonElement>(".ws-folder-modal-secondary") ?? []).find(
    (n) => n.textContent?.includes("取消"),
  );
  if (!btn) throw new Error("intro cancel button not found");
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

function openFileMenu(): void {
  clickElement(getFileButton());
}

function openIntroDialog(): void {
  openFileMenu();
  clickElement(getAttachFolderRow());
}

function openDisconnectDialog(): void {
  openFileMenu();
  clickElement(getMenuDisconnectButton());
}

// ────────────────────────────────────────────────────────────
// A. dialog aria 属性
// ────────────────────────────────────────────────────────────
describe("A. dialog aria 属性", () => {
  it("【BUG-A1】引导框 dialog 缺少 aria-labelledby，屏幕阅读器无法播报标题", async () => {
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
    openIntroDialog();
    const overlay = getIntroOverlay();
    expect(overlay).not.toBeNull();

    // ARIA 规范：role=dialog 必须有 aria-labelledby 或 aria-label 提供可访问名
    // 当前引导框 overlay 只有 role="dialog" aria-modal="true"，缺 aria-labelledby
    const labelledBy = overlay?.getAttribute("aria-labelledby");
    const ariaLabel = overlay?.getAttribute("aria-label");
    // 这个 expect 会失败，证明 bug 存在
    expect(labelledBy ?? ariaLabel).not.toBeNull();
  });

  it("【BUG-A2】断开确认框 dialog 缺少 aria-labelledby", async () => {
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
    const ariaLabel = overlay?.getAttribute("aria-label");
    // 同样缺 aria-labelledby
    expect(labelledBy ?? ariaLabel).not.toBeNull();
  });

  it("【观察-A3】引导框 h3 标题存在但 ID 未被 aria-labelledby 引用", async () => {
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
    openIntroDialog();
    const overlay = getIntroOverlay();
    const h3 = overlay?.querySelector("h3");
    expect(h3).not.toBeNull();
    // h3 应该有 id 以供 aria-labelledby 引用
    const h3Id = h3?.id;
    expect(h3Id).toBeTruthy();
  });
});

// ────────────────────────────────────────────────────────────
// B. 断开确认框 Escape 键支持
// ────────────────────────────────────────────────────────────
describe("B. 断开确认框 Escape 键支持", () => {
  it("【BUG-B1】断开确认框打开后按 Escape 不关闭（intro 有，disconnectConfirm 没有）", async () => {
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

    // 按 Escape，期望弹框关闭
    act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });

    // 实际：弹框仍然存在（bug）
    expect(getDisconnectOverlay()).toBeNull();
  });

  it("【回归-B0】引导框 Escape 关闭仍然正常（无回退）", async () => {
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
    openIntroDialog();
    expect(getIntroOverlay()).not.toBeNull();

    act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });

    expect(getIntroOverlay()).toBeNull();
  });
});

// ────────────────────────────────────────────────────────────
// C. dialog 打开时焦点管理（autoFocus）
// ────────────────────────────────────────────────────────────
describe("C. dialog 打开时焦点不自动移入", () => {
  it("【BUG-C1】引导框打开后，焦点不在 dialog 内任何元素上", async () => {
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
    openIntroDialog();

    const overlay = getIntroOverlay();
    expect(overlay).not.toBeNull();

    // 期望：焦点在 dialog 内（任意可聚焦元素）
    // 实际：焦点仍在触发按钮或其他位置
    const focusedEl = document.activeElement;
    const isInsideDialog = overlay?.contains(focusedEl) ?? false;
    // 断言焦点应在 dialog 内，这会失败（暴露 bug）
    expect(isInsideDialog).toBe(true);
  });

  it("【BUG-C2】断开确认框打开后，焦点不在 dialog 内任何元素上", async () => {
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

    const fileBtn = getFileButton();
    fileBtn.focus();
    openDisconnectDialog();

    const overlay = getDisconnectOverlay();
    expect(overlay).not.toBeNull();

    const focusedEl = document.activeElement;
    const isInsideDialog = overlay?.contains(focusedEl) ?? false;
    expect(isInsideDialog).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────
// D. dialog 关闭后焦点还回触发按钮
// ────────────────────────────────────────────────────────────
describe("D. dialog 关闭后焦点不还回触发元素", () => {
  it("【BUG-D1】引导框取消后，焦点不还回「文件」按钮", async () => {
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
    openIntroDialog();
    expect(getIntroOverlay()).not.toBeNull();

    // 点取消，期望焦点回到 fileBtn
    clickElement(getIntroCancelButton());
    expect(getIntroOverlay()).toBeNull();

    // 检查焦点是否回到 fileBtn
    expect(document.activeElement).toBe(fileBtn);
  });

  it("【BUG-D2】断开确认框取消后，焦点不还回「文件」按钮", async () => {
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

    const fileBtn = getFileButton();
    fileBtn.focus();
    openDisconnectDialog();
    expect(getDisconnectOverlay()).not.toBeNull();

    clickElement(getDisconnectCancelButton());
    expect(getDisconnectOverlay()).toBeNull();

    expect(document.activeElement).toBe(fileBtn);
  });

  it("【BUG-D3】引导框 Escape 关闭后，焦点不还回「文件」按钮", async () => {
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
    openIntroDialog();

    act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(getIntroOverlay()).toBeNull();

    // 焦点应回到 fileBtn
    expect(document.activeElement).toBe(fileBtn);
  });
});

// ────────────────────────────────────────────────────────────
// E. focus trap 缺失（Tab 可逃出 dialog）
// ────────────────────────────────────────────────────────────
describe("E. focus trap 缺失", () => {
  it("【BUG-E1】引导框打开时，Tab 键可将焦点移出 dialog 到 body/外层元素", async () => {
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
    openIntroDialog();
    const overlay = getIntroOverlay();
    expect(overlay).not.toBeNull();

    // dialog 内获取所有可聚焦元素
    const focusables = Array.from(
      overlay!.querySelectorAll<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      ),
    );
    // 应当至少有两个可聚焦元素（继续按钮、取消按钮、checkbox）
    expect(focusables.length).toBeGreaterThanOrEqual(2);

    // 验证 dialog 没有 FocusTrap 机制：
    // 真正的 focus trap 会监听 Tab 键并把焦点锁在 dialog 内
    // jsdom 不能直接测试 Tab 行为，但可以验证没有 keydown 监听器捕获 Tab
    // 通过验证 dialog 元素不含 tabIndex=-1 的 sentinel 节点（常见 trap 实现）
    const sentinels = overlay!.querySelectorAll('[tabindex="-1"][aria-hidden="true"]');
    // 注意：这里验证的是实现细节；真正的 focus trap 会有 sentinel
    // 此测试记录当前状态：无 sentinel，意味着无 trap
    console.log(`[OBSERVE-E1] dialog 内 sentinel 节点数: ${sentinels.length}（0=无 focus trap）`);
    // 预期无 sentinel（即无 focus trap）— 这个 expect 通过，但它记录了缺失
    expect(sentinels.length).toBe(0);
  });
});

// ────────────────────────────────────────────────────────────
// F. 文件菜单连接行快速双击竞态
// ────────────────────────────────────────────────────────────
describe("F. 文件菜单连接行双击竞态", () => {
  it("【BUG候选-F1】同步双击时 startAttachFolder 可能被调用两次（React state 批处理前）", async () => {
    // 文件菜单连接行会调用 requestAttach；真正防重入依赖 hook 内同步 ref guard。
    window.localStorage.setItem(FOLDER_INTRO_STORAGE_KEY, "1");

    let attachCallCount = 0;
    let resolveFirst!: () => void;
    const slowAttach = vi.fn(async () => {
      attachCallCount++;
      await new Promise<void>((res) => {
        if (attachCallCount === 1) resolveFirst = res;
        else res(); // 第二次立即 resolve
      });
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
    const row = getAttachFolderRow();
    act(() => {
      row.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      row.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    await act(async () => { /* flush React updates */ });

    if (slowAttach.mock.calls.length > 1) {
      console.warn(`[BUG-F1 CONFIRMED] 双击绕过 guard: onAttachFolder 被调用 ${slowAttach.mock.calls.length} 次`);
    } else {
      console.log(`[BUG-F1 PASS] 双击被 guard 拦截: onAttachFolder 只调用了 ${slowAttach.mock.calls.length} 次`);
    }

    // 清理
    act(() => { if (resolveFirst) resolveFirst(); });

    // 记录实际行为（不强断言通过，留给人工确认）
    // 如果 > 1 次，是真 bug；如果等于 1，说明 React 批处理保护了
    expect(slowAttach.mock.calls.length).toBeGreaterThanOrEqual(1);
    // 下面这行断言 "应该只有 1 次" — 如果失败则确认 bug
    expect(slowAttach.mock.calls.length).toBe(1);
  });

  it("【PASS-F2】React re-render 后（await act）再点击，folderActionPending guard 生效", async () => {
    window.localStorage.setItem(FOLDER_INTRO_STORAGE_KEY, "1");
    let resolve!: () => void;
    const slowAttach = vi.fn(async () => {
      await new Promise<void>((res) => { resolve = res; });
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

    // 第一次点击，await flush
    await act(async () => {
      getAttachFolderRow().dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    // React 已 commit，菜单关闭；再次打开后连接行 disabled。
    openFileMenu();
    expect(getAttachFolderRow().disabled).toBe(true);

    // 再次点击（disabled 菜单行）
    act(() => {
      getAttachFolderRow().dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(slowAttach).toHaveBeenCalledTimes(1);
    act(() => { resolve(); });
  });
});

// ────────────────────────────────────────────────────────────
// G. unsupported 状态在文件菜单中的可达性
// ────────────────────────────────────────────────────────────
describe("G. unsupported 状态在文件菜单中的可达性", () => {
  it("【回归-G1】folderCapability.enabled=false 时，连接文件夹行置灰并展示 reason", async () => {
    await renderInput(
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
    const row = getAttachFolderRow();
    expect(row.disabled).toBe(true);
    expect(row.classList.contains("is-disabled")).toBe(true);
    expect(row.textContent).toContain("网页版暂未开放");
    expect(getFileButton().getAttribute("aria-describedby")).toBeNull();
  });

  it("【回归-G2】connected 状态行用 menuitem 承载，不再渲染 tooltip 式 hover popover", async () => {
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
    expect(row.getAttribute("role")).toBe("menuitem");
    expect(row.textContent).toContain("客户资料");
    expect(row.textContent).toContain("已连接 · 点击查看与管理");
    expect(getMenuDisconnectButton()).not.toBeNull();
    expect(host?.querySelector('[data-wf="WsFolderPopover"]')).toBeNull();
    expect(getFileButton().getAttribute("aria-describedby")).toBeNull();
  });

  it("【PASS-G3】unsupported 连接行不可点击，原因文案只在菜单行内展示", async () => {
    await renderInput(
      <ChatInput
        folderSource={null}
        folderCapability={{ enabled: false, reason: "网页版暂未开放" }}
        onAttachFolder={vi.fn(async () => undefined)}
        onDetachFolder={vi.fn(async () => undefined)}
        placeholder="输入"
        onSubmit={() => undefined}
      />,
    );

    expect(host?.querySelector(".ws-folder-wrap")).toBeNull();
    expect(document.getElementById("ws-folder-tooltip")).toBeNull();
    openFileMenu();
    expect(getAttachFolderRow().disabled).toBe(true);
    expect(getAttachFolderRow().textContent).toContain("网页版暂未开放");
  });
});

// ────────────────────────────────────────────────────────────
// H. 长文件夹名在菜单和弹层中的文本处理
// ────────────────────────────────────────────────────────────
describe("H. 长文件夹名文本溢出处理", () => {
  it("【观察-H1】超长文件夹名在文件菜单状态行中完整保留（内容存在即通过）", async () => {
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
    // 文本内容应包含完整长名（DOM 层不截断，CSS 负责 overflow:hidden/ellipsis）
    expect(nameEl?.textContent).toContain(longFolderName);
    console.log(`[OBSERVE-H1] 长名称全文在 DOM 中，CSS 截断需视觉确认；name 长度=${longFolderName.length}`);
  });

  it("【观察-H2】文件菜单状态行不承载长路径，路径管理留给底部树面板", async () => {
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
    expect(host?.querySelector(".ws-folder-popover-path")).toBeNull();
    expect(host?.querySelector('[data-wf="WsFileMenu"]')?.textContent).not.toContain("/Users/verylongusernamepath");
  });

  it("【BUG-H3】断开确认框标题含超长文件夹名，h3 无限制宽度可能溢出容器", async () => {
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

    openDisconnectDialog();
    const overlay = getDisconnectOverlay();
    expect(overlay).not.toBeNull();

    // 验证 h3 文本包含完整长名（不被 JS 截断）
    const h3 = overlay?.querySelector('h3');
    expect(h3?.textContent).toContain(longFolderName);
    // 此断言通过，说明 JS 层面不截断；CSS 层面是否截断需视觉验证
    // 但在 jsdom 中不计算布局，标记为观察而非确认 bug
    console.log(`[OBSERVE-H3] h3 包含超长名称（${longFolderName.length}字），jsdom 不计算布局，CSS overflow 需视觉验证`);
  });
});

// ────────────────────────────────────────────────────────────
// I. dialog 叠加防护
// ────────────────────────────────────────────────────────────
describe("I. dialog 叠加防护", () => {
  it("【PASS-I1】引导框打开时再次进入文件菜单不打开第二个 dialog", async () => {
    // 测试：引导框开着时再次点文件按钮/菜单入口是否打开第二个 dialog。
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

    // 打开引导框
    openIntroDialog();
    expect(getIntroOverlay()).not.toBeNull();

    // 再次点击文件按钮（引导框开着时）
    clickElement(getFileButton());

    // 引导框应该仍然只有一个（不叠加）
    const allDialogs = host?.querySelectorAll('[role="dialog"]');
    expect(allDialogs?.length).toBeLessThanOrEqual(1);
  });

  it("【BUG-I2】引导框开着时再次点击连接行不会重置当前 dialog 状态", async () => {
    // hook 有 folderDialog guard，菜单重入不能重置 checkbox 状态。
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

    openIntroDialog();
    expect(getIntroOverlay()).not.toBeNull();

    // 勾选 checkbox
    const checkbox = getIntroOverlay()?.querySelector<HTMLInputElement>('input[type="checkbox"]');
    expect(checkbox).not.toBeNull();
    await act(async () => { checkbox!.click(); });
    expect(checkbox?.checked).toBe(true);

    // 再次尝试从文件菜单点击连接行（引导框还开着）
    openFileMenu();
    clickElement(getAttachFolderRow());

    // 期望：要么不改变状态（保留 checkbox），要么关闭引导框
    const checkboxAfter = getIntroOverlay()?.querySelector<HTMLInputElement>('input[type="checkbox"]');
    // 如果 checkbox 被重置为 false，说明存在 bug
    if (checkboxAfter && !checkboxAfter.checked) {
      console.warn("[BUG-I2 CONFIRMED] 引导框开着时再点连接行，checkbox 状态被重置为 false");
    }
    // 注意：此断言依赖实现细节，仅用于记录行为
    expect(checkboxAfter?.checked).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────
// J. 键盘可达性 — Tab/Enter/Space
// ────────────────────────────────────────────────────────────
describe("J. 键盘可达性", () => {
  it("【PASS-J1】文件按钮是 button 元素，原生支持 Enter/Space 激活", async () => {
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
    const btn = getFileButton();
    expect(btn.tagName.toLowerCase()).toBe("button");
    expect(btn.type).toBe("button");
    // disabled=false 时 tabIndex 默认 0（可通过 Tab 到达）
    expect(btn.disabled).toBe(false);
  });

  it("【PASS-J2】断开确认框的两个按钮都是原生 button，可通过 Tab 在 dialog 内导航", async () => {
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

    const buttons = Array.from(overlay!.querySelectorAll<HTMLButtonElement>("button"));
    expect(buttons.length).toBeGreaterThanOrEqual(2);
    for (const btn of buttons) {
      expect(btn.tagName.toLowerCase()).toBe("button");
    }
  });

  it("【回归-J3】引导框按钮文本与 dialog aria-labelledby 一起提供完整 SR 上下文", async () => {
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
    openIntroDialog();
    const continueBtn = getIntroContinueButton();

    // 按钮文本提供按钮访问名，dialog aria-labelledby 提供弹框标题。
    const overlay = getIntroOverlay();
    const labelledBy = overlay?.getAttribute("aria-labelledby");

    expect(continueBtn.textContent?.trim()).toBe("我知道了，选择文件夹");
    expect(labelledBy).toBeTruthy();
    expect(document.getElementById(labelledBy ?? "")?.textContent).toContain("连接本地文件夹作为资料库");
  });
});

// ────────────────────────────────────────────────────────────
// K. disconnectConfirm 无遮罩点击关闭（设计 vs bug）
// ────────────────────────────────────────────────────────────
describe("K. disconnectConfirm 无遮罩点击关闭", () => {
  it("【观察-K1】断开确认框：点击遮罩层不关闭（intro 可以，disconnect 不能）—— 行为不一致", async () => {
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

    // 点击遮罩层（overlay 本身）
    act(() => {
      overlay!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    // 断开确认框没有 onClick=handleIntroOverlayClick，所以点遮罩不关闭
    const stillOpen = getDisconnectOverlay();
    console.log(`[OBSERVE-K1] 断开确认框点遮罩${stillOpen ? "不关闭（与引导框行为不一致）" : "关闭（已修复）"}`);

    // 注意：断开确认框不关闭可能是防误操作的设计决策（需额外确认才断开）
    // 但与引导框行为不一致，UX 上需要人工判断是否为 bug
  });
});
