// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SkinSelect } from "./SkinSelect";

let root: Root;
let host: HTMLDivElement;

const options = [
  { value: "product", label: "互联网产品" },
  { value: "research", label: "研究分析" },
  { value: "operation", label: "运营增长" },
];

function key(target: Element, value: string) {
  act(() => {
    target.dispatchEvent(new KeyboardEvent("keydown", { key: value, bubbles: true }));
  });
}

describe("SkinSelect", () => {
  beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it("两套皮肤均使用自定义 combobox 与 portal 列表", () => {
    act(() => {
      root.render(
        <>
          <SkinSelect
            ariaLabel="暖纸分类"
            skin="paper"
            value="product"
            options={options}
            onChange={vi.fn()}
          />
          <SkinSelect
            ariaLabel="暗墨分类"
            skin="ink"
            value="research"
            options={options}
            onChange={vi.fn()}
          />
        </>,
      );
    });

    expect(host.querySelector("select")).toBeNull();
    expect(host.querySelector(".skin-select--paper")).not.toBeNull();
    expect(host.querySelector(".skin-select--ink")).not.toBeNull();

    const ink = host.querySelector('[aria-label="暗墨分类"]')!;
    act(() => ink.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(document.body.querySelector(".skin-select__menu--ink")).not.toBeNull();
  });

  it("方向键移动、回车选中，Esc 与点击外部关闭", () => {
    const onChange = vi.fn();
    act(() => {
      root.render(
        <SkinSelect
          ariaLabel="选择分类"
          skin="paper"
          value="product"
          options={options}
          onChange={onChange}
        />,
      );
    });
    const trigger = host.querySelector('[aria-label="选择分类"]')!;

    key(trigger, "ArrowDown");
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    key(trigger, "ArrowDown");
    key(trigger, "Enter");
    expect(onChange).toHaveBeenCalledWith("operation");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");

    key(trigger, "Enter");
    key(trigger, "Escape");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");

    key(trigger, "Enter");
    act(() => document.body.dispatchEvent(new Event("pointerdown", { bubbles: true })));
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
  });
});
