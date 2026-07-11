// @vitest-environment jsdom

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AskUserSpec } from "../data/protocol";
import { BigPlanPanel, isBigPlanQuestionnaireReady } from "./BigPlanPanel";

let root: Root | null = null;
let host: HTMLDivElement | null = null;

describe("BigPlanPanel", () => {
  beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    if (root) {
      act(() => root?.unmount());
      root = null;
    }
    host?.remove();
    host = null;
    vi.restoreAllMocks();
  });

  it("问卷内容已可答时,即使上游 status 仍 running 也不显示生成中且可确认", async () => {
    const spec = answerableSpec();
    const onSubmit = vi.fn();
    await render(
      <BigPlanPanel
        toolCallId="test-plan-draft"
        spec={spec}
        isStreaming={!isBigPlanQuestionnaireReady(spec)}
        onSubmit={onSubmit}
        sessionId="s1"
        stream={null}
        onToast={vi.fn()}
      />,
    );

    expect(host?.textContent).not.toContain("问卷生成中");
    await click(optionButton("长文"));

    const confirm = buttonByText("确认方向");
    expect(confirm.disabled).toBe(false);
    await click(confirm);
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it("单选/多选题选项还没到齐时仍判定为未就绪", () => {
    const spec = answerableSpec();
    const pending = {
      ...spec,
      questions: [{ ...spec.questions[0]!, options: [] }],
    };

    expect(isBigPlanQuestionnaireReady(pending)).toBe(false);
  });

  it("自由输入聚焦和输入后仍保留选项且可以切回选项", async () => {
    const spec = answerableSpec();
    await render(
      <BigPlanPanel
        toolCallId="test-free-text"
        spec={spec}
        isStreaming={false}
        onSubmit={vi.fn()}
        sessionId="s1"
        stream={null}
        onToast={vi.fn()}
      />,
    );
    const other = host!.querySelector<HTMLInputElement>(".bp-other")!;

    await act(async () => {
      other.focus();
      setNativeInputValue(other, "补充说明");
      other.dispatchEvent(new Event("input", { bubbles: true }));
      other.dispatchEvent(new Event("change", { bubbles: true }));
      await Promise.resolve();
    });

    expect(host?.querySelectorAll(".bp-opt")).toHaveLength(2);
    await click(optionButton("长文"));
    expect(optionButton("长文").getAttribute("aria-pressed")).toBe("true");
  });
});

function answerableSpec(): AskUserSpec {
  return {
    id: "ask-ready",
    mode: { kind: "fullpage" },
    purpose: null,
    source: "确认方向",
    rationale: "先确认写作方向。",
    questions: [
      {
        id: "q-genre",
        label: "要写什么类型？",
        kind: { kind: "single" },
        options: [
          { value: "longform", label: "长文", description: null, preview: null },
          { value: "memo", label: "备忘", description: null, preview: null },
        ],
        placeholder: null,
        slider: null,
      },
    ],
  };
}

async function render(element: ReactNode): Promise<void> {
  await act(async () => {
    root?.render(element);
    await Promise.resolve();
  });
}

async function click(element: HTMLElement): Promise<void> {
  await act(async () => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    await Promise.resolve();
  });
}

function optionButton(text: string): HTMLButtonElement {
  return buttonByText(text);
}

function buttonByText(text: string): HTMLButtonElement {
  const button = Array.from(host?.querySelectorAll<HTMLButtonElement>("button") ?? []).find(
    (node) => node.textContent?.includes(text),
  );
  if (!button) throw new Error(`button not found: ${text}`);
  return button;
}

function setNativeInputValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  setter?.call(input, value);
}
