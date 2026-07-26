// @vitest-environment jsdom

import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CalendarDatePicker } from "./CalendarDatePicker";

let root: Root;
let host: HTMLDivElement;

function Fixture() {
  const [value, setValue] = useState("");
  return (
    <CalendarDatePicker
      ariaLabel="筛选用量日期"
      skin="ink"
      value={value}
      max="2026-07-26"
      onChange={setValue}
    />
  );
}

function click(target: Element) {
  act(() => target.dispatchEvent(new MouseEvent("click", { bubbles: true })));
}

describe("CalendarDatePicker", () => {
  beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => root.render(<Fixture />));
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it("选择日期后更新触发器，并可在日历内清除", () => {
    const trigger = host.querySelector('[aria-label="筛选用量日期"]')!;
    expect(host.querySelector('input[type="date"]')).toBeNull();
    expect(host.querySelector(".skin-date--ink")).not.toBeNull();

    click(trigger);
    click(document.body.querySelector('[aria-label="2026-07-18"]')!);
    expect(trigger.textContent).toContain("2026-07-18");

    click(trigger);
    click(document.body.querySelector(".skin-calendar__clear")!);
    expect(trigger.textContent).toContain("选择日期");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
  });
});
