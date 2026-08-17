import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LexiconPickerModal } from "./LexiconPickerModal";

describe("LexiconPickerModal", () => {
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
    host.remove();
  });

  async function renderModal(onClose = vi.fn()) {
    const loadLexicons = vi.fn().mockResolvedValue([
      { id: "lex-1", name: "通用敏感词", entryCount: 2, description: "按公开口径整理，适用于通用文案。", enabled: true },
      { id: "lex-2", name: "品牌保护词", entryCount: 1, description: "保护品牌名称。", enabled: true },
    ]);
    const loadLexiconEntries = vi.fn().mockResolvedValue([
      { word: "旧称", replacement: "新称", note: "品牌已升级" },
      { word: "风险词", replacement: null, note: null },
    ]);
    const onConfirm = vi.fn();
    const loadInstruction = vi.fn().mockResolvedValue("引用原文先确认");
    const saveInstruction = vi.fn().mockResolvedValue(undefined);

    await act(async () => {
      root.render(
        <LexiconPickerModal
          open
          loadLexicons={loadLexicons}
          loadLexiconEntries={loadLexiconEntries}
          loadInstruction={loadInstruction}
          saveInstruction={saveInstruction}
          onClose={onClose}
          onConfirm={onConfirm}
        />,
      );
    });
    return { loadLexiconEntries, loadInstruction, saveInstruction, onClose, onConfirm };
  }

  it("checkbox 独立切换，行体进入二级后返回仍保持选择状态", async () => {
    const { loadLexiconEntries } = await renderModal();
    const checkbox = host.querySelector<HTMLInputElement>('input[type="checkbox"]');
    expect(checkbox?.checked).toBe(true);

    act(() => checkbox?.click());
    expect(checkbox?.checked).toBe(false);
    expect(loadLexiconEntries).not.toHaveBeenCalled();

    const openButton = host.querySelector<HTMLButtonElement>(".ws-lexicon-open");
    await act(async () => openButton?.click());
    expect(loadLexiconEntries).toHaveBeenCalledWith("lex-1");
    expect(host.querySelector(".ws-lexicon-head h2")?.textContent).toBe("通用敏感词");
    expect(host.querySelector(".ws-lexicon-head-count")?.textContent).toBe("2 词");
    expect(host.querySelector(".ws-lexicon-replacement")?.textContent).toBe("新称");
    expect(host.querySelector(".ws-lexicon-replacement svg")).not.toBeNull();
    expect(host.querySelector(".ws-lexicon-mark-only")?.textContent).toBe("仅标记");
    expect(host.querySelector(".ws-lexicon-entry")?.getAttribute("title")).toBe("品牌已升级");

    act(() => host.querySelector<HTMLButtonElement>(".ws-lexicon-back")?.click());
    expect(host.querySelector<HTMLInputElement>('input[type="checkbox"]')?.checked).toBe(false);
  });

  it("展示词库来源副题，并在开始审查时保存并回传常驻指令", async () => {
    const { loadInstruction, saveInstruction, onConfirm } = await renderModal();
    expect(loadInstruction).toHaveBeenCalledTimes(1);
    expect(host.querySelector(".ws-lexicon-copy small")?.textContent).toContain("公开口径");
    const textarea = host.querySelector<HTMLTextAreaElement>(".ws-lexicon-instruction textarea")!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(textarea, "专有名词先列出");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => host.querySelector<HTMLButtonElement>(".ws-lexicon-actions button:last-child")?.click());
    expect(saveInstruction).toHaveBeenCalledWith("专有名词先列出");
    expect(onConfirm).toHaveBeenCalledWith(expect.any(Array), "专有名词先列出");
  });

  it("点击同族遮罩取消，点击弹框内部不取消", async () => {
    const onClose = vi.fn();
    await renderModal(onClose);
    const overlay = host.querySelector<HTMLElement>(".ws-folder-modal-overlay");
    const modal = host.querySelector<HTMLElement>(".ws-lexicon-modal");

    act(() => modal?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })));
    expect(onClose).not.toHaveBeenCalled();
    act(() => overlay?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
