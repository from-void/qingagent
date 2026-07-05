// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

// 可变持有体:每个用例改 caps / 复位 spy。vi.hoisted 保证在 vi.mock 工厂前就绪。
const h = vi.hoisted(() => ({
  caps: null as { skills: { mutationEnabled: boolean } } | null,
  skills: [] as Array<{
    name: string;
    description: string;
    label: string;
    summary: string;
    icon: string;
    source: "builtin" | "installed";
    userInvocable: boolean;
    placeholder?: string;
    config?: string;
    tools: string[];
    enabled: boolean;
  }>,
  details: new Map<string, {
    name: string;
    description: string;
    label: string;
    summary: string;
    icon: string;
    source: "builtin" | "installed";
    userInvocable: boolean;
    placeholder?: string;
    config?: string;
    tools: string[];
    enabled: boolean;
    body: string;
  }>(),
  installSkillMd: vi.fn(async (_md: string) => undefined),
  installZip: vi.fn(async (_file: File) => undefined),
  setSkillEnabled: vi.fn(async () => undefined),
  deleteSkill: vi.fn(async () => undefined),
  refresh: vi.fn(async () => undefined),
  getSkillDetail: vi.fn(),
}));

vi.mock("./useSkills", () => ({
  useSkills: () => ({
    skills: h.skills,
    loading: false,
    error: null,
    refresh: h.refresh,
    setSkillEnabled: h.setSkillEnabled,
    deleteSkill: h.deleteSkill,
    installSkillMd: h.installSkillMd,
    installZip: h.installZip,
    getSkillDetail: h.getSkillDetail,
  }),
}));

vi.mock("./SearchPanel", () => ({
  SearchPanel: () => <div data-wf="SearchPanelMock">搜索配置</div>,
}));

vi.mock("./VisionPanel", () => ({
  VisionPanel: () => <div data-wf="VisionPanelMock">视觉配置</div>,
}));

// 只覆盖 useClientCapabilities,其余 system 导出保持真实(SearchPanel/VisionPanel 仍可用)。
vi.mock("../../system", async (importActual) => ({
  ...(await importActual<Record<string, unknown>>()),
  useClientCapabilities: () => h.caps,
}));

import { SkillsPanel } from "./SkillsPanel";

let root: Root | null = null;
let host: HTMLDivElement | null = null;

async function render() {
  host = document.createElement("div");
  document.body.appendChild(host);
  await act(async () => {
    root = createRoot(host!);
    root.render(<SkillsPanel />);
  });
}

function q(sel: string): HTMLElement | null {
  return host?.querySelector<HTMLElement>(sel) ?? null;
}

