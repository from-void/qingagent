// @vitest-environment jsdom

import { act } from "react";
import type { ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfirmProvider, useConfirm } from "./ConfirmProvider";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement | null = null;

describe("ConfirmProvider", () => {
  afterEach(() => {
    if (root) {
      act(() => root?.unmount());
      root = null;
    }
    host?.remove();
    host = null;
    vi.restoreAllMocks();
  });

  it("把确认框挂到页面根，并按顺序处理连续 confirm", async () => {
    let settled: boolean[] | null = null;

    function Probe() {
      const confirm = useConfirm();
      return (
        <button
          type="button"
          onClick={() => {
            const first = confirm({
              title: "第一步确认",
              message: "先确认第一件事",
              confirmLabel: "确认第一步",
            });
            const second = confirm({
              title: "第二步确认",
              message: "再确认第二件事",
              confirmLabel: "确认第二步",
            });
            void Promise.all([first, second]).then((values) => {
              settled = values;
            });
          }}
        >
          触发
        </button>
      );
    }

    await render(
      <ConfirmProvider>
        <section id="view-workspace">
          <Probe />
        </section>
      </ConfirmProvider>,
    );

    await click(buttonByText("触发"));
    const view = mustQuery<HTMLElement>("#view-workspace");
    expect(view.querySelector('[data-wf="GlobalConfirm"]')?.textContent).toContain("第一步确认");
    expect(host?.querySelector('[data-wf="GlobalConfirm"]')?.textContent).toContain("第一步确认");

    await click(buttonByText("确认第一步"));
    expect(view.querySelector('[data-wf="GlobalConfirm"]')?.textContent).toContain("第二步确认");
    expect(settled).toBeNull();

    await click(buttonByText("取消"));
    await act(async () => {
      await Promise.resolve();
    });
    expect(settled).toEqual([true, false]);
    expect(view.querySelector('[data-wf="GlobalConfirm"]')).toBeNull();
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

async function click(button: HTMLButtonElement): Promise<void> {
  await act(async () => {
    button.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
}

function buttonByText(text: string): HTMLButtonElement {
  const button = Array.from(document.querySelectorAll("button"))
    .find((candidate) => candidate.textContent === text);
  if (!(button instanceof HTMLButtonElement)) throw new Error(`button not found: ${text}`);
  return button;
}

function mustQuery<T extends Element>(selector: string): T {
  const node = host?.querySelector<T>(selector);
  if (!node) throw new Error(`missing ${selector}`);
  return node;
}
