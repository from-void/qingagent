import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildDeaiReviewQuery, DeaiReviewModal } from "./DeaiReviewModal";

const templates = [
  { id: "deai-light", dtype: "deai", slot: "instruction" as const, name: "轻度去味", detail: "只清最重痕迹。整理自 Humanizer-zh 与 Wikipedia AI 写作特征清单。", prompt: "轻度规则", builtin: true },
  { id: "deai-deep", dtype: "deai", slot: "instruction" as const, name: "深度重写", detail: "全面检查。", prompt: "深度规则", builtin: true },
];

describe("DeaiReviewModal", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    host = document.createElement("div");
    host.id = "view-workspace";
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(() => { act(() => root.unmount()); host.remove(); });

  async function renderModal() {
    const loadTemplates = vi.fn().mockResolvedValue(templates);
    const loadTemplate = vi.fn().mockImplementation(async (id: string) => templates.find((item) => item.id === id));
    const saveTemplate = vi.fn().mockResolvedValue({ ...templates[0], id: "custom-1", name: "我的轻度", builtin: false });
    const onConfirm = vi.fn();
    await act(async () => root.render(<DeaiReviewModal open loadTemplates={loadTemplates} loadTemplate={loadTemplate} saveTemplate={saveTemplate} onClose={vi.fn()} onConfirm={onConfirm} />));
    return { loadTemplate, saveTemplate, onConfirm };
  }

  it("展示模板单选卡、补充输入框并提交所选模板", async () => {
    const { onConfirm } = await renderModal();
    expect(host.querySelectorAll('.ws-deai-template input[type="radio"]')).toHaveLength(2);
    expect(host.querySelector<HTMLInputElement>('input[type="radio"]')?.checked).toBe(true);
    const textarea = host.querySelector<HTMLTextAreaElement>(".ws-deai-supplement textarea")!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(textarea, "保留口号");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
    act(() => host.querySelector<HTMLButtonElement>(".ws-lexicon-actions button:last-child")?.click());
    expect(onConfirm).toHaveBeenCalledWith(templates[0], "保留口号");
  });

  it("按 chatInputBus 契约生成 query，无补充时省略补充字段", () => {
    expect(buildDeaiReviewQuery(templates[0]!, "")).toBe("对当前文档做去AI味处理,使用模板「轻度去味」(id: deai-light)");
    expect(buildDeaiReviewQuery(templates[0]!, "  保留口号  ")).toBe("对当前文档做去AI味处理,使用模板「轻度去味」(id: deai-light)。补充要求:保留口号");
  });

  it("二级详情可编辑并另存为个人模板", async () => {
    const { loadTemplate, saveTemplate } = await renderModal();
    await act(async () => host.querySelector<HTMLButtonElement>(".ws-lexicon-open")?.click());
    expect(loadTemplate).toHaveBeenCalledWith("deai-light");
    expect(host.querySelector(".ws-deai-source")?.textContent).toContain("Humanizer-zh");
    const prompt = host.querySelector<HTMLTextAreaElement>(".ws-deai-detail textarea")!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(prompt, "我的规则");
      prompt.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => host.querySelector<HTMLButtonElement>(".ws-deai-detail .ws-lexicon-actions button:last-child")?.click());
    expect(saveTemplate).toHaveBeenCalledWith(expect.objectContaining({ prompt: "我的规则" }));
    expect(host.querySelector<HTMLInputElement>('input[type="radio"]:checked')?.closest(".ws-deai-template")?.textContent).toContain("我的轻度");
  });
});
