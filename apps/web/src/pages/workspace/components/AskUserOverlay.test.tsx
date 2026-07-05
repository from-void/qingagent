// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AskUserSpec } from "../data/protocol";
import { AskUserOverlay } from "./AskUserOverlay";

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
      options: [{ value: "warm", label: "温和", description: null, preview: null }],
      placeholder: null,
    },
  ],
};

const mixedSpec: AskUserSpec = {
  id: "ask-mixed",
  mode: { kind: "overlay" },
  purpose: null,
  source: null,
  rationale: null,
  questions: [
    {
      id: "q-single",
      label: "选一个方向",
      kind: { kind: "single" },
      options: [{ value: "a", label: "方向 A", description: null, preview: null }],
      placeholder: null,
    },
    {
      id: "q-slider",
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
      label: "补充说明",
      kind: { kind: "text" },
      options: [],
      placeholder: "直接写",
    },
  ],
};

describe("AskUserOverlay", () => {
  afterEach(() => {
    if (root) {
      act(() => root?.unmount());
      root = null;
    }
    host?.remove();
    host = null;
  });

  it("renders a loading placeholder instead of an empty overlay for empty questions", async () => {
    const onSubmit = vi.fn();
    await render(
      <AskUserOverlay
        spec={emptySpec}
        onClose={() => undefined}
        onSubmit={onSubmit}
        onAbort={() => undefined}
      />,
    );

    expect(host?.querySelector('[data-wf="AskUserOverlay"]')).not.toBeNull();
    expect(host?.querySelector('[data-wf="AskUserLoading"]')).not.toBeNull();
    expect(host?.textContent ?? "").toContain("正在准备问题");
    expect(host?.textContent ?? "").toContain("手动输入");
    expect(findSubmitButton()?.disabled).toBe(true);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("opens focus inside the overlay and restores focus on unmount", async () => {
    const trigger = document.createElement("button");
    trigger.type = "button";
    trigger.textContent = "打开问卷";
    document.body.appendChild(trigger);
    trigger.focus();

    await render(
      <AskUserOverlay
        spec={focusSpec}
        onClose={() => undefined}
        onSubmit={() => undefined}
        onAbort={() => undefined}
      />,
    );

    const closeButton = host?.querySelector<HTMLButtonElement>(".au-x");
    expect(document.activeElement).toBe(closeButton);

    act(() => {
      root?.unmount();
      root = null;
    });

    expect(document.activeElement).toBe(trigger);
    trigger.remove();
  });

  it("blocks empty submit and submits after a meaningful required answer", async () => {
    const onSubmit = vi.fn();
    await render(
      <AskUserOverlay
        spec={focusSpec}
        onClose={() => undefined}
        onSubmit={onSubmit}
        onAbort={() => undefined}
      />,
    );

    const submitButton = findSubmitButton();
    expect(submitButton?.disabled).toBe(true);

    await act(async () => {
      submitButton?.click();
    });
    expect(onSubmit).not.toHaveBeenCalled();

    const radio = host?.querySelector<HTMLInputElement>('input[type="radio"]');
    await act(async () => {
      radio?.click();
    });

    const readySubmitButton = findSubmitButton();
    expect(readySubmitButton?.disabled).toBe(false);
    await act(async () => {
      readySubmitButton?.click();
    });

    expect(onSubmit).toHaveBeenCalledWith({
      "q-1": { chosen: ["warm"], freeText: null },
    });
  });

  it("renders question numbers and one fallback input for choice and slider questions", async () => {
    await render(
      <AskUserOverlay
        spec={mixedSpec}
        onClose={() => undefined}
        onSubmit={() => undefined}
        onAbort={() => undefined}
      />,
    );

    expect(host?.textContent ?? "").toContain("有问题待确认");
    expect(Array.from(host?.querySelectorAll(".au-q-num") ?? []).map((el) => el.textContent)).toEqual([
      "01",
      "02",
      "03",
    ]);
    expect(host?.querySelectorAll(".au-other")).toHaveLength(2);
    expect(host?.querySelectorAll(".au-text")).toHaveLength(1);
  });

  it("shows the slider aboveLabel when dragged to max", async () => {
    await render(
      <AskUserOverlay
        spec={mixedSpec}
        onClose={() => undefined}
        onSubmit={() => undefined}
        onAbort={() => undefined}
      />,
    );

    const slider = host?.querySelector<HTMLInputElement>(".au-slider-input");
    expect(slider).not.toBeNull();

    await act(async () => {
      setNativeInputValue(slider!, "1200");
      slider!.dispatchEvent(new Event("input", { bubbles: true }));
      slider!.dispatchEvent(new Event("change", { bubbles: true }));
    });

    expect(host?.querySelector(".au-slider-value")?.textContent).toBe("1200 字以上");
  });
});

async function render(element: ReactNode): Promise<void> {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(element);
  });
}

function findSubmitButton(): HTMLButtonElement | undefined {
  return Array.from(host?.querySelectorAll<HTMLButtonElement>("button") ?? []).find(
    (button) => button.textContent?.includes("提交"),
  );
}

function setNativeInputValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  setter?.call(input, value);
}
