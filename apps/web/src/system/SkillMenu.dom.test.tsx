import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import {
  SKILL_MENU_FULL_ROWS,
  SKILL_MENU_PEEK_HEIGHT,
  SkillMenu,
  type SkillMenuAction,
} from "./SkillMenu";

let host: HTMLDivElement | null = null;

afterEach(() => {
  host?.remove();
  host = null;
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

function renderMenu(count: number): void {
  host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => {
    root.render(
      <SkillMenu
        actions={Array.from({ length: count }, (_, index): SkillMenuAction => ({
          id: `skill-${index}`,
          label: `技能 ${index + 1}`,
          description: "说明",
          placeholder: "",
          icon: "star",
        }))}
        onPick={() => undefined}
      />,
    );
  });
}

function getMenu(): HTMLDivElement {
  const menu = host?.querySelector<HTMLDivElement>(".qa-skill-menu");
  if (!menu) throw new Error("技能菜单未渲染");
  return menu;
}
