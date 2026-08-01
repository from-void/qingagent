import { readFileSync } from "node:fs";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkspaceTooltip } from "../pages/workspace/components/WorkspaceTooltip";
import {
  SKILL_MENU_FULL_ROWS,
  SKILL_MENU_PEEK_HEIGHT,
  SkillMenu,
  type SkillMenuAction,
} from "./SkillMenu";

let host: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(() => {
  if (root) {
    act(() => root?.unmount());
    root = null;
  }
  host?.remove();
  host = null;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("SkillMenu 半行滚动暗示", () => {
  it("项目多时精确显示 7.5 行，最后可见项截半", () => {
    renderMenu(SKILL_MENU_FULL_ROWS + 1);

    const menu = getMenu();
    const pixelCap = Number(menu.style.maxHeight.match(/,\s*([\d.]+)px\)/)?.[1]);
    expect(pixelCap).toBe(258.75);
    expect(pixelCap).toBe(SKILL_MENU_PEEK_HEIGHT);
    expect(menu.style.maxHeight).toContain("60vh");
    expect(menu.querySelectorAll(".qa-skill-row")).toHaveLength(8);
  });

  it("项目不超过完整可容纳数时完整展示且不设置限高", () => {
    renderMenu(SKILL_MENU_FULL_ROWS);

    const menu = getMenu();
    expect(menu.style.maxHeight).toBe("");
    expect(menu.querySelectorAll(".qa-skill-row")).toHaveLength(SKILL_MENU_FULL_ROWS);
  });
});

describe("SkillMenu 横向收缩与完整说明", () => {
  const longDescription = "查询自己的考勤打卡记录并展示完整的异常状态、上下班时间与详细说明";

  it("超长名称与说明不会撑宽菜单，且只给截断行挂完整说明", () => {
    mockLongRowLayout();
    renderActions([
      {
        id: "lark-attendance",
        label: "lark-attendance-超长考勤记录查询技能",
        description: longDescription,
        placeholder: "",
        icon: "star",
      },
    ]);

    const menu = getMenu();
    const row = menu.querySelector<HTMLButtonElement>(".qa-skill-row");
    const description = menu.querySelector<HTMLElement>(".qa-skill-desc");
    if (!row || !description) throw new Error("技能行未渲染");

    expect(menu.scrollWidth).toBe(menu.clientWidth);
    expect(description.scrollWidth).toBeGreaterThan(description.clientWidth);
    expect(row.getAttribute("title")).toBe(longDescription);

    const css = readFileSync(`${process.cwd()}/src/system/skill-menu.css`, "utf8");
    expect(cssRule(css, ".qa-skill-menu")).toContain("overflow-x: hidden");
    expect(cssRule(css, ".qa-skill-menu")).toContain("max-width: calc(100vw - 48px)");
    expect(cssRule(css, ".qa-skill-row")).toContain("min-width: 0");
    expect(cssRule(css, ".qa-skill-row")).toContain("overflow: hidden");
    expect(cssRule(css, ".qa-skill-name")).toContain("flex: 0 1 auto");
    expect(cssRule(css, ".qa-skill-name")).toContain("min-width: 0");
    expect(cssRule(css, ".qa-skill-desc")).toContain("min-width: 0");
  });

  it("未截断说明不挂 tooltip", () => {
    mockElementWidth("qa-skill-desc", { clientWidth: 160, scrollWidth: 160 });
    renderActions([
      {
        id: "short",
        label: "短技能",
        description: "短说明",
        placeholder: "",
        icon: "star",
      },
    ]);

    expect(getMenu().querySelector(".qa-skill-row")?.hasAttribute("title")).toBe(false);
  });

  it("hover 截断行时统一 tooltip 展示完整说明", () => {
    vi.useFakeTimers();
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback: FrameRequestCallback) =>
      window.setTimeout(() => callback(0), 16),
    );
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id: number) => {
      window.clearTimeout(id);
    });
    mockLongRowLayout();
    renderActions([
      {
        id: "lark-event",
        label: "lark-event",
        description: longDescription,
        placeholder: "",
        icon: "star",
      },
    ], true);

    const row = getMenu().querySelector<HTMLButtonElement>(".qa-skill-row");
    if (!row) throw new Error("技能行未渲染");
    act(() => {
      row.dispatchEvent(new MouseEvent("pointerover", { bubbles: true }));
      vi.advanceTimersByTime(160);
    });

    expect(host?.querySelector('[role="tooltip"]')?.textContent).toBe(longDescription);
  });

  it("键盘高亮、鼠标跟随与点击选择保持原行为", () => {
    const onPick = vi.fn();
    const onHoverIndex = vi.fn();
    renderActions([
      {
        id: "lark-event",
        label: "lark-event",
        description: "监听实时事件",
        placeholder: "",
        icon: "star",
      },
    ], false, { selectedIndex: 0, onPick, onHoverIndex });

    const row = getMenu().querySelector<HTMLButtonElement>(".qa-skill-row");
    if (!row) throw new Error("技能行未渲染");
    expect(row.classList.contains("is-active")).toBe(true);

    act(() => {
      row.dispatchEvent(new MouseEvent("mousemove", { bubbles: true }));
      row.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    });
    expect(onHoverIndex).toHaveBeenCalledWith(0);
    expect(onPick).toHaveBeenCalledWith(expect.objectContaining({ id: "lark-event" }));
  });
});

function renderMenu(count: number): void {
  renderActions(
    Array.from({ length: count }, (_, index): SkillMenuAction => ({
      id: `skill-${index}`,
      label: `技能 ${index + 1}`,
      description: "说明",
      placeholder: "",
      icon: "star",
    })),
  );
}

function renderActions(
  actions: SkillMenuAction[],
  withTooltip = false,
  props: {
    selectedIndex?: number;
    onPick?: (action: SkillMenuAction) => void;
    onHoverIndex?: (index: number) => void;
  } = {},
): void {
  host = document.createElement("div");
  if (withTooltip) host.id = "view-workspace";
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => {
    root?.render(
      <>
        <SkillMenu
          actions={actions}
          onPick={props.onPick ?? (() => undefined)}
          selectedIndex={props.selectedIndex}
          onHoverIndex={props.onHoverIndex}
        />
        {withTooltip ? <WorkspaceTooltip /> : null}
      </>,
    );
  });
}

function getMenu(): HTMLDivElement {
  const menu = host?.querySelector<HTMLDivElement>(".qa-skill-menu");
  if (!menu) throw new Error("技能菜单未渲染");
  return menu;
}

function mockLongRowLayout(): void {
  mockElementWidth("qa-skill-menu", { clientWidth: 260, scrollWidth: 260 });
  mockElementWidth("qa-skill-row", { clientWidth: 250, scrollWidth: 250 });
  mockElementWidth("qa-skill-desc", { clientWidth: 96, scrollWidth: 384 });
}

function mockElementWidth(
  className: string,
  width: { clientWidth: number; scrollWidth: number },
): void {
  const clientWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientWidth")?.get;
  const scrollWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollWidth")?.get;

  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(function (this: HTMLElement) {
    return this.classList.contains(className) ? width.clientWidth : (clientWidth?.call(this) ?? 0);
  });
  vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockImplementation(function (this: HTMLElement) {
    return this.classList.contains(className) ? width.scrollWidth : (scrollWidth?.call(this) ?? 0);
  });
}

function cssRule(css: string, selector: string): string {
  const start = css.indexOf(`${selector} {`);
  if (start < 0) throw new Error(`CSS selector not found: ${selector}`);
  const end = css.indexOf("}", start);
  return css.slice(start, end + 1);
}
