// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

interface MockSkillInfo {
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
  children?: MockSkillInfo[];
}

interface MockSkillDetail extends MockSkillInfo {
  body: string;
}

// 可变持有体:每个用例改 caps / 复位 spy。vi.hoisted 保证在 vi.mock 工厂前就绪。
const h = vi.hoisted(() => ({
  caps: null as { skills: { mutationEnabled: boolean } } | null,
  skills: [] as MockSkillInfo[],
  details: new Map<string, MockSkillDetail>(),
  installSkillMd: vi.fn(async (_md: string) => ({ name: "demo-skill" })),
  installZip: vi.fn(async (_file: File) => ({ name: "pack-skill" })),
  setSkillLabel: vi.fn(async (name: string, label: string) => ({
    name,
    description: "",
    label,
    summary: "",
    icon: "star",
    source: "installed" as "builtin" | "installed",
    userInvocable: true,
    tools: [] as string[],
    enabled: true,
    body: "",
  })),
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
    setSkillLabel: h.setSkillLabel,
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
    h.setSkillLabel.mockClear();
    h.setSkillEnabled.mockClear();
    h.deleteSkill.mockClear();
    h.getSkillDetail.mockClear();
    h.getSkillDetail.mockImplementation(async (name: string, childName?: string) => {
      const detail = h.details.get(childName ? `${name}/${childName}` : name);
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

  it("导入成功后自动进入新技能详情页", async () => {
    h.caps = { skills: { mutationEnabled: true } };
    h.installSkillMd.mockResolvedValueOnce({ name: "custom-research" });
    h.details.set("custom-research", {
      name: "custom-research",
      description: "自装研究技能",
      label: "研资料",
      summary: "整理用户资料",
      icon: "star",
      source: "installed",
      userInvocable: true,
      tools: [],
      enabled: true,
      body: "# 研资料\n\n导入后进入详情。",
    });
    await render();

    const input = q('[data-wf="SkillImportInput"]') as HTMLInputElement;
    const md = "---\nname: custom-research\ndescription: 自装研究技能\n---\n# 研资料";
    const file = new File([md], "custom.md", { type: "text/markdown" });
    Object.defineProperty(file, "text", { value: async () => md, configurable: true });
    Object.defineProperty(input, "files", { value: [file], configurable: true });
    await act(async () => {
      input.dispatchEvent(new Event("change", { bubbles: true }));
      await new Promise((r) => setTimeout(r, 0));
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(h.installSkillMd).toHaveBeenCalledWith(md);
    expect(h.getSkillDetail).toHaveBeenCalledWith("custom-research");
    expect(host?.textContent).toContain("技能详情");
    expect(host?.textContent).toContain("研资料");
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
    // 引出工具整段已从详情头部删除(用户判不重要)
    expect(host?.textContent).not.toContain("引出工具");
    expect(host?.textContent).toContain("内置");
    expect(host?.querySelector('[data-wf="SearchPanelMock"]')).not.toBeNull();
    expect(host?.querySelector('[data-wf="SkillDetailBody"]')?.textContent).toContain("联网搜索");
    expect(host?.querySelector('[data-wf="SkillDetailBody"]')?.textContent).not.toContain("---");
    expect(q('[data-wf="SkillLabelEdit"]')).toBeNull();
    expect(q('[data-wf="SkillLabelInput"]')).toBeNull();
    expect(q('[data-wf="SkillLabelSave"]')).toBeNull();
  });

  it("母技能外层只有单一进入动作，详情内嵌子技能并保持逐级返回与统一启停", async () => {
    h.caps = { skills: { mutationEnabled: true } };
    h.skills = [
      {
        name: "diagram-viz",
        description: "图表总技能",
        label: "图表可视化",
        summary: "判断是否画图并选择图表引擎",
        icon: "diagram",
        source: "builtin",
        userInvocable: true,
        tools: [],
        enabled: true,
        children: [
          {
            name: "drawio",
            description: "生成可编辑画布",
            label: "draw.io 图表",
            summary: "生成精确排版的可编辑画布",
            icon: "diagram",
            source: "builtin",
            userInvocable: false,
            tools: [],
            enabled: true,
            children: [],
          },
          {
            name: "mermaid",
            description: "生成自动布局图表",
            label: "Mermaid 图表",
            summary: "生成易维护的自动布局图表",
            icon: "star",
            source: "builtin",
            userInvocable: false,
            tools: [],
            enabled: true,
            children: [],
          },
        ],
      },
    ];
    h.details.set("diagram-viz", {
      ...h.skills[0]!,
      body: "# 图表可视化\n\n母技能正文。",
    });
    h.details.set("diagram-viz/drawio", {
      ...h.skills[0]!.children![0]!,
      body: "# draw.io 图表规范\n\n- 保持节点可编辑\n- 避免连线遮挡",
    });
    await render();

    const parentEntry = q('[data-wf="SkillEntry"]');
    expect(host?.querySelectorAll('[data-wf="SkillEntry"]')).toHaveLength(1);
    expect(q('[data-wf="SkillDetailEntry"]')).toBeNull();
    expect(q('[data-wf="SkillChildrenEntry"]')).toBeNull();
    // 列表卡不再挂子技能徽标(会把卡撑得高度不一);数量只在详情页披露
    expect(q('[data-wf="SkillChildrenBadge"]')).toBeNull();
    if (!parentEntry) throw new Error("parent skill entry not found");
    await act(async () => {
      parentEntry.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(h.getSkillDetail).toHaveBeenCalledWith("diagram-viz");
    expect(host?.textContent).toContain("母技能正文");
    expect(q('[data-wf="SkillChildren"]')).not.toBeNull();
    expect(host?.textContent).toContain("随母技能「图表可视化」统一启用或停用");
    expect(host?.textContent).toContain("draw.io 图表");
    expect(host?.textContent).toContain("生成精确排版的可编辑画布");
    expect(host?.textContent).toContain("Mermaid 图表");
    expect(host?.querySelectorAll(".sk-child-item .sk-card-icon")).toHaveLength(2);
    expect(host?.querySelectorAll('[data-wf="SkillChildEntry"]')).toHaveLength(2);

    const parentToggle = q(".sk-toggle");
    if (!parentToggle) throw new Error("parent toggle not found");
    await act(async () => {
      parentToggle.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(h.setSkillEnabled).toHaveBeenCalledWith("diagram-viz", false);

    const childEntry = Array.from(host?.querySelectorAll<HTMLElement>('[data-wf="SkillChildEntry"]') ?? [])
      .find((node) => node.textContent?.includes("draw.io 图表"));
    if (!childEntry) throw new Error("child skill entry not found");
    await act(async () => {
      childEntry.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(h.getSkillDetail).toHaveBeenCalledWith("diagram-viz", "drawio");
    expect(q('[data-wf="SkillChildDetail"]')).not.toBeNull();
    expect(q('[data-wf="SkillChildDetailBody"]')?.textContent).toContain("draw.io 图表规范");
    expect(q('[data-wf="SkillChildDetailBody"]')?.textContent).toContain("保持节点可编辑");
    expect(host?.textContent).toContain("子技能详情");
    expect(host?.textContent).toContain("技能正文(SKILL.md · 只读)");
    expect(host?.textContent).toContain("随母技能停用");
    expect(host?.textContent).toContain("此子技能不单独启停");
    expect(q(".sk-toggle")).toBeNull();
    expect(q(".sk-back")?.textContent).toContain("返回母技能");

    const backToParent = q(".sk-back");
    if (!backToParent) throw new Error("child back button not found");
    await act(async () => {
      backToParent.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(q('[data-wf="SkillChildDetail"]')).toBeNull();
    expect(q('[data-wf="SkillChildren"]')).not.toBeNull();
    expect(host?.textContent).toContain("母技能正文");
    expect(q(".sk-toggle")).not.toBeNull();

    const missingChildEntry = Array.from(
      host?.querySelectorAll<HTMLElement>('[data-wf="SkillChildEntry"]') ?? [],
    ).find((node) => node.textContent?.includes("Mermaid 图表"));
    if (!missingChildEntry) throw new Error("missing child skill entry not found");
    await act(async () => {
      missingChildEntry.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(h.getSkillDetail).toHaveBeenCalledWith("diagram-viz", "mermaid");
    expect(q('[data-wf="SkillChildDetailBody"]')?.textContent).toContain(
      "子技能正文暂时无法加载",
    );
    expect(q('[data-wf="SkillChildDetailBody"]')?.classList).not.toContain("sm-message");

    const backFromMissingChild = q(".sk-back");
    if (!backFromMissingChild) throw new Error("missing child back button not found");
    await act(async () => {
      backFromMissingChild.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    const backToList = q(".sk-back");
    if (!backToList) throw new Error("parent back button not found");
    await act(async () => {
      backToList.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(q('[data-wf="SkillChildren"]')).toBeNull();
    expect(q('[data-wf="SkillEntry"]')).not.toBeNull();
    expect(q('[data-wf="SkillChildrenBadge"]')).toBeNull();
  });

  it("自定义技能可从 hero 标题进入编辑并保存超长中文显示名，底层 slug 不变", async () => {
    h.caps = { skills: { mutationEnabled: true } };
    h.skills = [
      {
        name: "custom-research",
        description: "自装研究技能",
        label: "研资料",
        summary: "整理用户资料",
        icon: "star",
        source: "installed",
        userInvocable: true,
        tools: [],
        enabled: true,
      },
    ];
    h.details.set("custom-research", {
      ...h.skills[0]!,
      body: "# 研资料",
    });
    const longLabel = "这是一个很长很长的中文显示名用于确认保存后不会被截断";
    h.setSkillLabel.mockImplementationOnce(async (name: string, label: string) => ({
      ...h.skills[0]!,
      name,
      label,
      body: "# 研资料",
    }));
    await render();

    const card = Array.from(host?.querySelectorAll<HTMLElement>(".sk-card") ?? []).find((node) =>
      node.textContent?.includes("研资料"),
    );
    if (!card) throw new Error("custom skill card not found");
    await act(async () => {
      card.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await new Promise((r) => setTimeout(r, 0));
    });
    const edit = q('[data-wf="SkillLabelEdit"]') as HTMLButtonElement;
    expect(edit.textContent).toContain("研资料");
    await act(async () => {
      edit.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    const input = q('[data-wf="SkillLabelInput"]') as HTMLInputElement;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      setter?.call(input, longLabel);
      input.dispatchEvent(new Event("input", { bubbles: true }));
      await new Promise((r) => setTimeout(r, 0));
    });
    const save = q('[data-wf="SkillLabelSave"]') as HTMLButtonElement;
    expect(save.disabled).toBe(false);
    await act(async () => {
      save.closest("form")?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(h.setSkillLabel).toHaveBeenCalledWith("custom-research", longLabel);
    // 详情头部瘦身:标识/引出工具已删,只留名字+来源标+启用态
    expect(host?.textContent).not.toContain("标识：custom-research");
    expect(host?.textContent).toContain(longLabel);
  });

  it("自定义技能行内编辑按 Escape 取消且不保存", async () => {
    h.caps = { skills: { mutationEnabled: true } };
    h.skills = [
      {
        name: "custom-research",
        description: "自装研究技能",
        label: "研资料",
        summary: "整理用户资料",
        icon: "star",
        source: "installed",
        userInvocable: true,
        tools: [],
        enabled: true,
      },
    ];
    h.details.set("custom-research", {
      ...h.skills[0]!,
      body: "# 研资料",
    });
    await render();

    const card = q(".sk-card");
    if (!card) throw new Error("custom skill card not found");
    await act(async () => {
      card.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await new Promise((r) => setTimeout(r, 0));
    });
    await act(async () => {
      q('[data-wf="SkillLabelEdit"]')?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    const input = q('[data-wf="SkillLabelInput"]') as HTMLInputElement;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      setter?.call(input, "临时名字");
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });

    expect(h.setSkillLabel).not.toHaveBeenCalled();
    expect(q('[data-wf="SkillLabelInput"]')).toBeNull();
    expect(q('[data-wf="SkillLabelEdit"]')?.textContent).toContain("研资料");
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
