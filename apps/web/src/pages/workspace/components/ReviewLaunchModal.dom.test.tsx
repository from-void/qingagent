import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatMessage, ReviewTemplateItem } from "@qingagent/contract-ts";
import { ReviewMenu } from "./ReviewMenu";
import { buildReviewActionCard, buildReviewContext, buildReviewQuery, ReviewLaunchModal } from "./ReviewLaunchModal";
import { assembleReviewQuery } from "@qingagent/contract-ts";
import { ChatMessageList } from "./ChatMessageList";
import { ROLE_REVIEW_PROFILES } from "./roleReview";
import { ConfirmProvider } from "../../../system";
import { registerOverlay, resetOverlayDismissStackForTest } from "../../../system/overlayDismissStack";

const now = "2026-07-14T00:00:00.000Z";
const builtins: ReviewTemplateItem[] = [
  { id: "source-default", type: "source", name: "标准来源核查", prompt: "核对事实、数字与出处。", builtin: true, createdAt: now, updatedAt: now },
  { id: "source-strict", type: "source", name: "严格来源核查", prompt: "逐字核对金额和日期。", builtin: false, createdAt: now, updatedAt: now },
];
const lexicons = [{ id: "lexicon-ad", name: "广告法极限词", description: "广告合规", entryCount: 2, enabled: true }];

