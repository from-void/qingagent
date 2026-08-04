import type { KeyboardEvent, ReactElement } from "react";
import { Modal } from "./Modal.js";

function testModalKeyboardClose(): void {
  let closeCount = 0;
  const modal = Modal({ open: true, title: "标题", onClose: () => closeCount += 1 });
  const card = childElements(modal)[0]!;
  const head = childElements(card)[0]!;
  const close = childElements(head)[1]!;
  const onKeyDown = close.props.onKeyDown as (event: KeyboardEvent<HTMLSpanElement>) => void;

  for (const key of ["Enter", " "]) {
    let prevented = false;
    onKeyDown({
      key,
      preventDefault: () => prevented = true,
    } as unknown as KeyboardEvent<HTMLSpanElement>);
    assertEqual(prevented, true);
  }
  assertEqual(closeCount, 2);

  onKeyDown({
    key: "Escape",
    preventDefault: () => { throw new Error("不应阻止其他按键"); },
  } as unknown as KeyboardEvent<HTMLSpanElement>);
  assertEqual(closeCount, 2);
}

function childElements(element: ReactElement): ReactElement[] {
  const children = element.props.children as ReactElement | ReactElement[];
  return Array.isArray(children) ? children.filter(Boolean) : [children];
}

function assertEqual(actual: unknown, expected: unknown): void {
  if (actual !== expected) {
    throw new Error(`断言失败:期望 ${String(expected)},实际 ${String(actual)}`);
  }
}

testModalKeyboardClose();
