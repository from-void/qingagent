// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TableSizePicker } from "../../components/doc/TableSizePicker";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  document.body.innerHTML = "";
});

describe("TableSizePicker", () => {
  it("pointer 移动实时高亮 rows×cols，点击确认", async () => {
    const { onSelect } = await renderPicker();
    const target = document.querySelector<HTMLElement>('[data-row="3"][data-col="4"]')!;

    await act(async () => {
      target.dispatchEvent(new MouseEvent("pointermove", { bubbles: true }));
    });
    expect(document.querySelector("output")?.textContent).toBe("3 x 4");
    expect(document.querySelectorAll('[data-table-size-cell].is-active')).toHaveLength(12);

    await act(async () => target.click());
    expect(onSelect).toHaveBeenCalledWith({ rows: 3, cols: 4 });
  });

  it("方向键调整尺寸，Enter 确认，Esc 关闭", async () => {
    const { onSelect, onClose } = await renderPicker(true);
    const picker = document.querySelector<HTMLElement>(".table-size-picker")!;
    expect(document.activeElement).toBe(picker);

    await act(async () => {
      for (const key of ["ArrowRight", "ArrowRight", "ArrowDown", "Enter"]) {
        picker.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
      }
    });
    expect(onSelect).toHaveBeenCalledWith({ rows: 2, cols: 3 });

    await act(async () => {
      picker.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    });
    expect(onClose).toHaveBeenCalledOnce();
  });
});

async function renderPicker(autoFocus = false) {
  const anchor = document.createElement("button");
  document.body.appendChild(anchor);
  vi.spyOn(anchor, "getBoundingClientRect").mockReturnValue({
    x: 20,
    y: 30,
    top: 30,
    right: 100,
    bottom: 54,
    left: 20,
    width: 80,
    height: 24,
    toJSON: () => ({}),
  });
  const host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  const onSelect = vi.fn();
  const onClose = vi.fn();
  await act(async () => {
    root?.render(<TableSizePicker anchor={anchor} autoFocus={autoFocus} onSelect={onSelect} onClose={onClose} />);
  });
  return { onSelect, onClose };
}
