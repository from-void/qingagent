import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SKILL_USAGE_STORAGE_KEY } from "../../../system/skillUsage";
import { ChatInput } from "./ChatInput";

let host: HTMLDivElement | null = null;
let root: Root | null = null;
const skillMenuCss = readFileSync("src/system/skill-menu.css", "utf8");

const skillIds = ["write", "search", "calculate", "diagram"];

describe("技能菜单自适应排序", () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(JSON.stringify({
        skills: skillIds.map((name) => ({
          name,
          description: `${name} description`,
          label: name,
          summary: `${name} summary`,
          icon: "star",
          source: "builtin",
          userInvocable: true,
          tools: [],
          enabled: true,
          children: [],
        })),
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    ));
  });

  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    host?.remove();
    host = null;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("选用后下次打开才置顶，未用项保持初始顺序，并跨组件会话持久化", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(100);
    await mountInput();

    openMenu();
    expect(menuSkillIds()).toEqual(skillIds);

    pickSkill("calculate");
    expect(document.querySelector('[data-wf="SkillMenu"]')).toBeNull();
    const storedAfterFirstPick = JSON.parse(
      window.localStorage.getItem(SKILL_USAGE_STORAGE_KEY) ?? "{}",
    );
    expect(storedAfterFirstPick.calculate).toEqual({
      count: 1,
      lastUsedAt: 100,
    });

    openMenu();
    expect(menuSkillIds()).toEqual(["calculate", "write", "search", "diagram"]);

    now.mockReturnValue(200);
    pickSkill("search");
    openMenu();
    expect(menuSkillIds()).toEqual(["search", "calculate", "write", "diagram"]);

    await unmountInput();
    await mountInput();
    openMenu();
    expect(menuSkillIds()).toEqual(["search", "calculate", "write", "diagram"]);
  });

  it("损坏或夹杂无效项的持久化数据不会破坏内置顺序", async () => {
    window.localStorage.setItem(
      SKILL_USAGE_STORAGE_KEY,
      JSON.stringify({
        write: { count: "很多", lastUsedAt: 999 },
        search: { count: 1, lastUsedAt: -1 },
        calculate: null,
      }),
    );
    await mountInput();
    openMenu();

    expect(menuSkillIds()).toEqual(skillIds);
  });
});

describe("技能菜单滚动样式", () => {
  it("预留稳定细滚动条并以 border-box 精确计算限高", () => {
    expect(skillMenuCss).toContain("box-sizing: border-box");
    expect(skillMenuCss).toContain("overflow-y: auto");
    expect(skillMenuCss).toContain("scrollbar-gutter: stable");
    expect(skillMenuCss).toContain("scrollbar-width: thin");
  });
});

async function mountInput(): Promise<void> {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(
      <ChatInput
        folderSource={null}
        folderCapability={{ enabled: true, reason: null }}
        onAttachFolder={async () => undefined}
        onDetachFolder={async () => undefined}
        placeholder="输入"
        onSubmit={() => undefined}
      />,
    );
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

async function unmountInput(): Promise<void> {
  await act(async () => root?.unmount());
  root = null;
  host?.remove();
  host = null;
}

function openMenu(): void {
  const button = host?.querySelector<HTMLButtonElement>('[data-wf="WsSkillBtn"]');
  if (!button) throw new Error("技能按钮未渲染");
  act(() => button.dispatchEvent(new MouseEvent("click", { bubbles: true })));
}

function pickSkill(id: string): void {
  const row = Array.from(
    host?.querySelectorAll<HTMLButtonElement>(".qa-skill-row") ?? [],
  ).find((element) => element.textContent?.includes(id));
  if (!row) throw new Error(`技能行未渲染: ${id}`);
  act(() => row.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })));
}

function menuSkillIds(): string[] {
  return Array.from(
    host?.querySelectorAll<HTMLElement>(".qa-skill-name") ?? [],
  ).map((element) => element.textContent ?? "");
}
