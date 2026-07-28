// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it } from "vitest";
import { EditContextMenu } from "./EditContextMenu";
import { resetOverlayDismissStackForTest } from "./overlayDismissStack";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

let host: HTMLDivElement;
let root: Root;
let input: HTMLInputElement;
let plain: HTMLParagraphElement;

function menuNode(): HTMLElement | null {
  return document.querySelector('[data-wf="EditContextMenu"]');
}

function rightClick(target: Element): MouseEvent {
  const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
  act(() => {
    target.dispatchEvent(event);
  });
  return event;
}

beforeEach(() => {
  resetOverlayDismissStackForTest();
  host = document.createElement("div");
  document.body.appendChild(host);
  input = document.createElement("input");
  input.value = "文本";
  plain = document.createElement("p");
  plain.textContent = "普通段落";
  document.body.append(input, plain);
  root = createRoot(host);
  act(() => root.render(<EditContextMenu />));
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  input.remove();
  plain.remove();
});

it("输入框右键弹出自绘四项菜单并阻止默认(不再走原生菜单)", () => {
  const event = rightClick(input);

  expect(event.defaultPrevented).toBe(true);
  const labels = [...(menuNode()?.querySelectorAll(".wf-editmenu-item span:first-child") ?? [])].map(
    (node) => node.textContent,
  );
  expect(labels).toEqual(["剪切", "复制", "粘贴", "全选"]);
});

it("非编辑区域不接管，交回浏览器/桌面原生菜单", () => {
  const event = rightClick(plain);

  expect(event.defaultPrevented).toBe(false);
  expect(menuNode()).toBeNull();
});

it("Esc 关闭菜单", () => {
  rightClick(input);
  expect(menuNode()).not.toBeNull();

  act(() => {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  });
  expect(menuNode()).toBeNull();
});

it("点击菜单外部关闭菜单", () => {
  rightClick(input);
  expect(menuNode()).not.toBeNull();

  act(() => {
    plain.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
  });
  expect(menuNode()).toBeNull();
});

it("已被组件级右键菜单接管(defaultPrevented)时不抢", () => {
  const handler = (e: Event) => e.preventDefault();
  input.addEventListener("contextmenu", handler);
  rightClick(input);
  input.removeEventListener("contextmenu", handler);

  expect(menuNode()).toBeNull();
});
