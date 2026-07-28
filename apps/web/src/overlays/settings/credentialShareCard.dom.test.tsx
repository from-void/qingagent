// @vitest-environment jsdom
//
// 防再裸奔:凭证共享确认卡必须以设置层正规弹层形态呈现——有遮罩、有带皮肤的卡片容器、
// 按钮是 affirm/secondary 而不是原生白底钮。曾经因为直接复用 workspace 的 ConfirmOverlay
// (它整份 CSS 都挂在 #view-workspace 下)而渲染成纯裸 DOM,这里逐条钉住。
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const h = vi.hoisted(() => ({
  pending: [] as unknown[],
  setSkillEnabled: vi.fn(async () => h.pending),
  updateCredentialShare: vi.fn(async () => undefined),
}));

const skill = {
  name: "feishu",
  description: "飞书全平台代操作",
  label: "连飞书",
  summary: "授权后代操作你的飞书",
  icon: "feishu",
  source: "builtin" as const,
  userInvocable: true,
  tools: [],
  enabled: false,
  children: [],
};

vi.mock("./useSkills", () => ({
  useSkills: () => ({
    skills: [skill],
    loading: false,
    error: null,
    refresh: vi.fn(async () => undefined),
    setSkillEnabled: h.setSkillEnabled,
    deleteSkill: vi.fn(async () => undefined),
    installSkillMd: vi.fn(),
    installZip: vi.fn(),
    setSkillLabel: vi.fn(),
    getSkillDetail: vi.fn(async () => ({ ...skill, body: "" })),
  }),
}));

vi.mock("./SearchPanel", () => ({ SearchPanel: () => <div /> }));
vi.mock("./VisionPanel", () => ({ VisionPanel: () => <div /> }));

// buildCredentialShareSpec 保持真实:文案是单一真源,测试要验的正是它被正确渲染。
vi.mock("./credentialShare", async (importActual) => ({
  ...(await importActual<Record<string, unknown>>()),
  updateCredentialShare: h.updateCredentialShare,
}));

import { ConfirmProvider } from "../../system";
import { SkillsPanel } from "./SkillsPanel";

let root: Root | null = null;
let host: HTMLDivElement | null = null;

async function render(): Promise<void> {
  host = document.createElement("div");
  document.body.appendChild(host);
  await act(async () => {
    root = createRoot(host!);
    root.render(
      <ConfirmProvider>
        <SkillsPanel />
      </ConfirmProvider>,
    );
  });
}

async function enableSkill(): Promise<void> {
  const toggle = host?.querySelector<HTMLElement>(".sk-toggle");
  if (!toggle) throw new Error("skill toggle not found");
  await act(async () => {
    toggle.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function modal(): HTMLElement | null {
  return document.body.querySelector<HTMLElement>(".ws-folder-confirm-modal");
}

describe("凭证共享确认卡的形态", () => {
  beforeEach(() => {
    h.pending = [
      { skillName: "feishu", skillLabel: "连飞书", declared: "~/.lark-cli", granted: false, grantedAt: null },
    ];
    h.setSkillEnabled.mockClear();
    h.updateCredentialShare.mockClear();
  });

  afterEach(() => {
    if (root) {
      act(() => root?.unmount());
      root = null;
    }
    host?.remove();
    host = null;
  });

  it("以带遮罩的皮肤卡片呈现,而不是裸 DOM 串在技能网格下", async () => {
    await render();
    await enableSkill();

    const overlay = document.body.querySelector<HTMLElement>(".ws-folder-modal-overlay");
    expect(overlay).not.toBeNull();
    expect(overlay!.getAttribute("role")).toBe("dialog");
    expect(overlay!.getAttribute("aria-modal")).toBe("true");

    const card = modal();
    expect(card).not.toBeNull();
    // affirm 变体:授权不是删除,主按钮不能是 danger 的红。
    expect(card!.classList.contains("is-affirm")).toBe(true);
    // 卡片必须挂在遮罩容器里、且不在技能网格内(裸奔时它就直接串在网格下方)。
    expect(card!.parentElement).toBe(overlay);
    expect(host!.querySelector('[data-wf="SkillsPanel"] .ws-folder-confirm-modal')).toBeNull();
    expect(host!.querySelector(".settings-skills .ws-folder-confirm-modal")).toBeNull();
  });

  it("标题/路径/正文/脚注各就各位,路径走等宽行", async () => {
    await render();
    await enableSkill();
    const card = modal()!;
    expect(card.querySelector("h3")?.textContent).toBe("让「连飞书」用上你已登录的账号");
    const subject = card.querySelector(".ws-folder-confirm-subject");
    expect(subject?.textContent).toBe("~/.lark-cli");
    expect(card.textContent).toContain("和你在终端里就是同一个账号");
    expect(card.querySelector(".ws-folder-confirm-foot")?.textContent).toContain("随时收回");
  });

  it("按钮走弹层按钮体系:主按钮 affirm、次按钮 secondary,没有裸钮", async () => {
    await render();
    await enableSkill();
    const card = modal()!;
    const buttons = [...card.querySelectorAll<HTMLButtonElement>("button")];
    expect(buttons).toHaveLength(2);
    const [primary, secondary] = buttons;
    expect(primary!.className).toBe("ws-folder-modal-affirm");
    expect(primary!.textContent).toBe("允许共享");
    expect(secondary!.className).toBe("ws-folder-modal-secondary");
    expect(secondary!.textContent).toBe("暂不共享");
    // 任何一个没有 class 的按钮都是裸奔复发。
    for (const button of buttons) expect(button.className.trim()).not.toBe("");
    // 旧实现的 ✕ 关闭钮不再出现:有「暂不共享」就够。
    expect(card.querySelector(".cf-close")).toBeNull();
    expect(card.querySelector(".cf-overlay")).toBeNull();
  });

  it("点允许共享才落授权", async () => {
    await render();
    await enableSkill();
    const primary = modal()!.querySelector<HTMLButtonElement>(".ws-folder-modal-affirm")!;
    await act(async () => {
      primary.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(h.updateCredentialShare).toHaveBeenCalledWith({
      skillName: "feishu",
      declared: "~/.lark-cli",
      granted: true,
    });
  });

  it("点暂不共享与按 Esc 都只关掉卡,不落授权", async () => {
    await render();
    await enableSkill();
    const secondary = modal()!.querySelector<HTMLButtonElement>(".ws-folder-modal-secondary")!;
    await act(async () => {
      secondary.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(h.updateCredentialShare).not.toHaveBeenCalled();
    expect(modal()).toBeNull();

    await enableSkill();
    expect(modal()).not.toBeNull();
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(modal()).toBeNull();
    expect(h.updateCredentialShare).not.toHaveBeenCalled();
  });

  it("技能没有共享请求时不弹卡", async () => {
    h.pending = [];
    await render();
    await enableSkill();
    expect(modal()).toBeNull();
  });
});