describe("SkillsPanel 导入门控", () => {
  beforeEach(() => {
    h.skills = [];
    h.details.clear();
    h.installSkillMd.mockClear();
    h.installZip.mockClear();
    h.setSkillEnabled.mockClear();
    h.deleteSkill.mockClear();
    h.getSkillDetail.mockClear();
    h.getSkillDetail.mockImplementation(async (name: string) => {
      const detail = h.details.get(name);
      if (!detail) throw new Error("not found");
      return detail;
    });
  });

  afterEach(() => {
    if (root) {
      act(() => root?.unmount());
      root = null;
    }
    host?.remove();
    host = null;
    vi.restoreAllMocks();
  });

  it("mutationEnabled=false 时不渲染导入入口与文件选择器", async () => {
    h.caps = { skills: { mutationEnabled: false } };
    await render();
    expect(q('[data-wf="SkillImportCard"]')).toBeNull();
    expect(q('[data-wf="SkillImportInput"]')).toBeNull();
  });

  it("capabilities 未就绪(null)时同样不渲染导入入口", async () => {
    h.caps = null;
    await render();
    expect(q('[data-wf="SkillImportCard"]')).toBeNull();
  });

  it("mutationEnabled=true 时渲染导入入口与文件选择器", async () => {
    h.caps = { skills: { mutationEnabled: true } };
    await render();
    expect(q('[data-wf="SkillImportCard"]')).not.toBeNull();
    expect(q('[data-wf="SkillImportInput"]')).not.toBeNull();
  });

  it("选 .md 文件把全文交给 installSkillMd(后端单一真源取名)", async () => {
    h.caps = { skills: { mutationEnabled: true } };
    await render();
    const input = q('[data-wf="SkillImportInput"]') as HTMLInputElement;
    const md = "---\nname: demo-skill\ndescription: 演示\n---\n# demo";
    const file = new File([md], "demo.md", { type: "text/markdown" });
    // jsdom 环境下 Blob.text() 不稳,直接固定返回值,聚焦测「按后缀路由 + 透传全文」逻辑。
    Object.defineProperty(file, "text", { value: async () => md, configurable: true });
    Object.defineProperty(input, "files", { value: [file], configurable: true });
    await act(async () => {
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
    // handleImportFile 先 await file.text()(微任务)才调 installSkillMd,需再冲一拍。
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(h.installZip).not.toHaveBeenCalled();
    expect(h.installSkillMd).toHaveBeenCalledWith(md);
  });

  it("选 .zip 文件走 installZip", async () => {
    h.caps = { skills: { mutationEnabled: true } };
    await render();
    const input = q('[data-wf="SkillImportInput"]') as HTMLInputElement;
    const file = new File([new Uint8Array([0x50, 0x4b, 0x03, 0x04])], "pack.zip", {
      type: "application/zip",
    });
    Object.defineProperty(input, "files", { value: [file], configurable: true });
    await act(async () => {
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(h.installSkillMd).not.toHaveBeenCalled();
    expect(h.installZip).toHaveBeenCalledWith(file);
  });

  it("列表态只渲染技能网格和末尾导入卡，卡片使用 API 下发短名与 summary", async () => {
    h.caps = { skills: { mutationEnabled: true } };
    h.skills = sampleSkills();
    await render();

    expect(host?.textContent).toContain("停用后模型不再使用该技能；点击卡片查看详情。");
    expect(host?.textContent).toContain("联网搜");
    expect(host?.textContent).toContain("搜资料、核事实、找出处");
    expect(host?.textContent).toContain("读资料");
    expect(host?.textContent).not.toContain("配置搜索引擎");
    expect(host?.querySelector(".sk-card--span")).toBeNull();

    const cards = Array.from(host?.querySelectorAll<HTMLElement>(".sk-grid > .sk-card") ?? []);
    expect(cards.at(-1)?.dataset.wf).toBe("SkillImportCard");
  });

  it("点击卡片进入详情页，显示工具、配置区和去 frontmatter 的 SKILL.md 正文", async () => {
    h.caps = { skills: { mutationEnabled: true } };
    h.skills = sampleSkills();
    h.details.set("web-search", {
      ...h.skills[0]!,
      body: "# 联网搜索\n\n调用 `webSearch` 查资料。",
    });
    await render();

    const card = Array.from(host?.querySelectorAll<HTMLElement>(".sk-card") ?? []).find((node) =>
      node.textContent?.includes("联网搜"),
    );
    if (!card) throw new Error("web-search card not found");
    await act(async () => {
      card.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(h.getSkillDetail).toHaveBeenCalledWith("web-search");
    expect(host?.textContent).toContain("技能详情");
    expect(host?.textContent).toContain("引出工具：联网搜索");
    expect(host?.querySelector('[data-wf="SearchPanelMock"]')).not.toBeNull();
    expect(host?.querySelector('[data-wf="SkillDetailBody"]')?.textContent).toContain("联网搜索");
    expect(host?.querySelector('[data-wf="SkillDetailBody"]')?.textContent).not.toContain("---");
  });

  it("点击开关只启停，不进入详情页", async () => {
    h.caps = { skills: { mutationEnabled: true } };
    h.skills = sampleSkills();
    await render();

    const button = Array.from(host?.querySelectorAll<HTMLButtonElement>(".sk-toggle") ?? []).find((node) =>
      node.textContent?.includes("已启用"),
    );
    if (!button) throw new Error("toggle not found");
    await act(async () => {
      button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(h.setSkillEnabled).toHaveBeenCalledWith("web-search", false);
    expect(host?.textContent).not.toContain("技能详情");
  });

  it("开关键盘事件不冒泡打开详情页", async () => {
    h.caps = { skills: { mutationEnabled: true } };
    h.skills = sampleSkills();
    await render();

    const button = Array.from(host?.querySelectorAll<HTMLButtonElement>(".sk-toggle") ?? []).find((node) =>
      node.textContent?.includes("已启用"),
    );
    if (!button) throw new Error("toggle not found");
    await act(async () => {
      button.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });

    expect(h.getSkillDetail).not.toHaveBeenCalled();
    expect(host?.textContent).not.toContain("技能详情");
  });
});

function sampleSkills() {
  return [
    {
      name: "web-search",
      description: "联网调研话题",
      label: "联网搜",
      summary: "搜资料、核事实、找出处",
      icon: "search",
      source: "builtin" as const,
      userInvocable: true,
      placeholder: "搜索主题",
      config: "search-provider",
      tools: ["webSearch"],
      enabled: true,
    },
    {
      name: "materials",
      description: "读取并引用写作素材",
      label: "读资料",
      summary: "读取上传文件与资料库并引用",
      icon: "materials",
      source: "builtin" as const,
      userInvocable: false,
      tools: ["readDocument", "searchDocuments"],
      enabled: false,
    },
  ];
}
