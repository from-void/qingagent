// @vitest-environment jsdom

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AskUserSpec } from "../data/protocol";
import { AskUserOverlay } from "./AskUserOverlay";
import { renderMermaid } from "./mermaidRender";

vi.mock("./mermaidRender", async (importOriginal) => ({
  ...await importOriginal<typeof import("./mermaidRender")>(),
  renderMermaid: vi.fn(async (source: string) => `<svg data-source="${source}"></svg>`),
}));

let root: Root | null = null;
let host: HTMLDivElement | null = null;

const emptySpec: AskUserSpec = {
  id: "ask-empty",
  mode: { kind: "overlay" },
  purpose: null,
  source: null,
  rationale: null,
  questions: [],
};

const focusSpec: AskUserSpec = {
  id: "ask-focus",
  mode: { kind: "overlay" },
  purpose: null,
  source: null,
  rationale: null,
  questions: [
    {
      id: "q-1",
      label: "选择方向",
      kind: { kind: "single" },
      options: [
        { value: "warm", label: "温和", description: null, preview: null },
        { value: "sharp", label: "锐利", description: null, preview: null },
      ],
      placeholder: null,
    },
  ],
};

const mixedSpec: AskUserSpec = {
  id: "ask-mixed",
  mode: { kind: "overlay" },
  purpose: null,
  source: null,
  rationale: "只统计选择题为必答。",
  questions: [
    {
      id: "q-single",
      header: "方向",
      label: "选一个方向",
      kind: { kind: "single" },
      options: [{ value: "a", label: "方向 A", description: null, preview: null }],
      placeholder: null,
    },
    {
      id: "q-slider",
      header: "篇幅",
      label: "篇幅多少",
      kind: { kind: "slider" },
      options: [],
      placeholder: null,
      slider: {
        min: 300,
        max: 1200,
        step: 100,
        unit: "字",
        marks: null,
        aboveLabel: "1200 字以上",
      },
    },
    {
      id: "q-text",
      header: "补充",
      label: "补充说明",
      kind: { kind: "text" },
      options: [],
      placeholder: "直接写",
    },
  ],
};

const navigationSpec: AskUserSpec = {
  id: "ask-navigation",
  mode: { kind: "overlay" },
  purpose: null,
  source: null,
  rationale: null,
  questions: [
    {
      id: "q-style",
      header: "文风",
      label: "选择文风",
      kind: { kind: "single" },
      options: [{ value: "plain", label: "平实", description: null, preview: null }],
      placeholder: null,
    },
    {
      id: "q-points",
      label: "选择要点",
      kind: { kind: "multi" },
      options: [{ value: "data", label: "数据", description: null, preview: null }],
      placeholder: null,
    },
    {
      id: "q-note",
      header: "补充",
      label: "还有什么",
      kind: { kind: "text" },
      options: [],
      placeholder: "补充说明",
    },
  ],
};

