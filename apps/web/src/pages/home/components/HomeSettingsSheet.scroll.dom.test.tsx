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

vi.mock("../../../overlays/settings/SecurityPanel", () => ({
  SecurityPanel: () => <div>安全内容</div>,
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
  themeMode: "paper",
  themeModeOptions: [{ id: "paper", label: "宣纸" }],
  anim: "none",
  animOptions: [{ id: "none", label: "无" }],
  reduceMotion: false,
  primaryFont: "song",
  secondaryFont: "song",
  fontOptions: [{ id: "song", label: "宋体" }],
  onThemeModeChange: vi.fn(),
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
    const body = host!.querySelector<HTMLDivElement>(".qj-sheet-body")!;
    body.scrollTop = 420;

    clickTab("技能");
    expect(body.scrollTop).toBe(0);

    body.scrollTop = 90;
    clickTab("模型");
    expect(body.scrollTop).toBe(420);

    act(() => host!.querySelector<HTMLButtonElement>('button[aria-label="关闭"]')!.click());
    act(() => vi.advanceTimersByTime(700));
    expect(host!.querySelector(".qj-sheet-body")).toBeNull();

    open = true;
    act(renderSheet);
    expect(host!.querySelector<HTMLDivElement>(".qj-sheet-body")!.scrollTop).toBe(0);
  });
});
