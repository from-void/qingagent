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
