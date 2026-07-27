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

function MarkedDatesFixture() {
  const [value, setValue] = useState("");
  return (
    <CalendarDatePicker
      ariaLabel="筛选用量日期"
      skin="ink"
      value={value}
      max="2026-07-26"
      markedDates={new Set(["2026-07-18"])}
      onlyMarkedDatesSelectable
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

  it("渲染有消耗标记，并阻止选择无消耗日期", () => {
    act(() => root.render(<MarkedDatesFixture />));
    const trigger = host.querySelector('[aria-label="筛选用量日期"]')!;

    click(trigger);
    const markedDay = document.body.querySelector<HTMLButtonElement>('[aria-label="2026-07-18"]')!;
    const unmarkedDay = document.body.querySelector<HTMLButtonElement>('[aria-label="2026-07-19"]')!;
    expect(markedDay.querySelector(".skin-calendar__mark")).not.toBeNull();
    expect(markedDay.disabled).toBe(false);
    expect(unmarkedDay.querySelector(".skin-calendar__mark")).toBeNull();
    expect(unmarkedDay.disabled).toBe(true);

    click(unmarkedDay);
    expect(trigger.textContent).toContain("选择日期");
    expect(trigger.getAttribute("aria-expanded")).toBe("true");

    click(markedDay);
    expect(trigger.textContent).toContain("2026-07-18");
  });

  it("不传标记参数时仍可选择普通日期", () => {
    const trigger = host.querySelector('[aria-label="筛选用量日期"]')!;
    click(trigger);
    const ordinaryDay = document.body.querySelector<HTMLButtonElement>('[aria-label="2026-07-19"]')!;
    expect(ordinaryDay.disabled).toBe(false);

    click(ordinaryDay);
    expect(trigger.textContent).toContain("2026-07-19");
  });
});
