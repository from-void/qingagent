// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HomeSettingsSheet } from "./HomeSettingsSheet";

vi.mock("./settingsInkVariants", () => ({
  SettingsInkBackdrop: () => <div data-testid="ink-backdrop" />,
}));

vi.mock("../../../overlays/settings/ModelSettingsPanel", () => ({
  ModelSettingsPanel: () => <div>模型内容</div>,
}));

vi.mock("../../../overlays/settings/SkillsPanel", () => ({
  SkillsPanel: () => <div>技能内容</div>,
}));

vi.mock("../../../overlays/settings/ConnectionsPanel", () => ({
  ConnectionsPanel: () => <div>连接内容</div>,
}));

vi.mock("../../../overlays/settings/DshPanel", () => ({
  DshPanel: () => <div>DSH 插件内容</div>,
}));

vi.mock("../../../overlays/settings/SecurityPanel", () => ({
  SecurityPanel: () => <div>安全内容</div>,
}));

vi.mock("../../../overlays/settings/MemoryPanel", () => ({
  MemoryPanel: () => <div>记忆内容</div>,
}));

vi.mock("../../../overlays/settings/FeedbackPanel", () => ({
  FeedbackPanel: () => <div>反馈内容</div>,
}));

vi.mock("../../../overlays/settings/ShortcutsPanel", () => ({
  ShortcutsPanel: () => <div>快捷键内容</div>,
}));

vi.mock("../../../overlays/settings/AboutPanel", () => ({
  AboutPanel: () => <div>关于内容</div>,
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement | null = null;

const props = {
  inkVariant: "paper" as const,
  anim: "none",
  animOptions: [{ id: "none", label: "无" }],
  reduceMotion: false,
  primaryFont: "song",
  secondaryFont: "song",
  fontOptions: [{ id: "song", label: "宋体" }],
  onAnimChange: vi.fn(),
  onReduceMotionToggle: vi.fn(),
  onPrimaryFontChange: vi.fn(),
  onSecondaryFontChange: vi.fn(),
};

function clickTab(label: string) {
  const button = [...host!.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
    .find((candidate) => candidate.textContent === label);
  if (!button) throw new Error(`未找到设置 tab：${label}`);
  act(() => button.click());
}

describe("HomeSettingsSheet tab 滚动位置", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      callback(0);
      return 1;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    host?.remove();
    host = null;
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it("左栏不渲染 DSH 插件入口", () => {
    act(() => root?.render(<HomeSettingsSheet {...props} onClose={vi.fn()} />));

    const tabLabels = [...host!.querySelectorAll('[role="tab"]')]
      .map((tab) => tab.textContent);
    expect(tabLabels).not.toContain("DSH 插件");
  });

  it("初始 tab 为已隐藏的 dsh 时回落到默认 tab", () => {
    act(() => root?.render(
      <HomeSettingsSheet {...props} initialTab="dsh" onClose={vi.fn()} />,
    ));

    const modelTab = [...host!.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
      .find((tab) => tab.textContent === "模型");
    expect(modelTab?.getAttribute("aria-selected")).toBe("true");
    expect(host!.textContent).toContain("模型内容");
    expect(host!.textContent).not.toContain("DSH 插件内容");
  });

  it("各 tab 独立恢复，关闭卸载后重开全部回顶", () => {
    let open = true;
    const renderSheet = () => {
      root?.render(open ? (
        <HomeSettingsSheet
          {...props}
          onClose={() => {
            open = false;
            renderSheet();
          }}
        />
      ) : null);
    };

    act(renderSheet);
    expect([...host!.querySelectorAll('[role="tab"]')].some(
      (tab) => tab.textContent === "记忆",
    )).toBe(true);
    const tabLabels = [...host!.querySelectorAll('[role="tab"]')].map((tab) => tab.textContent);
    expect(tabLabels.slice(tabLabels.indexOf("连接"), tabLabels.indexOf("连接") + 2))
      .toEqual(["连接", "记忆"]);
    const body = host!.querySelector<HTMLDivElement>(".qj-sheet-body")!;
    body.scrollTop = 420;

    clickTab("技能");
    expect(body.scrollTop).toBe(0);

    clickTab("连接");
    expect(host!.textContent).toContain("连接内容");

    body.scrollTop = 90;
    clickTab("模型");
    expect(body.scrollTop).toBe(420);

    clickTab("记忆");
    expect(host!.textContent).toContain("记忆内容");

    act(() => host!.querySelector<HTMLButtonElement>('button[aria-label="关闭"]')!.click());
    act(() => vi.advanceTimersByTime(700));
    expect(host!.querySelector(".qj-sheet-body")).toBeNull();

    open = true;
    act(renderSheet);
    expect(host!.querySelector<HTMLDivElement>(".qj-sheet-body")!.scrollTop).toBe(0);
  });

  it("关闭动画尚未结束就卸载时不再触发 onClose", () => {
    const onClose = vi.fn();
    act(() => root?.render(<HomeSettingsSheet {...props} onClose={onClose} />));

    act(() => host!.querySelector<HTMLButtonElement>('button[aria-label="关闭"]')!.click());
    expect(host!.querySelector(".qj-sheet-backdrop")?.getAttribute("data-closing")).toBe("true");
    act(() => root?.unmount());
    root = null;
    act(() => vi.advanceTimersByTime(700));

    expect(onClose).not.toHaveBeenCalled();
  });
});
