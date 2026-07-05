// @vitest-environment jsdom

import { act } from "react";
import type { ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfirmProvider } from "../../../system/ConfirmProvider";
import { WholeDocReviewNav } from "./WholeDocReviewNav";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement | null = null;

describe("WholeDocReviewNav", () => {
  afterEach(() => {
    if (root) {
      act(() => root?.unmount());
      root = null;
    }
    host?.remove();
    host = null;
    vi.restoreAllMocks();
  });

  it("确认弹层返回时审阅作用域已变化则不执行退回", async () => {
    const onRevert = vi.fn();

    await renderReviewNav("session-a:doc-a", onRevert);
    await click(buttonByText("退回旧版"));
    expect(confirmText()).toContain("退回旧版？");

    await renderReviewNav("session-b:doc-b", onRevert);
    expect(confirmText()).toContain("退回旧版？");

    await click(confirmButtonByText("退回旧版"));
    await flushMicrotasks();

    expect(onRevert).not.toHaveBeenCalled();
  });

  it("确认弹层返回时审阅作用域未变化才执行退回", async () => {
    const onRevert = vi.fn();

    await renderReviewNav("session-a:doc-a", onRevert);
    await click(buttonByText("退回旧版"));
    await click(confirmButtonByText("退回旧版"));
    await flushMicrotasks();

    expect(onRevert).toHaveBeenCalledTimes(1);
  });
});

async function renderReviewNav(reviewScopeKey: string, onRevert: () => void): Promise<void> {
  await render(
    <ConfirmProvider>
      <section id="view-workspace">
        <WholeDocReviewNav
          reviewScopeKey={reviewScopeKey}
          version="new"
          onVersionChange={() => {}}
          onApply={() => {}}
          onRevert={onRevert}
        />
      </section>
    </ConfirmProvider>,
  );
}

async function render(element: ReactNode): Promise<void> {
  if (!host) {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  }
  await act(async () => {
    root?.render(element);
  });
}

async function click(button: HTMLButtonElement): Promise<void> {
  await act(async () => {
    button.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
}

async function flushMicrotasks(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

function buttonByText(text: string): HTMLButtonElement {
  const button = Array.from(document.querySelectorAll("button")).find(
    (candidate) => candidate.textContent === text,
  );
  if (!(button instanceof HTMLButtonElement)) throw new Error(`button not found: ${text}`);
  return button;
}

function confirmButtonByText(text: string): HTMLButtonElement {
  const button = Array.from(
    host?.querySelectorAll('[data-wf="GlobalConfirm"] button') ?? [],
  ).find((candidate) => candidate.textContent === text);
  if (!(button instanceof HTMLButtonElement)) throw new Error(`confirm button not found: ${text}`);
  return button;
}

function confirmText(): string {
  return host?.querySelector('[data-wf="GlobalConfirm"]')?.textContent ?? "";
}