describe("AskUserOverlay", () => {
  afterEach(() => {
    vi.useRealTimers();
    if (root) {
      act(() => root?.unmount());
      root = null;
    }
    host?.remove();
    host = null;
    vi.mocked(renderMermaid).mockClear();
  });

  it("空问题时显示 loading，保留手动输入且禁用提交", async () => {
    const onSubmit = vi.fn();
    await renderOverlay(emptySpec, onSubmit);

    expect(host?.querySelector('[data-wf="AskUserLoading"]')).not.toBeNull();
    expect(host?.textContent).toContain("正在准备问题");
    expect(host?.textContent).toContain("手动输入");
    expect(findSubmitButton().disabled).toBe(true);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("打开后聚焦当前题首个选项而非关闭按钮，卸载时恢复原焦点", async () => {
    const trigger = document.createElement("button");
    trigger.type = "button";
    trigger.textContent = "打开问卷";
    document.body.appendChild(trigger);
    trigger.focus();

    await renderOverlay(focusSpec);
    expect(document.activeElement).toBe(host?.querySelector('input[type="radio"]'));
    expect(document.activeElement).not.toBe(host?.querySelector(".au-x"));

    act(() => {
      root?.unmount();
      root = null;
    });
    expect(document.activeElement).toBe(trigger);
    trigger.remove();
  });

  it("当前题没有选项时初始聚焦自定义输入框", async () => {
    await renderOverlay({
      ...navigationSpec,
      id: "ask-text-focus",
      questions: [navigationSpec.questions[2]!],
    });

    expect(document.activeElement).toBe(host?.querySelector(".au-text"));
  });

  it("单题时不渲染问题导航、题号前缀与进度计数", async () => {
    await renderOverlay(focusSpec);

    expect(host?.querySelector(".auq-tabs")).toBeNull();
    expect(host?.querySelector(".au-q-num")).toBeNull();
    expect(host?.querySelector(".au-progress")).toBeNull();
  });

  it("两题时保留问题导航、题号前缀与进度计数", async () => {
    await renderOverlay({
      ...focusSpec,
      id: "ask-two-questions",
      questions: [
        ...focusSpec.questions,
        {
          id: "q-2",
          label: "补充说明",
          kind: { kind: "text" },
          options: [],
          placeholder: null,
        },
      ],
    });

    expect(host?.querySelectorAll(".auq-tab")).toHaveLength(2);
    expect(host?.querySelector(".au-q-num")?.textContent).toBe("01");
    expect(host?.querySelector(".au-progress")?.textContent).toContain("0 / 1");
  });

  it("自由输入时选项始终在 DOM；单选自定义与选项提交语义 XOR", async () => {
    const onSubmit = vi.fn();
    await renderOverlay(focusSpec, onSubmit);
    const other = host!.querySelector<HTMLInputElement>(".au-other")!;

    await act(async () => {
      other.focus();
      setNativeInputValue(other, "我自己的方向");
      other.dispatchEvent(new Event("input", { bubbles: true }));
      other.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(host?.querySelectorAll('input[type="radio"]')).toHaveLength(2);
    expect(other.dataset.active).toBe("true");
    expect(host?.textContent).toContain("以自定义内容作答");

    await click(host!.querySelectorAll<HTMLInputElement>('input[type="radio"]')[1]!);
    expect(host?.querySelector<HTMLInputElement>(".au-other")?.value).toBe("我自己的方向");
    expect(host?.querySelector<HTMLInputElement>(".au-other")?.dataset.active).toBe("false");

    await click(findSubmitButton());
    expect(onSubmit).toHaveBeenCalledWith({
      "q-1": { chosen: ["sharp"], freeText: null },
    });
  });

  it("一题一屏；chips 可点击跳题并支持方向键导航", async () => {
    await renderOverlay(navigationSpec);

    expect(host?.querySelectorAll('[role="tabpanel"]')).toHaveLength(1);
    expect(host?.textContent).toContain("选择文风");
    expect(host?.querySelectorAll(".auq-tab")).toHaveLength(3);
    expect(host?.querySelectorAll(".auq-tab")[1]?.textContent).toBe("02");

    await click(host!.querySelectorAll<HTMLButtonElement>(".auq-tab")[2]!);
    expect(host?.querySelector('[role="tabpanel"]')?.textContent).toContain("还有什么");

    const currentTab = host!.querySelector<HTMLButtonElement>('.auq-tab[data-current="true"]')!;
    await act(async () => {
      currentTab.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    });
    expect(host?.querySelector('[role="tabpanel"]')?.textContent).toContain("选择要点");
    expect(document.activeElement).toBe(host?.querySelectorAll(".auq-tab")[1]);
  });

  it("浮层级键盘支持上下循环、数字直选与 Enter 选中", async () => {
    await renderOverlay(focusSpec);
    const options = host!.querySelectorAll<HTMLInputElement>('input[type="radio"]');
    const other = host!.querySelector<HTMLInputElement>(".au-other")!;

    expect(document.activeElement).toBe(options[0]);
    await keyDown(options[0]!, "ArrowDown");
    expect(document.activeElement).toBe(options[1]);
    await keyDown(options[1]!, "ArrowDown");
    expect(document.activeElement).toBe(other);
    await keyDown(other, "ArrowDown");
    expect(document.activeElement).toBe(options[0]);
    await keyDown(options[0]!, "ArrowUp");
    expect(document.activeElement).toBe(other);

    options[0]!.focus();
    await keyDown(options[0]!, "2");
    expect(options[1]?.checked).toBe(true);
    options[0]!.focus();
    await keyDown(options[0]!, "Enter");
    expect(options[0]?.checked).toBe(true);
  });

  it("浮层级左右键切题，但文本输入框保留左右移动", async () => {
    await renderOverlay(navigationSpec);
    const firstOption = host!.querySelector<HTMLInputElement>('input[type="radio"]')!;

    await keyDown(firstOption, "ArrowRight");
    expect(host?.querySelector('[role="tabpanel"]')?.textContent).toContain("选择要点");
    await keyDown(document.activeElement as HTMLElement, "ArrowLeft");
    expect(host?.querySelector('[role="tabpanel"]')?.textContent).toContain("选择文风");

    await click(host!.querySelectorAll<HTMLButtonElement>(".auq-tab")[2]!);
    const textInput = host!.querySelector<HTMLInputElement>(".au-text")!;
    textInput.focus();
    await keyDown(textInput, "ArrowLeft");
    expect(host?.querySelector('[role="tabpanel"]')?.textContent).toContain("还有什么");
    expect(document.activeElement).toBe(textInput);
  });

  it("自定义输入 Enter 确认后前进，IME 组合期间 Enter 不前进", async () => {
    const onSubmit = vi.fn();
    await renderOverlay({
      ...navigationSpec,
      id: "ask-custom-enter",
      questions: [navigationSpec.questions[0]!, navigationSpec.questions[2]!],
    }, onSubmit);
    const other = host!.querySelector<HTMLInputElement>(".au-other")!;
    await inputText(other, "用自己的文风");

    await keyDown(other, "Enter");
    expect(host?.querySelector('[role="tabpanel"]')?.textContent).toContain("还有什么");

    const textInput = host!.querySelector<HTMLInputElement>(".au-text")!;
    await inputText(textInput, "补充内容");
    await act(async () => {
      textInput.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    });
    await keyDown(textInput, "Enter");
    expect(host?.querySelector('[role="tabpanel"]')?.textContent).toContain("还有什么");
    expect(onSubmit).not.toHaveBeenCalled();
    await act(async () => {
      textInput.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
    });
    await keyDown(textInput, "Enter");
    expect(onSubmit).toHaveBeenCalledWith({
      "q-style": { chosen: [], freeText: "用自己的文风" },
      "q-note": { chosen: [], freeText: "补充内容" },
    });
  });

  it("不再渲染上一题和下一题按钮", async () => {
    await renderOverlay(navigationSpec);

    const buttonLabels = Array.from(host!.querySelectorAll("button"), (button) => button.textContent?.trim());
    expect(buttonLabels).not.toContain("上一题");
    expect(buttonLabels).not.toContain("下一题");
  });

  it("Ctrl/Cmd+Enter 仅在所有题已答时提交", async () => {
    const onSubmit = vi.fn();
    await renderOverlay(navigationSpec, onSubmit);

    await keyDown(host!.querySelector<HTMLInputElement>('input[type="radio"]')!, "Enter", { ctrlKey: true });
    expect(onSubmit).not.toHaveBeenCalled();

    await click(host!.querySelector<HTMLInputElement>('input[type="radio"]')!);
    await click(host!.querySelectorAll<HTMLButtonElement>(".auq-tab")[1]!);
    await click(host!.querySelector<HTMLInputElement>('input[type="checkbox"]')!);
    await click(host!.querySelectorAll<HTMLButtonElement>(".auq-tab")[2]!);
    const textInput = host!.querySelector<HTMLInputElement>(".au-text")!;
    await inputText(textInput, "补充内容");
    await keyDown(textInput, "Enter", { metaKey: true });

    expect(onSubmit).toHaveBeenCalledOnce();
    expect(onSubmit).toHaveBeenCalledWith({
      "q-style": { chosen: ["plain"], freeText: null },
      "q-points": { chosen: ["data"], freeText: null },
      "q-note": { chosen: [], freeText: "补充内容" },
    });
  });

  it("单选后 350ms 自动前进到下一道未答题", async () => {
    vi.useFakeTimers();
    await renderOverlay(navigationSpec);

    await click(host!.querySelector<HTMLInputElement>('input[type="radio"]')!);
    expect(host?.querySelector('[role="tabpanel"]')?.textContent).toContain("选择文风");
    await act(async () => {
      vi.advanceTimersByTime(350);
    });
    expect(host?.querySelector('[role="tabpanel"]')?.textContent).toContain("选择要点");
    expect(host?.querySelector('.auq-tab[data-answered="true"]')?.textContent).toContain("文风");
    expect(document.activeElement).toBe(host?.querySelector('input[type="checkbox"]'));
  });

  it("自动前进等待期间手动跳题后不再抢回当前题", async () => {
    vi.useFakeTimers();
    await renderOverlay(navigationSpec);

    await click(host!.querySelector<HTMLInputElement>('input[type="radio"]')!);
    await click(host!.querySelectorAll<HTMLButtonElement>(".auq-tab")[2]!);
    await act(async () => {
      vi.advanceTimersByTime(350);
    });

    expect(host?.querySelector('[role="tabpanel"]')?.textContent).toContain("还有什么");
  });

  it("切回选项后同一 spec 流式追加题目仍保留 XOR 与已答状态", async () => {
    const onSubmit = vi.fn();
    await renderOverlay(focusSpec, onSubmit);
    const other = host!.querySelector<HTMLInputElement>(".au-other")!;
    await act(async () => {
      setNativeInputValue(other, "仅作草稿保留的自定义方向");
      other.dispatchEvent(new Event("input", { bubbles: true }));
      other.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await click(host!.querySelector<HTMLInputElement>('input[type="radio"]')!);

    const appended: AskUserSpec = {
      ...focusSpec,
      questions: [
        ...focusSpec.questions,
        {
          id: "q-appended",
          header: "补充",
          label: "新追加的问题",
          kind: { kind: "text" },
          options: [],
          placeholder: null,
        },
      ],
    };
    await rerenderOverlay(appended, onSubmit);

    expect(host?.querySelector<HTMLInputElement>('input[type="radio"]')?.checked).toBe(true);
    expect(host?.querySelector<HTMLInputElement>(".au-other")?.dataset.active).toBe("false");
    expect(host?.querySelector('.auq-tab[data-answered="true"]')).not.toBeNull();
    expect(host?.querySelectorAll(".auq-tab")).toHaveLength(2);
    await click(findSubmitButton());
    expect(onSubmit).toHaveBeenCalledWith({
      "q-1": { chosen: ["warm"], freeText: null },
      "q-appended": { chosen: [], freeText: null },
    });
  });

  it("提交进度仅统计选择题，必答完成前禁用", async () => {
    await renderOverlay(mixedSpec);

    expect(host?.querySelector(".au-progress")?.textContent).toContain("0 / 1");
    expect(findSubmitButton().disabled).toBe(true);
    await click(host!.querySelector<HTMLInputElement>('input[type="radio"]')!);
    expect(host?.querySelector(".au-progress")?.textContent).toContain("1 / 1");
    expect(findSubmitButton().disabled).toBe(false);
  });

  it("preview 激活后按锚点 portal 右展开，关闭后移除", async () => {
    const workspace = document.createElement("div");
    workspace.id = "view-workspace";
    document.body.appendChild(workspace);
    const onClose = vi.fn();
    const spec: AskUserSpec = {
      ...focusSpec,
      id: "ask-preview",
      questions: [{
        ...focusSpec.questions[0]!,
        header: "文风",
        options: [
          { value: "warm", label: "温和", description: "柔和表达", preview: "## 温和样张" },
          { value: "sharp", label: "锐利", description: "直接表达", preview: "## 锐利样张" },
        ],
      }],
    };
    await render(
      <AskUserOverlay spec={spec} onClose={onClose} onSubmit={() => undefined} onAbort={() => undefined} />,
      workspace,
    );

    const portalOverlay = workspace.querySelector<HTMLElement>('.askuser-overlay[data-portal="true"]');
    expect(portalOverlay).not.toBeNull();
    expect(portalOverlay?.style.getPropertyValue("--au-portal-left")).toMatch(/px$/);
    expect(portalOverlay?.querySelector(".auq-preview")?.textContent).toContain("温和样张");
    const fixedOther = portalOverlay!.querySelector<HTMLElement>(".auq-other-wrap")!;
    expect(fixedOther.closest(".au-body-scroll")).toBeNull();
    expect(fixedOther.nextElementSibling?.classList.contains("au-foot")).toBe(true);
    const secondCard = portalOverlay!.querySelectorAll<HTMLElement>(".auq-card")[1]!;
    await act(async () => {
      secondCard.querySelector<HTMLInputElement>("input")!.focus();
    });
    expect(portalOverlay?.querySelector(".auq-preview")?.textContent).toContain("锐利样张");
    await click(secondCard.querySelector("input")!);
    expect(portalOverlay?.querySelector(".auq-preview")?.textContent).toContain("锐利样张");
    await click(portalOverlay!.querySelector<HTMLElement>(".au-x")!);
    expect(onClose).toHaveBeenCalledOnce();
    act(() => {
      root?.unmount();
      root = null;
    });
    expect(workspace.querySelector(".askuser-overlay")).toBeNull();
    workspace.remove();
  });

  it("切换 preview 时保留已挂载内容，避免 Mermaid 异步渲染期间空帧", async () => {
    const workspace = document.createElement("div");
    workspace.id = "view-workspace";
    document.body.appendChild(workspace);
    const spec: AskUserSpec = {
      ...focusSpec,
      id: "ask-preview-buffer",
      questions: [{
        ...focusSpec.questions[0]!,
        options: [
          { value: "warm", label: "温和", description: null, preview: "## 温和样张" },
          { value: "sharp", label: "锐利", description: null, preview: "## 锐利样张" },
        ],
      }],
    };
    await render(
      <AskUserOverlay spec={spec} onClose={() => undefined} onSubmit={() => undefined} onAbort={() => undefined} />,
      workspace,
    );

    const preview = workspace.querySelector(".auq-preview")!;
    const initialNodes = preview.querySelectorAll('[data-preview-key]');
    expect(initialNodes).toHaveLength(2);
    expect(initialNodes[0]?.getAttribute("data-active")).toBe("true");
    const firstRenderedNode = initialNodes[0];

    await act(async () => workspace.querySelectorAll<HTMLInputElement>('.wf-chip input')[1]!.focus());
    expect(preview.querySelectorAll('[data-preview-key]')).toHaveLength(2);
    expect(firstRenderedNode?.isConnected).toBe(true);
    expect(preview.querySelector('[data-preview-key="sharp"]')?.getAttribute("data-active")).toBe("true");
    workspace.remove();
  });

  it("预渲染 Mermaid 后反复切换命中缓存，不重复渲染", async () => {
    const workspace = document.createElement("div");
    workspace.id = "view-workspace";
    document.body.appendChild(workspace);
    const diagram = (id: string) => `\`\`\`mermaid\nflowchart LR\n${id}-->B\n\`\`\``;
    await render(<AskUserOverlay spec={{ ...focusSpec, id: "ask-preview-cache", questions: [{ ...focusSpec.questions[0]!, options: [
      { value: "a", label: "A", description: null, preview: diagram("A") },
      { value: "b", label: "B", description: null, preview: diagram("B") },
    ] }] }} onClose={() => undefined} onSubmit={() => undefined} onAbort={() => undefined} />, workspace);
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    const initialRenderCount = vi.mocked(renderMermaid).mock.calls.length;
    expect(initialRenderCount).toBeGreaterThanOrEqual(2);
    const inputs = workspace.querySelectorAll<HTMLInputElement>('.wf-chip input');
    await act(async () => inputs[1]!.focus());
    await act(async () => inputs[0]!.focus());
    await act(async () => inputs[1]!.focus());
    expect(renderMermaid).toHaveBeenCalledTimes(initialRenderCount);
    workspace.remove();
  });

  it("选项使用 roving tabindex；方向键移动高亮、Enter 选中且输入框不劫持", async () => {
    const workspace = document.createElement("div");
    workspace.id = "view-workspace";
    document.body.appendChild(workspace);
    await render(<AskUserOverlay spec={{ ...focusSpec, id: "ask-keyboard", questions: [{ ...focusSpec.questions[0]!, options: [
      { value: "warm", label: "温和", description: null, preview: "## 温和样张" },
      { value: "sharp", label: "锐利", description: null, preview: "## 锐利样张" },
    ] }] }} onClose={() => undefined} onSubmit={() => undefined} onAbort={() => undefined} />, workspace);
    const inputs = workspace.querySelectorAll<HTMLInputElement>('.wf-chip input');
    expect(inputs[0]?.tabIndex).toBe(0);
    expect(inputs[1]?.tabIndex).toBe(-1);
    inputs[0]!.focus();
    await act(async () => inputs[0]!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })));
    expect(document.activeElement).toBe(inputs[1]);
    expect(workspace.querySelector('[data-preview-key="sharp"]')?.getAttribute("data-active")).toBe("true");
    await act(async () => inputs[1]!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    expect(inputs[1]?.checked).toBe(true);
    const other = workspace.querySelector<HTMLInputElement>(".au-other")!;
    other.focus();
    await act(async () => other.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true })));
    expect(document.activeElement).toBe(other);
    workspace.remove();
  });

  it("无 preview 时首项可由 Tab 进入，方向键继续推进 roving tabindex", async () => {
    await renderOverlay(focusSpec);
    const inputs = host!.querySelectorAll<HTMLInputElement>('.wf-chip input');

    expect(inputs[0]?.tabIndex).toBe(0);
    expect(inputs[1]?.tabIndex).toBe(-1);

    inputs[0]!.focus();
    await act(async () => {
      inputs[0]!.dispatchEvent(new KeyboardEvent("keydown", {
        key: "ArrowDown",
        bubbles: true,
      }));
    });

    expect(document.activeElement).toBe(inputs[1]);
    expect(inputs[0]?.tabIndex).toBe(-1);
    expect(inputs[1]?.tabIndex).toBe(0);
  });

  it("无 preview 的题保持原窄浮层且不 portal", async () => {
    const workspace = document.createElement("div");
    workspace.id = "view-workspace";
    document.body.appendChild(workspace);
    await render(
      <AskUserOverlay spec={focusSpec} onClose={() => undefined} onSubmit={() => undefined} onAbort={() => undefined} />,
      workspace,
    );

    expect(host?.querySelector('.askuser-overlay[data-portal="false"]')).not.toBeNull();
    expect(workspace.querySelector('.askuser-overlay[data-portal="true"]')).toBeNull();
    workspace.remove();
  });

  it("滑块触顶显示 aboveLabel", async () => {
    await renderOverlay(mixedSpec);
    await click(host!.querySelectorAll<HTMLButtonElement>(".auq-tab")[1]!);
    const slider = host!.querySelector<HTMLInputElement>(".aus2-input")!;
    await act(async () => {
      setNativeInputValue(slider, "1200");
      slider.dispatchEvent(new Event("input", { bubbles: true }));
      slider.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(host?.querySelector(".aus2-bubble")?.textContent).toBe("1200 字以上");
  });
});

async function renderOverlay(spec: AskUserSpec, onSubmit = vi.fn()): Promise<void> {
  await render(
    <AskUserOverlay
      spec={spec}
      onClose={() => undefined}
      onSubmit={onSubmit}
      onAbort={() => undefined}
    />,
  );
}

async function rerenderOverlay(spec: AskUserSpec, onSubmit = vi.fn()): Promise<void> {
  await act(async () => {
    root?.render(
      <AskUserOverlay
        spec={spec}
        onClose={() => undefined}
        onSubmit={onSubmit}
        onAbort={() => undefined}
      />,
    );
  });
}

async function render(element: ReactNode, parent: HTMLElement = document.body): Promise<void> {
  host = document.createElement("div");
  parent.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(element);
  });
}

async function click(element: HTMLElement): Promise<void> {
  await act(async () => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
}

async function keyDown(
  element: HTMLElement,
  key: string,
  init: KeyboardEventInit = {},
): Promise<void> {
  await act(async () => {
    element.dispatchEvent(new KeyboardEvent("keydown", {
      key,
      bubbles: true,
      cancelable: true,
      ...init,
    }));
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  });
}

async function inputText(input: HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    input.focus();
    setNativeInputValue(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

function findSubmitButton(): HTMLButtonElement {
  const button = Array.from(host?.querySelectorAll<HTMLButtonElement>("button") ?? []).find(
    (item) => item.textContent?.trim() === "提交",
  );
  if (!button) throw new Error("提交按钮不存在");
  return button;
}

function setNativeInputValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  setter?.call(input, value);
}
