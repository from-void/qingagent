// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  open: vi.fn(),
  skill: {
    name: "feishu", label: "连飞书", description: "连接飞书", summary: "代你操作飞书",
    icon: "star", source: "builtin", userInvocable: true, tools: ["lark-cli"], enabled: true,
    connectorId: "feishu",
  } as const,
  setSkillEnabled: vi.fn(), deleteSkill: vi.fn(), installSkillMd: vi.fn(), installZip: vi.fn(),
  setSkillLabel: vi.fn(),
  getSkillDetail: vi.fn(),
}));

vi.mock("./useSkills", () => ({
  useSkills: () => ({
    skills: [h.skill], loading: false, error: null,
    setSkillEnabled: h.setSkillEnabled, deleteSkill: h.deleteSkill,
    installSkillMd: h.installSkillMd, installZip: h.installZip,
    setSkillLabel: h.setSkillLabel, getSkillDetail: h.getSkillDetail,
  }),
}));
vi.mock("../../system", async (original) => ({
  ...await original<Record<string, unknown>>(),
  useClientCapabilities: () => ({ skills: { mutationEnabled: false } }),
  useConfirm: () => vi.fn(async () => true),
}));
vi.mock("../../system/ToastProvider", async (original) => ({
  ...await original<Record<string, unknown>>(),
  useToast: () => ({ show: vi.fn() }),
}));

import { SkillsPanel } from "./SkillsPanel";

describe("SkillsPanel 连接依赖", () => {
  let root: Root;
  let host: HTMLDivElement;
  afterEach(() => {
    act(() => root?.unmount());
    host?.remove();
    vi.clearAllMocks();
  });

  it("卡片与详情都有依赖行，点击切到对应连接详情", async () => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    h.getSkillDetail.mockResolvedValue({ ...h.skill, body: "# 飞书" });
    act(() => root.render(<SkillsPanel onOpenConnector={h.open} />));
    const dep = host.querySelector<HTMLButtonElement>(".sk-dep")!;
    expect(dep.textContent).toContain("依赖连接：飞书");
    act(() => dep.click());
    expect(h.open).toHaveBeenCalledWith("feishu");

    act(() => host.querySelector<HTMLElement>(".sk-card")!.click());
    await act(async () => { await Promise.resolve(); });
    expect(host.querySelector(".sk-detail-hero")).toBeTruthy();
    expect(host.querySelector(".sk-dep")?.textContent).toContain("依赖连接：飞书");
  });
});