describe("ReviewLaunchModal", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    host = document.createElement("div");
    host.id = "view-workspace";
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    resetOverlayDismissStackForTest();
    host.remove();
  });

  function props(overrides: Record<string, unknown> = {}) {
    return {
      open: true,
      type: "source" as const,
      loadTemplates: vi.fn().mockResolvedValue({ items: builtins, selectedTemplateId: builtins[0]!.id }),
      saveTemplate: vi.fn().mockImplementation(async (input: { id?: string; type: string; name: string; prompt: string }) => ({
        id: input.id ?? "source-copy",
        type: input.type,
        name: input.name,
        prompt: input.prompt,
        builtin: false,
        createdAt: now,
        updatedAt: now,
      })),
      deleteTemplate: vi.fn().mockResolvedValue(builtins[0]!.id),
      selectTemplate: vi.fn().mockResolvedValue(undefined),
      loadSupplement: vi.fn().mockResolvedValue(""),
      saveSupplement: vi.fn().mockImplementation(async (_type: string, value: string) => value),
      sourceMaterialAvailable: true,
      onClose: vi.fn(),
      onConfirm: vi.fn(),
      ...overrides,
    };
  }

  it.each([
    ["sensitive", "敏感词审查"],
    ["custom", "自定义审查"],
  ] as const)("%s 配置弹窗打开后按 Esc 放弃输入并关闭", async (type, title) => {
    const template = { ...builtins[0]!, id: `review-${type}-default`, type, name: title };
    const modalProps = props({
      type,
      loadTemplates: vi.fn().mockResolvedValue({ items: [template], selectedTemplateId: template.id }),
    });
    await act(async () => root.render(<ReviewLaunchModal {...modalProps} />));
    expect(host.querySelector('[data-wf="ReviewLaunchModal"]')).not.toBeNull();

    const supplement = host.querySelector<HTMLTextAreaElement>(".ws-launch-supplement textarea")!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(supplement, "尚未提交的输入");
      supplement.dispatchEvent(new Event("input", { bubbles: true }));
      supplement.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    });

    expect(modalProps.onClose).toHaveBeenCalledTimes(1);
    expect(modalProps.onConfirm).not.toHaveBeenCalled();
  });

  it("删除确认叠在自定义审查配置之上时，Esc 每次只关闭栈顶", async () => {
    const customTemplate = { ...builtins[1]!, id: "review-custom-user", type: "custom" as const, name: "法务合规视角" };
    const fallbackTemplate = { ...builtins[0]!, id: "review-custom-default", type: "custom" as const, name: "通用审查" };
    const modalProps = props({
      type: "custom",
      loadTemplates: vi.fn().mockResolvedValue({ items: [fallbackTemplate, customTemplate], selectedTemplateId: customTemplate.id }),
    });
    await act(async () => root.render(
      <ConfirmProvider><ReviewLaunchModal {...modalProps} /></ConfirmProvider>,
    ));
    act(() => host.querySelector<HTMLButtonElement>('[aria-label="编辑法务合规视角"]')?.click());
    await act(async () => Array.from(host.querySelectorAll<HTMLButtonElement>(".ws-launch-actions button"))
      .find((button) => button.textContent === "删除")?.click());
    expect(host.querySelector('[data-wf="GlobalConfirm"]')).not.toBeNull();

    await act(async () => document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
    expect(host.querySelector('[data-wf="GlobalConfirm"]')).toBeNull();
    expect(host.querySelector('[data-wf="ReviewLaunchModal"]')).not.toBeNull();
    expect(modalProps.onClose).not.toHaveBeenCalled();

    await act(async () => document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
    expect(modalProps.onClose).toHaveBeenCalledTimes(1);
  });

  it("底层预览已入栈时，Esc 只关闭后打开的审查配置", async () => {
    const dismissPreview = vi.fn();
    registerOverlay(dismissPreview);
    const modalProps = props();
    await act(async () => root.render(<ReviewLaunchModal {...modalProps} />));

    await act(async () => document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));

    expect(modalProps.onClose).toHaveBeenCalledTimes(1);
    expect(dismissPreview).not.toHaveBeenCalled();
  });

  it("头部左对齐呈现动作说明且无计数，审查组标题与弱化新建入口始终存在", async () => {
    const modalProps = props();
    await act(async () => root.render(<ConfirmProvider><ReviewLaunchModal {...modalProps} /></ConfirmProvider>));
    expect(host.querySelector(".ws-launch-head h2")?.textContent).toBe("来源核查（仅对照已关联素材）");
    expect(host.querySelector(".ws-launch-subtitle")?.textContent).toBe("以当前会话素材为依据，不联网");
    expect(host.querySelector(".ws-launch-head")?.textContent).not.toContain("2 模板");
    expect(host.querySelector(".ws-launch-template-group-title")?.textContent).toBe("审查模板");
    expect(host.querySelectorAll(".ws-launch-template-edit")).toHaveLength(2);
    expect(host.querySelectorAll(".ws-launch-template-edit svg")).toHaveLength(2);
    expect(host.querySelector(".ws-launch-template-edit path")?.getAttribute("d")).toBe("M11.1 2.9a1.75 1.75 0 0 1 2.47 2.47L6 12.9l-3.2.77.77-3.2Z");
    expect(host.querySelector(".ws-launch-template-edit")?.textContent).toBe("");
    expect(host.textContent).not.toContain("内置");
    expect(host.querySelector(".ws-launch-template-new")?.textContent).toBe("新建");
    expect(host.querySelector(".ws-launch-template-new svg")).not.toBeNull();
    expect(host.querySelector(".ws-launch-template-group-head .ws-launch-template-new")).not.toBeNull();
    expect(host.querySelector(".ws-launch-template-grid .ws-launch-template-new")).toBeNull();
    expect(host.textContent).not.toContain("完整提示词会随审查请求发送");
    expect(host.textContent).not.toContain("按文档保存，不会修改全局模板");
    expect(host.querySelector(".ws-launch-supplement span")?.textContent).toBe("补充要求");
    expect(host.querySelector<HTMLTextAreaElement>(".ws-launch-supplement textarea")?.placeholder).toBe("这次核查要特别注意什么，例如：重点核对数据和引述，标题不用查");

    const strictCard = Array.from(host.querySelectorAll<HTMLButtonElement>('[role="radio"]'))
      .find((button) => button.textContent?.includes("严格来源核查"))!;
    act(() => strictCard.click());
    expect(modalProps.selectTemplate).toHaveBeenCalledWith("source", "source-strict");

    act(() => host.querySelector<HTMLButtonElement>('[aria-label="编辑严格来源核查"]')?.click());
    expect(host.querySelector(".ws-launch-subtitle")).toBeNull();
    expect(host.textContent).toContain("另存新模板");
    expect(host.textContent).toContain("删除");
    const prompt = host.querySelector<HTMLTextAreaElement>(".ws-launch-editor textarea")!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(prompt, "只核对金额");
      prompt.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => Array.from(host.querySelectorAll<HTMLButtonElement>("button")).find((button) => button.textContent === "保存")?.click());
    expect(modalProps.saveTemplate).toHaveBeenCalledWith(expect.objectContaining({ id: "source-strict", prompt: "只核对金额" }));

    act(() => host.querySelector<HTMLButtonElement>('[aria-label="编辑严格来源核查"]')?.click());
    await act(async () => Array.from(host.querySelectorAll<HTMLButtonElement>("button")).find((button) => button.textContent === "删除")?.click());
    await act(async () => host.querySelector<HTMLButtonElement>('[data-wf="GlobalConfirm"] .ws-folder-modal-danger')?.click());
    expect(modalProps.deleteTemplate).toHaveBeenCalledWith("source-strict");

    act(() => host.querySelector<HTMLButtonElement>('[aria-label="编辑标准来源核查"]')?.click());
    const builtinFields = host.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(".ws-launch-editor input, .ws-launch-editor textarea");
    expect(builtinFields).toHaveLength(2);
    expect(Array.from(builtinFields).every((field) => !field.readOnly)).toBe(true);
    expect(host.querySelector(".ws-launch-head h2")?.textContent).toBe("编辑模板");
    expect(host.textContent).not.toContain("内置");
    const builtinActions = Array.from(host.querySelectorAll<HTMLButtonElement>(".ws-launch-actions button"));
    expect(builtinActions.map((button) => button.textContent)).toEqual(["删除", "另存新模板", "保存"]);
    expect(builtinActions[0]?.disabled).toBe(true);
    expect(builtinActions[0]?.title).toBe("每类至少保留一个模板");
    const builtinPrompt = host.querySelector<HTMLTextAreaElement>(".ws-launch-editor textarea")!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(builtinPrompt, "覆盖内置提示");
      builtinPrompt.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => builtinActions[2]?.click());
    expect(modalProps.saveTemplate).toHaveBeenLastCalledWith(expect.objectContaining({ id: "source-default", prompt: "覆盖内置提示" }));

    act(() => host.querySelector<HTMLButtonElement>('[aria-label="编辑标准来源核查"]')?.click());
    await act(async () => Array.from(host.querySelectorAll<HTMLButtonElement>(".ws-launch-actions button")).find((button) => button.textContent === "另存新模板")?.click());
    expect(modalProps.saveTemplate.mock.calls.at(-1)?.[0]).not.toHaveProperty("id");

    act(() => host.querySelector<HTMLButtonElement>(".ws-launch-template-new")?.click());
    const newName = host.querySelector<HTMLInputElement>(".ws-launch-editor input")!;
    const newPrompt = host.querySelector<HTMLTextAreaElement>(".ws-launch-editor textarea")!;
    expect(newName.value).toBe("");
    expect(newName.placeholder).toBe("给模板起个名，例如：投资人视角挑刺");
    expect(newPrompt.placeholder).toBe("像交代同事一样写：先说以什么身份/立场看稿，再列要逐项检查什么，最后说怎么给修改建议");
    expect(host.querySelector(".ws-launch-starters")?.textContent).toBe("快速开始：数字专核引述与归属专核");
    expect(host.querySelector(".ws-launch-actions > .ws-launch-starters")).not.toBeNull();
    expect(host.querySelector(".ws-launch-editor > .ws-launch-starters")).toBeNull();
    act(() => Array.from(host.querySelectorAll<HTMLButtonElement>(".ws-launch-starters button")).find((button) => button.textContent === "数字专核")?.click());
    expect(newName.value).toBe("数字专核");
    expect(newPrompt.value).toBe("本轮只核对数字：把文中所有数字（金额/百分比/日期/数量）与素材逐一对照，数值、单位、口径三样都要对上。素材里没有的数字标「无据」，口径变了标「口径漂移」。引句必须含数字原文。");
    expect(Array.from(host.querySelectorAll<HTMLButtonElement>(".ws-launch-actions > .wf-btn")).map((button) => button.textContent)).toEqual(["保存"]);
  });

  it("来源核查无素材时阻断发起并提供添加素材入口", async () => {
    const onAddMaterial = vi.fn();
    const modalProps = props({
      sourceMaterialAvailable: false,
      onAddMaterial,
    });
    await act(async () => root.render(<ReviewLaunchModal {...modalProps} />));

    expect(host.querySelector('[role="status"]')?.textContent).toContain("当前没有可对照素材，请先添加素材");
    const startButton = Array.from(host.querySelectorAll<HTMLButtonElement>(".ws-launch-actions button"))
      .find((button) => button.textContent === "开始核查");
    expect(startButton?.disabled).toBe(true);

    act(() => host.querySelector<HTMLButtonElement>(".ws-launch-source-blocked .ws-launch-link")?.click());
    expect(onAddMaterial).toHaveBeenCalledTimes(1);
    expect(modalProps.onConfirm).not.toHaveBeenCalled();
  });

  it("删除模板先确认，取消不删，确认后模板从列表消失", async () => {
    const deleteTemplate = vi.fn().mockResolvedValue("source-default");
    await act(async () => root.render(
      <ConfirmProvider><ReviewLaunchModal {...props({ deleteTemplate })} /></ConfirmProvider>,
    ));
    act(() => host.querySelector<HTMLButtonElement>('[aria-label="编辑严格来源核查"]')?.click());
    const deleteButton = Array.from(host.querySelectorAll<HTMLButtonElement>(".ws-launch-actions button"))
      .find((button) => button.textContent === "删除")!;
    expect(deleteButton.dataset.danger).toBe("true");

    await act(async () => deleteButton.click());
    const firstConfirm = host.querySelector<HTMLElement>('[data-wf="GlobalConfirm"]');
    expect(firstConfirm?.textContent).toContain("删除这个审查模板?");
    expect(firstConfirm?.textContent).toContain("严格来源核查");
    expect(firstConfirm?.textContent).toContain("删除后不可恢复");
    await act(async () => Array.from(firstConfirm?.querySelectorAll<HTMLButtonElement>("button") ?? [])
      .find((button) => button.textContent === "取消")?.click());
    expect(deleteTemplate).not.toHaveBeenCalled();
    expect(host.querySelector<HTMLInputElement>(".ws-launch-editor input")?.value).toBe("严格来源核查");
    expect(host.querySelector(".ws-launch-head h2")?.textContent).toBe("编辑模板");

    await act(async () => deleteButton.click());
    await act(async () => host.querySelector<HTMLButtonElement>('[data-wf="GlobalConfirm"] .ws-folder-modal-danger')?.click());
    expect(deleteTemplate).toHaveBeenCalledWith("source-strict");
    expect(host.querySelector('[aria-label="编辑严格来源核查"]')).toBeNull();
    expect(host.querySelector('[role="radio"]')?.textContent).toContain("标准来源核查");
  });

  it("内置模板删除失败时原样展示服务端保底错误", async () => {
    const deleteTemplate = vi.fn().mockRejectedValue(new Error("每类至少保留一个模板"));
    await act(async () => root.render(
      <ConfirmProvider><ReviewLaunchModal {...props({ deleteTemplate })} /></ConfirmProvider>,
    ));
    act(() => host.querySelector<HTMLButtonElement>('[aria-label="编辑标准来源核查"]')?.click());
    const deleteButton = Array.from(host.querySelectorAll<HTMLButtonElement>(".ws-launch-actions button"))
      .find((button) => button.textContent === "删除")!;
    expect(deleteButton.disabled).toBe(false);
    await act(async () => deleteButton.click());
    await act(async () => host.querySelector<HTMLButtonElement>('[data-wf="GlobalConfirm"] .ws-folder-modal-danger')?.click());
    expect(deleteTemplate).toHaveBeenCalledWith("source-default");
    expect(host.querySelector('[role="alert"]')?.textContent).toBe("每类至少保留一个模板");
  });

  it("旧模板选择晚失败不会回滚较新的成功选择", async () => {
    const balanced = {
      ...builtins[1]!,
      id: "source-balanced",
      name: "均衡来源核查",
    };
    let rejectStrict!: (error: Error) => void;
    let resolveBalanced!: () => void;
    const strictRequest = new Promise<void>((_resolve, reject) => {
      rejectStrict = reject;
    });
    const balancedRequest = new Promise<void>((resolve) => {
      resolveBalanced = resolve;
    });
    const selectTemplate = vi.fn((_type: string, id: string) => (
      id === "source-strict" ? strictRequest : balancedRequest
    ));

    await act(async () => root.render(<ReviewLaunchModal {...props({
      loadTemplates: vi.fn().mockResolvedValue({
        items: [...builtins, balanced],
        selectedTemplateId: builtins[0]!.id,
      }),
      selectTemplate,
    })} />));
    const card = (name: string) => Array.from(host.querySelectorAll<HTMLButtonElement>('[role="radio"]'))
      .find((button) => button.textContent?.includes(name))!;

    act(() => card("严格来源核查").click());
    act(() => card("均衡来源核查").click());
    await act(async () => {
      resolveBalanced();
      await balancedRequest;
    });
    await act(async () => {
      rejectStrict(new Error("旧请求失败"));
      await strictRequest.catch(() => undefined);
    });

    expect(card("均衡来源核查").getAttribute("aria-checked")).toBe("true");
    expect(host.querySelector('[role="alert"]')).toBeNull();
  });

  it("连续两次乐观选择均失败时回滚到最后确认持久化的模板", async () => {
    const balanced = {
      ...builtins[1]!,
      id: "source-balanced-failed",
      name: "均衡来源核查",
    };
    let rejectStrict!: (error: Error) => void;
    let rejectBalanced!: (error: Error) => void;
    const strictRequest = new Promise<void>((_resolve, reject) => {
      rejectStrict = reject;
    });
    const balancedRequest = new Promise<void>((_resolve, reject) => {
      rejectBalanced = reject;
    });
    const selectTemplate = vi.fn((_type: string, id: string) => (
      id === "source-strict" ? strictRequest : balancedRequest
    ));
    await act(async () => root.render(<ReviewLaunchModal {...props({
      loadTemplates: vi.fn().mockResolvedValue({
        items: [...builtins, balanced],
        selectedTemplateId: "source-default",
      }),
      selectTemplate,
    })} />));
    const card = (name: string) => Array.from(host.querySelectorAll<HTMLButtonElement>('[role="radio"]'))
      .find((button) => button.textContent?.includes(name))!;

    act(() => card("严格来源核查").click());
    act(() => card("均衡来源核查").click());
    await act(async () => {
      rejectBalanced(new Error("最新选择失败"));
      await balancedRequest.catch(() => undefined);
    });
    await act(async () => {
      rejectStrict(new Error("旧选择晚失败"));
      await strictRequest.catch(() => undefined);
    });

    expect(card("标准来源核查").getAttribute("aria-checked")).toBe("true");
    expect(card("严格来源核查").getAttribute("aria-checked")).toBe("false");
    expect(host.querySelector('[role="alert"]')?.textContent).toBe("模板选择保存失败，请重试");
  });

  it("新模板已保存但设默认失败时,重试只选择已有模板而不重复创建", async () => {
    const saveTemplate = vi.fn().mockResolvedValue({
      id: "source-saved-once",
      type: "source",
      name: "已落库模板",
      prompt: "只保存一次",
      builtin: false,
      createdAt: now,
      updatedAt: now,
    });
    const selectTemplate = vi.fn()
      .mockRejectedValueOnce(new Error("设置默认失败"))
      .mockResolvedValueOnce(undefined);

    await act(async () => root.render(<ReviewLaunchModal {...props({ saveTemplate, selectTemplate })} />));
    act(() => host.querySelector<HTMLButtonElement>(".ws-launch-template-new")?.click());
    const name = host.querySelector<HTMLInputElement>(".ws-launch-editor input")!;
    const prompt = host.querySelector<HTMLTextAreaElement>(".ws-launch-editor textarea")!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(name, "已落库模板");
      name.dispatchEvent(new Event("input", { bubbles: true }));
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(prompt, "只保存一次");
      prompt.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      Array.from(host.querySelectorAll<HTMLButtonElement>(".ws-launch-actions button"))
        .find((button) => button.textContent === "保存")
        ?.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    const savedCard = Array.from(host.querySelectorAll<HTMLButtonElement>('[role="radio"]'))
      .find((button) => button.textContent?.includes("已落库模板"));
    expect(savedCard).toBeTruthy();
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("模板已保存");

    await act(async () => {
      savedCard?.click();
      await Promise.resolve();
    });

    expect(saveTemplate).toHaveBeenCalledTimes(1);
    expect(saveTemplate.mock.calls[0]?.[0]).not.toHaveProperty("id");
    expect(selectTemplate).toHaveBeenNthCalledWith(1, "source", "source-saved-once");
    expect(selectTemplate).toHaveBeenNthCalledWith(2, "source", "source-saved-once");
    expect(host.querySelector('[role="alert"]')).toBeNull();
  });

  it("文档级补充自动带出、确认即持久化；敏感词弹窗内含词库管理", async () => {
    let stored = "上次重点核对品牌口号";
    const modalProps = props({
      type: "sensitive" as const,
      loadTemplates: vi.fn().mockResolvedValue({ items: [{ ...builtins[0]!, id: "sensitive-default", type: "sensitive", name: "标准敏感词审查" }], selectedTemplateId: "sensitive-default" }),
      loadSupplement: vi.fn().mockImplementation(async () => stored),
      saveSupplement: vi.fn().mockImplementation(async (_type: string, value: string) => { stored = value; return value; }),
      loadLexicons: vi.fn().mockResolvedValue(lexicons),
      loadLexiconEntries: vi.fn().mockResolvedValue([{ word: "唯一", replacement: null, note: "仅标记" }]),
    });
    await act(async () => root.render(<ReviewLaunchModal {...modalProps} />));
    const textarea = host.querySelector<HTMLTextAreaElement>(".ws-launch-supplement textarea")!;
    expect(textarea.value).toBe(stored);
    expect(textarea.placeholder).toBe("这次审查要特别注意什么，例如：行业黑话不算敏感词，重点看宣传用语");
    expect(host.querySelector(".ws-launch-subtitle")?.textContent).toBe("按所选词库扫描全文，标记并建议替换");
    expect(host.textContent).toContain("管理词库");
    act(() => host.querySelector<HTMLButtonElement>(".ws-launch-resource-row .ws-launch-link")?.click());
    expect(host.textContent).toContain("管理敏感词词库");
    expect(host.querySelector(".ws-launch-subtitle")).toBeNull();
    expect(host.textContent).toContain("广告法极限词");
    expect(host.textContent).not.toContain("选择本次审查启用的词库");
    await act(async () => host.querySelector<HTMLButtonElement>(".ws-lexicon-open")?.click());
    expect(host.querySelector(".ws-launch-head")?.textContent).not.toContain("1 词");
    expect(host.querySelector(".ws-launch-subtitle")).toBeNull();
    act(() => host.querySelector<HTMLButtonElement>(".ws-launch-back")?.click());
    act(() => host.querySelector<HTMLButtonElement>(".ws-launch-back")?.click());
    const currentTextarea = host.querySelector<HTMLTextAreaElement>(".ws-launch-supplement textarea")!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(currentTextarea, "这次只看引述");
      currentTextarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => host.querySelector<HTMLButtonElement>(".ws-launch-actions button:last-child")?.click());
    expect(modalProps.saveSupplement).toHaveBeenCalledWith(
      "sensitive",
      "这次只看引述",
      "sensitive-default",
    );
    expect(modalProps.onConfirm).toHaveBeenCalledWith(expect.objectContaining({ id: "sensitive-default" }), "这次只看引述", lexicons);
  });

  it("机器维护的忽略区不进入补充要求文本框，编辑用户正文时仍原样保存并用于审查", async () => {
    const ignoreLine = "- 已确认无需处理，不再标记：「139****5678」；问题：「已获授权」(2026-08-06) <!-- qingagent-review-ignore-key:v1:custom:span%3Acontact%3A1%3A12:%E5%B7%B2%E8%8E%B7%E6%8E%88%E6%9D%83 -->";
    const stored = `用户原要求\n\n## 已确认忽略\n${ignoreLine}`;
    const modalProps = props({
      type: "custom" as const,
      loadTemplates: vi.fn().mockResolvedValue({
        items: [{ ...builtins[0]!, id: "custom-default", type: "custom", name: "自定义审查" }],
        selectedTemplateId: "custom-default",
      }),
      loadSupplement: vi.fn().mockResolvedValue(stored),
    });

    await act(async () => root.render(<ReviewLaunchModal {...modalProps} />));
    const textarea = host.querySelector<HTMLTextAreaElement>(".ws-launch-supplement textarea")!;
    expect(textarea.value).toBe("用户原要求\n\n");
    expect(textarea.value).not.toContain("qingagent-review-ignore-key");
    expect(textarea.value).not.toContain("## 已确认忽略");
    expect(buildReviewActionCard("custom", "自定义审查", stored)).toEqual({
      title: "自定义审查",
      status: "sent",
      lines: [
        { label: "模板", value: "自定义审查" },
        { label: "补充", value: "用户原要求" },
      ],
    });

    act(() => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(textarea, "更新后的用户要求");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => host.querySelector<HTMLButtonElement>(".ws-launch-actions button:last-child")?.click());

    const expected = `更新后的用户要求\n\n## 已确认忽略\n${ignoreLine}`;
    expect(modalProps.saveSupplement).toHaveBeenCalledWith(
      "custom",
      expected,
      "custom-default",
    );
    expect(modalProps.onConfirm).toHaveBeenCalledWith(
      expect.objectContaining({ id: "custom-default" }),
      expected,
      [],
    );
  });

  it("切换自定义模板时按模板加载和保存补充要求，不把另一模板正文带入", async () => {
    const templateX = {
      ...builtins[0]!,
      id: "review-custom-x",
      type: "custom" as const,
      name: "模板 X",
    };
    const templateY = {
      ...builtins[1]!,
      id: "review-custom-y",
      type: "custom" as const,
      name: "模板 Y",
    };
    const supplements = new Map([
      [templateX.id, "只属于模板 X 的补充要求"],
      [templateY.id, "只属于模板 Y 的补充要求"],
    ]);
    const modalProps = props({
      type: "custom" as const,
      loadTemplates: vi.fn().mockResolvedValue({
        items: [templateX, templateY],
        selectedTemplateId: templateX.id,
      }),
      loadSupplement: vi.fn().mockImplementation(
        async (_type: string, templateId?: string) => supplements.get(templateId ?? "") ?? "",
      ),
    });

    await act(async () => root.render(<ReviewLaunchModal {...modalProps} />));
    expect(host.querySelector<HTMLTextAreaElement>(".ws-launch-supplement textarea")?.value)
      .toBe("只属于模板 X 的补充要求");

    const yCard = Array.from(host.querySelectorAll<HTMLButtonElement>('[role="radio"]'))
      .find((button) => button.textContent?.includes("模板 Y"));
    await act(async () => {
      yCard?.click();
      await Promise.resolve();
    });

    const textarea = host.querySelector<HTMLTextAreaElement>(".ws-launch-supplement textarea")!;
    expect(textarea.value).toBe("只属于模板 Y 的补充要求");
    expect(textarea.value).not.toContain("模板 X");
    await act(async () => host.querySelector<HTMLButtonElement>(".ws-launch-actions button:last-child")?.click());
    expect(modalProps.saveSupplement).toHaveBeenCalledWith(
      "custom",
      "只属于模板 Y 的补充要求",
      templateY.id,
    );
  });

  it("词库开关完成即持久化，重进后显示与审查请求集合一致", async () => {
    const availableLexicons = [
      { id: "lexicon-ad", name: "广告法极限词", description: "广告合规", entryCount: 2, enabled: true },
      { id: "lexicon-medical", name: "医疗健康违禁宣称", description: "医疗合规", entryCount: 2, enabled: true },
      { id: "lexicon-official", name: "公文规范用语对照", description: "公文规范", entryCount: 2, enabled: true },
      { id: "lexicon-social", name: "自媒体营销高危词", description: "平台治理", entryCount: 2, enabled: true },
    ];
    let storedIds = new Set(availableLexicons.map((item) => item.id));
    const loadLexicons = vi.fn(async () => availableLexicons.map((item) => ({
      ...item,
      enabled: storedIds.has(item.id),
    })));
    const saveLexiconSelection = vi.fn(async (enabledIds: string[]) => {
      storedIds = new Set(enabledIds);
      return loadLexicons();
    });
    const modalProps = props({
      type: "sensitive" as const,
      loadTemplates: vi.fn().mockResolvedValue({
        items: [{ ...builtins[0]!, id: "sensitive-default", type: "sensitive", name: "标准敏感词审查" }],
        selectedTemplateId: "sensitive-default",
      }),
      loadLexicons,
      saveLexiconSelection,
    });

    await act(async () => root.render(<ReviewLaunchModal {...modalProps} />));
    act(() => host.querySelector<HTMLButtonElement>(".ws-launch-resource-row .ws-launch-link")?.click());
    const initialCheckboxes = Array.from(host.querySelectorAll<HTMLInputElement>(".ws-lexicon-check input"));
    expect(initialCheckboxes.map((checkbox) => checkbox.checked)).toEqual([true, true, true, true]);
    act(() => initialCheckboxes.slice(1).forEach((checkbox) => checkbox.click()));
    await act(async () => Array.from(host.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent === "完成")?.click());
    expect(saveLexiconSelection).toHaveBeenCalledWith(["lexicon-ad"]);

    await act(async () => root.render(<ReviewLaunchModal {...modalProps} open={false} />));
    await act(async () => root.render(<ReviewLaunchModal {...modalProps} open />));
    act(() => host.querySelector<HTMLButtonElement>(".ws-launch-resource-row .ws-launch-link")?.click());
    const reloadedCheckboxes = Array.from(host.querySelectorAll<HTMLInputElement>(".ws-lexicon-check input"));
    expect(reloadedCheckboxes.map((checkbox) => checkbox.checked)).toEqual([true, false, false, false]);

    act(() => host.querySelector<HTMLButtonElement>(".ws-launch-back")?.click());
    await act(async () => Array.from(host.querySelectorAll<HTMLButtonElement>(".ws-launch-actions button"))
      .find((button) => button.textContent === "开始审查")?.click());
    expect(modalProps.onConfirm).toHaveBeenCalledWith(
      expect.objectContaining({ id: "sensitive-default" }),
      "",
      [expect.objectContaining({ id: "lexicon-ad", enabled: true })],
    );
  });

  it("切换词库会清除旧错误，且旧词条请求晚失败不会污染当前词库", async () => {
    const availableLexicons = [
      lexicons[0]!,
      { id: "lexicon-brand", name: "品牌禁用词", description: "品牌规范", entryCount: 1, enabled: true },
    ];
    let rejectOldRequest!: (error: Error) => void;
    let resolveCurrentRequest!: (items: Array<{ word: string; replacement: string | null; note: string | null }>) => void;
    const oldRequest = new Promise<Array<{ word: string; replacement: string | null; note: string | null }>>((_resolve, reject) => {
      rejectOldRequest = reject;
    });
    const currentRequest = new Promise<Array<{ word: string; replacement: string | null; note: string | null }>>((resolve) => {
      resolveCurrentRequest = resolve;
    });
    const loadLexiconEntries = vi.fn()
      .mockImplementationOnce(() => oldRequest)
      .mockRejectedValueOnce(new Error("当前请求失败"))
      .mockImplementationOnce(() => currentRequest);

    await act(async () => root.render(<ReviewLaunchModal {...props({
      type: "sensitive",
      loadTemplates: vi.fn().mockResolvedValue({
        items: [{ ...builtins[0]!, id: "sensitive-default", type: "sensitive", name: "标准敏感词审查" }],
        selectedTemplateId: "sensitive-default",
      }),
      loadLexicons: vi.fn().mockResolvedValue(availableLexicons),
      loadLexiconEntries,
    })} />));
    act(() => host.querySelector<HTMLButtonElement>(".ws-launch-resource-row .ws-launch-link")?.click());
    const openLexicon = (name: string) => Array.from(host.querySelectorAll<HTMLButtonElement>(".ws-lexicon-open"))
      .find((button) => button.textContent?.includes(name))!;

    act(() => openLexicon("广告法极限词").click());
    act(() => host.querySelector<HTMLButtonElement>(".ws-launch-back")?.click());
    await act(async () => {
      openLexicon("品牌禁用词").click();
      await Promise.resolve();
    });
    expect(host.querySelector('[role="alert"]')?.textContent).toBe("词条加载失败，请重试");

    act(() => host.querySelector<HTMLButtonElement>(".ws-launch-back")?.click());
    act(() => openLexicon("广告法极限词").click());
    expect(host.querySelector('[role="alert"]')).toBeNull();

    await act(async () => {
      resolveCurrentRequest([{ word: "第一", replacement: "领先", note: null }]);
      await currentRequest;
      rejectOldRequest(new Error("旧请求晚失败"));
      await oldRequest.catch(() => undefined);
    });

    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(host.querySelector(".ws-lexicon-entry-list")?.textContent).toContain("第一");
  });

  it("菜单无省略号和词库项，query 用完整载荷而卡片只呈现摘要", async () => {
    act(() => root.render(<ReviewMenu
      onClose={vi.fn()}
      onSensitiveReview={vi.fn()}
      onDeaiReview={vi.fn()}
      onSourceCheck={vi.fn()}
      onConsistencyReview={vi.fn()}
      onPrivacyReview={vi.fn()}
      onFormatReview={vi.fn()}
      onRoleReview={vi.fn()}
      onCustomReview={vi.fn()}
    />));
    expect(host.textContent).not.toContain("…");
    expect(host.textContent).not.toContain("管理敏感词词库");
    expect(host.textContent).toContain("一致性审查");
    expect(host.textContent).toContain("隐私泄露审查");
    expect(host.textContent).toContain("格式规范审查");
    expect(host.textContent).toContain("自定义审查");
    expect(host.querySelectorAll("button:disabled")).toHaveLength(0);
    expect(Array.from(host.querySelectorAll('[role="menuitem"]')).map((item) => item.textContent)).toEqual([
      "来源核查", "一致性审查",
      "敏感词审查", "隐私泄露审查",
      "去AI味", "格式规范审查",
      "角色审查", "自定义审查",
    ]);
    expect(host.querySelectorAll('[role="separator"]')).toHaveLength(3);
    expect(host.querySelector('[role="menu"]')?.textContent).not.toMatch(/来源与事实|安全合规|表达质量|角色与自定义/);
    const css = readFileSync(resolve(process.cwd(), "src/pages/workspace/workspace-ink-skin.css"), "utf8");
    expect(css).toMatch(/\[data-wf="ReviewMenu"\]\s+\.ws-export-separator\s*\{\s*background:\s*var\(--line-2\)/);

    const template = { ...builtins[0]!, prompt: "完整模板规则：逐字核对所有数字。" };
    const query = buildReviewQuery("source", template, "重点核对月活");
    const card = buildReviewActionCard("source", template.name, "重点核对月活\n不要联网");
    const reviewContext = buildReviewContext("source", template);
    expect(query).toContain(template.prompt);
    expect(query).toBe(assembleReviewQuery("source", template, "重点核对月活"));
    expect(query).toContain("文档级补充要求（只适用于当前文档）：重点核对月活");
    expect(card).toEqual({ title: "来源核查（仅对照已关联素材）", lines: [{ label: "模板", value: "标准来源核查" }, { label: "补充", value: "重点核对月活 不要联网" }], status: "sent" });
    expect(reviewContext).toEqual({ type: "source", templateId: "source-default", templateName: "标准来源核查" });
    expect(JSON.stringify(card)).not.toContain(template.prompt);

    const messages: ChatMessage[] = [{
      id: "review-query",
      role: { kind: "user" },
      ts: now,
      parts: [{ kind: "actionCard", data: card }],
      chips: [],
    }];
    act(() => root.render(<ChatMessageList messages={messages} streamActive={false} />));
    expect(host.querySelector('[data-wf="ActionCard"]')?.textContent).toContain("来源核查（仅对照已关联素材）");
    expect(host.querySelector('[data-wf="ActionCard"]')?.textContent).toContain("标准来源核查");
    expect(host.textContent).not.toContain(template.prompt);
    expect(host.querySelector(".wf-msg.user")).toBeNull();
  });

  it.each([
    ["deai", "轻度去痕", "去AI味", "识别机器腔，把文字改得更像人写的", "这次处理要特别注意什么，例如：保留第一人称口吻，案例部分别改"],
    ["consistency", "全面自洽核查", "一致性审查", "检查全文时间线、数字与称谓是否自洽", "这次审查要特别注意什么，例如：重点核对时间线，产品名以正文第一次出现为准"],
    ["privacy", "对外发布", "隐私泄露审查", "发布前检查个人与内部信息泄露", "这次审查要特别注意什么，例如：客户名可以保留，内部项目代号要脱敏"],
    ["format", "交付前整备", "格式规范审查", "检查标题层级、标点与数字格式", "这次审查要特别注意什么，例如：数字统一用阿拉伯数字"],
    ["custom", "法务合规视角", "自定义审查", "用你自己的模板定义审查逻辑", "这次审查要特别注意什么"],
  ] as const)("%s 弹窗呈现对应说明、补充例句与组标题", async (type, templateName, title, subtitle, placeholder) => {
    const template = { ...builtins[0]!, id: `review-${type}-default`, type, name: templateName };
    await act(async () => root.render(<ReviewLaunchModal {...props({
      type,
      loadTemplates: vi.fn().mockResolvedValue({ items: [template], selectedTemplateId: template.id }),
    })} />));

    expect(host.querySelector('[data-wf="ReviewLaunchModal"]')?.textContent).toContain(title);
    expect(host.querySelector(".ws-launch-subtitle")?.textContent).toBe(subtitle);
    expect(host.querySelector<HTMLTextAreaElement>(".ws-launch-supplement textarea")?.placeholder).toBe(placeholder);
    expect(host.querySelector(".ws-launch-template-group-title")?.textContent).toBe("审查模板");
    const cards = host.querySelectorAll<HTMLButtonElement>('.ws-launch-template-grid [role="radio"]');
    expect(cards).toHaveLength(1);
    expect(cards[0]?.getAttribute("aria-checked")).toBe("true");
    expect(cards[0]?.textContent).toContain(templateName);
  });

  it("role 弹窗只启用竖卡、12 个固定头像与通用头像，推荐排序不改变选中记忆", async () => {
    const templates: ReviewTemplateItem[] = [
      ...[...ROLE_REVIEW_PROFILES].reverse().map((profile) => ({
        id: profile.id,
        type: "role" as const,
        name: profile.name,
        prompt: `${profile.name}提示词`,
        builtin: true,
        createdAt: now,
        updatedAt: now,
      })),
      { id: "review-user-role", type: "role", name: "我的超长自定义审查角色", prompt: "用户提示词", builtin: false, createdAt: now, updatedAt: now },
    ];
    const selectedTemplateId = "review-role-beginner";
    await act(async () => root.render(<ReviewLaunchModal {...props({
      type: "role",
      documentTitle: "支付系统技术方案 PRD",
      documentText: "接口输入输出、异常分支、边界条件、并发性能与数据库兼容性需要补齐。",
      loadTemplates: vi.fn().mockResolvedValue({ items: templates, selectedTemplateId }),
    })} />));

    expect(host.querySelector(".ws-launch-head h2")?.textContent).toBe("角色审查");
    expect(host.querySelector(".ws-launch-subtitle")?.textContent).toBe("请一位虚拟角色来审这篇文档");
    expect(host.querySelector(".ws-launch-template-group-title")?.textContent).toBe("审查角色");
    expect(host.querySelector(".ws-launch-template-grid")?.classList.contains("is-portrait")).toBe(true);
    expect(host.querySelectorAll(".ws-launch-template-card.is-portrait")).toHaveLength(13);
    expect(host.querySelectorAll(".ws-launch-role-avatar svg")).toHaveLength(13);
    expect(new Set(Array.from(host.querySelectorAll(".ws-launch-role-avatar svg")).map((svg) => svg.getAttribute("data-avatar-kind"))))
      .toEqual(new Set([...ROLE_REVIEW_PROFILES.map((profile) => profile.avatar), "generic"]));
    const avatars = Array.from(host.querySelectorAll(".ws-launch-role-avatar svg"));
    expect(avatars.every((svg) =>
      svg.getAttribute("viewBox") === "0 0 64 64"
      && svg.getAttribute("fill") === "none"
      && svg.getAttribute("stroke") === "currentColor"
      && svg.getAttribute("stroke-width") === "2"
      && svg.getAttribute("stroke-linecap") === "round"
      && svg.getAttribute("stroke-linejoin") === "round"
    )).toBe(true);
    expect(new Set(avatars.map((svg) => svg.querySelector('[data-avatar-part="person"]')?.innerHTML)).size).toBe(1);
    expect(avatars.filter((svg) => svg.querySelector('[data-avatar-part="badge"]'))).toHaveLength(12);
    expect(host.querySelector('[data-avatar-kind="generic"] [data-avatar-part="badge"]')).toBeNull();

    const cards = Array.from(host.querySelectorAll<HTMLButtonElement>('[role="radio"]'));
    expect(cards[0]?.textContent).toContain("研发工程师");
    expect(cards[0]?.textContent).toContain("推荐");
    expect(cards.find((card) => card.textContent?.includes("小白读者视角"))?.getAttribute("aria-checked")).toBe("true");
    expect(cards.find((card) => card.textContent?.includes("我的超长自定义审查角色"))?.textContent).toContain("自定义角色");
    expect(host.querySelector<HTMLTextAreaElement>(".ws-launch-supplement textarea")?.placeholder)
      .toBe("这次审查要特别注意什么，例如：重点看上线风险和数据口径");
  });
});
