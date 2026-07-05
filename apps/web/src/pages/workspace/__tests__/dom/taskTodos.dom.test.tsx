import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TodoItem } from "@qingagent/contract-ts";
import { ScrollToBottomButton } from "../../components/ScrollToBottomButton";
import {
  TASK_PILL_COMPLETE_HIDE_MS,
  TASK_PILL_FADE_MS,
  TaskPill,
} from "../../components/TaskPill";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { initialWorkspaceState, workspaceReducer } from "../../data/workspaceState";

// vite 把 .css 当副作用模块,`?raw` 在 vitest 返回空串 → CSS 守门须直接读磁盘源文件
// (测试固定从 apps/web 运行,按 cwd 定位)。
const inkSkinCss = readFileSync(
  resolve(process.cwd(), "src/pages/workspace/workspace-ink-skin.css"),
  "utf8",
);

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement | null = null;

const mixedTodos: TodoItem[] = [
  { content: "梳理素材与大纲", status: "completed" },
  { content: "联网检索资料", status: "in_progress" },
  { content: "撰写初稿", status: "pending" },
  { content: "高亮改动待审", status: "pending" },
];

const completedTodos: TodoItem[] = mixedTodos.map((todo) => ({
  ...todo,
  status: "completed",
}));

describe("AI任务清单悬浮控件", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    if (root) {
      act(() => root?.unmount());
      root = null;
    }
    host?.remove();
    host = null;
  });

  it("TaskPill 渲染进度、hover 明细和三种任务状态", async () => {
    await render(<TaskPill todos={mixedTodos} />);

    const pill = query<HTMLButtonElement>(".ws-taskpill");
    expect(pill).not.toBeNull();
    expect(pill?.textContent).toContain("1 / 4");
    expect(query('[data-testid="task-progress-ring"]')).not.toBeNull();

    act(() => {
      pill?.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    });
    expect(query(".ws-taskpill-host")?.classList.contains("is-open")).toBe(true);

    const completed = query<HTMLElement>('[data-status="completed"]');
    const inProgress = query<HTMLElement>('[data-status="in_progress"]');
    const pending = host?.querySelectorAll('[data-status="pending"]') ?? [];

    expect(completed?.classList.contains("is-completed")).toBe(true);
    expect(completed?.querySelector(".ws-taskpill-text")?.textContent).toBe("梳理素材与大纲");
    expect(completed?.querySelector(".ws-taskpill-text")).not.toBeNull();
    expect(completed?.querySelector("svg")).not.toBeNull();
    expect(inProgress?.classList.contains("is-in_progress")).toBe(true);
    expect(inProgress?.querySelector(".ws-taskpill-status")).not.toBeNull();
    expect(pending).toHaveLength(2);
    expect(pending[0]?.classList.contains("is-pending")).toBe(true);
    expect(pending[0]?.querySelector(".ws-taskpill-status svg")).toBeNull();
  });

  it("TaskPill 在 todos 为空时不渲染", async () => {
    await render(<TaskPill todos={[]} />);

    expect(query(".ws-taskpill")).toBeNull();
    expect(query(".ws-taskpill-flyout")).toBeNull();
  });

  // F2:活跃会话里「未全完成 → 全完成」的转变沿才播「展示 N/N 再淡出」。
  it("TaskPill 活跃会话从未完成转为全完成:展示 4/4 后淡出", async () => {
    vi.useFakeTimers();
    await render(<TaskPill todos={mixedTodos} />);
    expect(query(".ws-taskpill")?.textContent).toContain("1 / 4");

    // 增量转变:全部标记完成(活跃转变沿)。
    await rerender(<TaskPill todos={completedTodos} />);
    expect(query(".ws-taskpill")?.textContent).toContain("4 / 4");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(TASK_PILL_COMPLETE_HIDE_MS - 1);
    });
    expect(query(".ws-taskpill")).not.toBeNull();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(query(".ws-taskpill-host")?.classList.contains("is-dismissing")).toBe(true);
    expect(query(".ws-taskpill")).not.toBeNull();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(TASK_PILL_FADE_MS);
    });
    expect(query(".ws-taskpill")).toBeNull();
  });

  // F2 回归(用户走查):强刷后帧回放/restore 还原出的初始 todos 已是全完成时,
  // pill 必须直接不渲染——不得再走一遍「展示 4/4 → 2.5s 淡出」造成闪现。
  it("TaskPill 恢复场景初始即全完成:直接不渲染(无闪现)", async () => {
    vi.useFakeTimers();
    await render(<TaskPill todos={completedTodos} />);

    // 初始即全完成 = restore/回放,视为已结束 → 一开始就不出现。
    expect(query(".ws-taskpill")).toBeNull();
    expect(query(".ws-taskpill-host")).toBeNull();

    // 即便等过完整「停留 + 淡出」窗口,也始终不出现(没有先闪一下再消失)。
    await act(async () => {
      await vi.advanceTimersByTimeAsync(
        TASK_PILL_COMPLETE_HIDE_MS + TASK_PILL_FADE_MS + 100,
      );
    });
    expect(query(".ws-taskpill")).toBeNull();
  });

  // F4:flyout 条目三态表达重做——完成项去删除线、进行中去金底/改圆点呼吸闪烁、字号收细。
  it("flyout 条目样式:完成项无删除线、进行中无金底改脉冲、含 reduced-motion 降级", () => {
    // 完成项:文字压灰但不加删除线。
    const completedText = /\.ws-taskpill-item\.is-completed\s+\.ws-taskpill-text\s*\{([^}]*)\}/.exec(inkSkinCss)?.[1];
    expect(completedText == null || !/line-through/.test(completedText)).toBe(true);
    expect(inkSkinCss).not.toMatch(/text-decoration:\s*line-through/);

    // 进行中:不再有金色背景高亮 / 左金边条,改为脉冲动画。
    const inProgressItem = /\.ws-taskpill-item\.is-in_progress\s*\{([^}]*)\}/.exec(inkSkinCss)?.[1];
    // 该独立规则块要么不存在,要么不含背景/左边框着色。
    expect(inProgressItem == null || !/background:/.test(inProgressItem)).toBe(true);
    expect(inProgressItem == null || !/border-left-color/.test(inProgressItem)).toBe(true);
    // 进行中圆点挂上金色呼吸脉冲动画 + 对应 keyframes(选择器同名于 reduced-motion 覆盖块,
    // 故按整文件匹配脉冲声明本身)。
    expect(inkSkinCss).toMatch(/animation:\s*ws-taskpill-pulse/);
    expect(inkSkinCss).toMatch(/@keyframes\s+ws-taskpill-pulse/);

    // 字号收细到 13px 量级(不再是 14px)。
    const itemRule = /\.ws-taskpill-item\s*\{([^}]*)\}/.exec(inkSkinCss)?.[1] ?? "";
    expect(itemRule).toMatch(/font-size:\s*12\.5px/);

    // prefers-reduced-motion 下脉冲降级为静态(animation: none)。
    expect(inkSkinCss).toMatch(/prefers-reduced-motion[\s\S]*is-in_progress[\s\S]*animation:\s*none/);
  });

  it("workspaceReducer 接收 todosChanged，并在 restoreReset 清空", () => {
    const withTodos = workspaceReducer(initialWorkspaceState, {
      kind: "todosChanged",
      data: { todos: mixedTodos },
    });

    expect(withTodos.todos).toEqual(mixedTodos);

    const reset = workspaceReducer(withTodos, {
      kind: "restoreReset",
      data: { epoch: 2, snapshotSeq: 10 },
    });

    expect(reset.todos).toEqual([]);
  });

  it("ScrollToBottomButton 根据底部状态显隐，点击平滑滚到底", async () => {
    const scroller = document.createElement("div");
    const metrics = mockScrollMetrics(scroller, {
      scrollTop: 0,
      clientHeight: 100,
      scrollHeight: 320,
    });
    const scrollTo = vi.fn();
    Object.defineProperty(scroller, "scrollTo", {
      configurable: true,
      value: scrollTo,
    });

    await render(<ScrollToBottomButton scrollRef={{ current: scroller }} />);

    const button = query<HTMLButtonElement>(".ws-scrollbtn");
    expect(button).not.toBeNull();

    act(() => {
      button?.click();
    });
    expect(scrollTo).toHaveBeenCalledWith({ top: 320, behavior: "smooth" });

    metrics.setScrollTop(220);
    act(() => {
      scroller.dispatchEvent(new Event("scroll"));
    });
    expect(query(".ws-scrollbtn")).toBeNull();
  });

  it("ScrollToBottomButton 初始就在底部时隐藏", async () => {
    const scroller = document.createElement("div");
    mockScrollMetrics(scroller, {
      scrollTop: 220,
      clientHeight: 100,
      scrollHeight: 320,
    });

    await render(<ScrollToBottomButton scrollRef={{ current: scroller }} />);

    expect(query(".ws-scrollbtn")).toBeNull();
  });

  // P1 回归(用户走查):输入框被右侧问卷/审批条「同体平移」接管而隐藏(inputHandedOff)时,
  // pill 与回底箭头都不得悬浮。inputHidden 与输入框隐藏同源,是同一 state 驱动。
  it("TaskPill 在输入框隐藏(问卷/审批态)时不渲染,即使有进行中的任务", async () => {
    await render(<TaskPill todos={mixedTodos} inputHidden />);

    expect(query(".ws-taskpill")).toBeNull();
    expect(query(".ws-taskpill-host")).toBeNull();
    expect(query(".ws-taskpill-flyout")).toBeNull();
  });

  it("ScrollToBottomButton 在输入框隐藏时不渲染,即使不在底部", async () => {
    const scroller = document.createElement("div");
    mockScrollMetrics(scroller, {
      scrollTop: 0,
      clientHeight: 100,
      scrollHeight: 320,
    });

    await render(
      <ScrollToBottomButton scrollRef={{ current: scroller }} inputHidden />,
    );

    expect(query(".ws-scrollbtn")).toBeNull();
  });
});

async function render(element: ReactNode): Promise<void> {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(<div id="view-workspace">{element}</div>);
  });
}

// 在同一 root 上以新 props 重渲染(用于模拟活跃增量 todosChanged)。
async function rerender(element: ReactNode): Promise<void> {
  await act(async () => {
    root?.render(<div id="view-workspace">{element}</div>);
  });
}

function query<T extends Element = Element>(selector: string): T | null {
  return host?.querySelector<T>(selector) ?? null;
}

function mockScrollMetrics(
  el: HTMLElement,
  metrics: { scrollTop: number; clientHeight: number; scrollHeight: number },
) {
  let scrollTop = metrics.scrollTop;
  Object.defineProperty(el, "scrollTop", {
    configurable: true,
    get: () => scrollTop,
    set: (value: number) => {
      scrollTop = value;
    },
  });
  Object.defineProperty(el, "clientHeight", {
    configurable: true,
    get: () => metrics.clientHeight,
  });
  Object.defineProperty(el, "scrollHeight", {
    configurable: true,
    get: () => metrics.scrollHeight,
  });
  return {
    setScrollTop(value: number) {
      scrollTop = value;
    },
  };
}
