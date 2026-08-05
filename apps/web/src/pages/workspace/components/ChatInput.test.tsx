// @vitest-environment jsdom
import { act, createRef, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  parseChipRichText,
  type FolderSource,
  type Resource,
} from "@qingagent/contract-ts";
import { SKILLS_CHANGED_EVENT } from "../../../overlays/settings/useSkills";
import { resources } from "../../../system/resources";
import type { MaterialParseRow } from "../data/useMaterialParseTracker";
import { DEFAULT_UPLOAD_MAX_BYTES } from "../data/uploadAsset";
import { ChatInput, type ChatInputHandle, type ChatInputProps } from "./ChatInput";

let root: Root | null = null;
let host: HTMLDivElement | null = null;

const FOLDER_INTRO_STORAGE_KEY = "qingagent:folder-source-intro-dismissed";

type FolderInputProps = Pick<
  ChatInputProps,
  "folderSource" | "folderCapability" | "onAttachFolder" | "onDetachFolder"
>;

describe("ChatInput", () => {
  beforeEach(() => {
    resources.reset();
    window.localStorage.clear();
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => undefined)));
  });

  afterEach(() => {
    if (root) {
      act(() => root?.unmount());
      root = null;
    }
    host?.remove();
    host = null;
    resources.reset();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("IME 合成期不触发 onChange, compositionend 后只上报最终文本", async () => {
    const onChange = vi.fn();
    await render(
      <ChatInput
        {...baseFolderProps()}
        placeholder="输入"
        onChange={onChange}
        onSubmit={() => undefined}
      />,
    );
    const edit = getEditor();
    bindInnerText(edit);

    act(() => {
      edit.dispatchEvent(compositionEvent("compositionstart"));
    });
    act(() => {
      edit.innerText = "n";
      edit.dispatchEvent(inputEvent(true));
    });
    act(() => {
      edit.innerText = "ni";
      edit.dispatchEvent(inputEvent(true));
    });

    expect(onChange).not.toHaveBeenCalled();

    act(() => {
      edit.innerText = "你";
      edit.dispatchEvent(compositionEvent("compositionend"));
    });

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenLastCalledWith("你", 0);
  });

  it("普通输入仍立即触发 onChange", async () => {
    const onChange = vi.fn();
    await render(
      <ChatInput
        {...baseFolderProps()}
        placeholder="输入"
        onChange={onChange}
        onSubmit={() => undefined}
      />,
    );
    const edit = getEditor();
    bindInnerText(edit);

    act(() => {
      edit.innerText = "hello";
      edit.dispatchEvent(inputEvent(false));
    });

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenLastCalledWith("hello", 0);
  });

  it("Enter 发送，多行编辑中间也不插入换行", async () => {
    const onSubmit = vi.fn();
    await render(
      <ChatInput
        {...baseFolderProps()}
        placeholder="输入"
        onSubmit={onSubmit}
      />,
    );
    const edit = getEditor();
    setEditorText(edit, "第一行\n第二行");

    const event = keyboardEvent("Enter");
    act(() => {
      edit.dispatchEvent(event);
    });

    expect(event.defaultPrevented).toBe(true);
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it("Shift+Enter 交还 contenteditable 执行换行，不发送", async () => {
    const onSubmit = vi.fn();
    await render(
      <ChatInput
        {...baseFolderProps()}
        placeholder="输入"
        onSubmit={onSubmit}
      />,
    );
    const edit = getEditor();
    setEditorText(edit, "需要换行");

    const event = keyboardEvent("Enter", { shiftKey: true });
    act(() => {
      edit.dispatchEvent(event);
    });

    expect(event.defaultPrevented).toBe(false);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("相邻块级节点在纯文本与含 chip 的 richText 中都保留换行", async () => {
    const ref = createRef<ChatInputHandle>();
    await render(
      <ChatInput
        {...baseFolderProps()}
        ref={ref}
        placeholder="输入"
        onSubmit={() => undefined}
      />,
    );
    const edit = getEditor();
    edit.innerHTML = [
      "<div>第一行</div>",
      '<div>第二行<span class="chat-chip" data-kind="attach" data-label="资料.pdf"></span></div>',
    ].join("");

    expect(ref.current?.snapshot()).toMatchObject({
      text: "第一行\n第二行",
      richText: "第一行\n第二行{{chip:0}}",
      chips: [{ kind: "attach", label: "资料.pdf" }],
    });
  });

  it("appendText 始终在已有草稿末尾逐行追加，不受当前光标位置影响", async () => {
    const ref = createRef<ChatInputHandle>();
    await render(
      <ChatInput
        {...baseFolderProps()}
        ref={ref}
        placeholder="输入"
        onSubmit={() => undefined}
      />,
    );
    const edit = getEditor();
    setEditorText(edit, "已有草稿");
    const range = document.createRange();
    range.setStart(edit.firstChild!, 0);
    range.collapse(true);
    window.getSelection()?.removeAllRanges();
    window.getSelection()?.addRange(range);

    act(() => {
      expect(ref.current?.appendText("按批注修改：第一条")).toBe(true);
      expect(ref.current?.appendText("按批注修改：第二条")).toBe(true);
    });

    expect(ref.current?.snapshot()).toMatchObject({
      text: "已有草稿\n按批注修改：第一条\n按批注修改：第二条",
      richText: "已有草稿\n按批注修改：第一条\n按批注修改：第二条",
      chips: [],
    });
  });

  it("appendText 追加批注块时与已有文字及下一条批注各隔一个空行", async () => {
    const ref = createRef<ChatInputHandle>();
    await render(
      <ChatInput
        {...baseFolderProps()}
        ref={ref}
        placeholder="输入"
        onSubmit={() => undefined}
      />,
    );
    const edit = getEditor();
    setEditorText(edit, "已有草稿");

    act(() => {
      expect(ref.current?.appendText("按批注修改：第一条", { separateBlock: true })).toBe(true);
      expect(ref.current?.appendText("按批注修改：第二条", { separateBlock: true })).toBe(true);
    });

    expect(ref.current?.snapshot()).toMatchObject({
      text: "已有草稿\n\n按批注修改：第一条\n\n按批注修改：第二条",
      richText: "已有草稿\n\n按批注修改：第一条\n\n按批注修改：第二条",
      chips: [],
    });
  });

  it("appendText 光标定位失败时仍同步发送状态，连续回填后 Enter 可提交", async () => {
    const ref = createRef<ChatInputHandle>();
    const onSubmit = vi.fn();
    await render(
      <ChatInput
        {...baseFolderProps()}
        ref={ref}
        placeholder="输入"
        onSubmit={onSubmit}
      />,
    );
    const edit = getEditor();
    expect(getSendButton().disabled).toBe(true);
    const selection = window.getSelection();
    if (!selection) throw new Error("Selection not available");
    vi.spyOn(selection, "addRange").mockImplementationOnce(() => {
      throw new DOMException("Selection range is no longer valid");
    });

    act(() => {
      expect(ref.current?.appendText("按批注修改：第一条", { separateBlock: true })).toBe(true);
      expect(ref.current?.appendText("按批注修改：第二条", { separateBlock: true })).toBe(true);
    });

    expect(getSendButton().disabled).toBe(false);
    expect(ref.current?.snapshot()).toMatchObject({
      text: "按批注修改：第一条\n\n按批注修改：第二条",
      richText: "按批注修改：第一条\n\n按批注修改：第二条",
      chips: [],
    });

    const event = keyboardEvent("Enter");
    act(() => {
      edit.dispatchEvent(event);
    });
    expect(event.defaultPrevented).toBe(true);
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it("序列化并恢复时不把用户字面 chip marker 当成真实 chip", async () => {
    const ref = createRef<ChatInputHandle>();
    await render(
      <ChatInput
        {...baseFolderProps()}
        ref={ref}
        placeholder="输入"
        onSubmit={() => undefined}
      />,
    );
    const edit = getEditor();
    edit.innerHTML = [
      "请保留字面 {{chip:0}} ",
      '<span class="chat-chip" data-kind="attach" data-label="资料.pdf"></span>',
    ].join("");

    const snapshot = ref.current?.snapshot();
    expect(parseChipRichText(snapshot?.richText ?? "")).toEqual([
      { kind: "text", text: "请保留字面 {{chip:0}} " },
      { kind: "chip", index: 0, marker: "{{chip:0}}" },
    ]);

    await act(async () => {
      ref.current?.clear();
      ref.current?.restore(snapshot!);
    });

    expect(ref.current?.snapshot().richText).toBe(snapshot?.richText);
    expect(edit.textContent).toContain("请保留字面 {{chip:0}}");
    expect(edit.querySelectorAll(".chat-chip")).toHaveLength(1);
  });

  it("序列化并恢复时保留用户字面协议前缀与真实 chip", async () => {
    const protocolPrefix = "\u001eqa-chip-rich-text-v1\u001f";
    const ref = createRef<ChatInputHandle>();
    await render(
      <ChatInput
        {...baseFolderProps()}
        ref={ref}
        placeholder="输入"
        onSubmit={() => undefined}
      />,
    );
    const edit = getEditor();
    edit.innerHTML = [
      `${protocolPrefix}原文`,
      '<span class="chat-chip" data-kind="attach" data-label="资料.pdf"></span>',
    ].join("");

    const snapshot = ref.current?.snapshot();
    expect(parseChipRichText(snapshot?.richText ?? "")).toEqual([
      { kind: "text", text: `${protocolPrefix}原文` },
      { kind: "chip", index: 0, marker: "{{chip:0}}" },
    ]);

    await act(async () => {
      ref.current?.clear();
      ref.current?.restore(snapshot!);
    });
    expect(ref.current?.snapshot().richText).toBe(snapshot?.richText);
    expect(edit.textContent).toContain(`${protocolPrefix}原文`);
    expect(edit.querySelectorAll(".chat-chip")).toHaveLength(1);
  });

  it("IME 组合态 Enter 与 keyCode 229 只选字，compositionend 后首个独立 Enter 才发送", async () => {
    const onSubmit = vi.fn();
    await render(
      <ChatInput
        {...baseFolderProps()}
        placeholder="输入"
        onSubmit={onSubmit}
      />,
    );
    const edit = getEditor();
    bindInnerText(edit);

    act(() => {
      edit.dispatchEvent(compositionEvent("compositionstart"));
      edit.innerText = "ni";
      edit.dispatchEvent(inputEvent(true));
    });

    const composingEnter = keyboardEvent("Enter", { isComposing: true });
    const legacyComposingEnter = keyboardEvent("Enter", { keyCode: 229 });
    act(() => {
      edit.dispatchEvent(composingEnter);
      edit.dispatchEvent(legacyComposingEnter);
    });

    expect(composingEnter.defaultPrevented).toBe(false);
    expect(legacyComposingEnter.defaultPrevented).toBe(false);
    expect(onSubmit).not.toHaveBeenCalled();

    act(() => {
      edit.innerText = "你";
      edit.dispatchEvent(compositionEvent("compositionend"));
    });
    const independentEnter = keyboardEvent("Enter");
    act(() => {
      edit.dispatchEvent(independentEnter);
    });

    expect(independentEnter.defaultPrevented).toBe(true);
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it("空内容 Enter 阻止默认换行且不发送", async () => {
    const onSubmit = vi.fn();
    await render(
      <ChatInput
        {...baseFolderProps()}
        placeholder="输入"
        onSubmit={onSubmit}
      />,
    );

    const event = keyboardEvent("Enter");
    act(() => {
      getEditor().dispatchEvent(event);
    });

    expect(event.defaultPrevented).toBe(true);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("纯空白时发送按钮不可提交，文本、chip 或有效文件可提交", async () => {
    const onSubmit = vi.fn();
    const ref = createRef<ChatInputHandle>();
    await render(
      <ChatInput
        {...baseFolderProps()}
        ref={ref}
        placeholder="输入"
        onSubmit={onSubmit}
      />,
    );
    const edit = getEditor();
    const whitespaceSamples = ["", " ", "\u00a0", "\u3000", "\n", " \u00a0\u3000\n "];

    for (const sample of whitespaceSamples) {
      setEditorText(edit, sample);
      const sendButton = getSendButton();
      expect(sendButton.disabled).toBe(true);

      const enter = keyboardEvent("Enter");
      act(() => {
        edit.dispatchEvent(enter);
        // 直接派发 click 会绕过真实浏览器的 pointer-events；即便如此也不能提交。
        sendButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
      expect(enter.defaultPrevented).toBe(true);
    }
    expect(onSubmit).not.toHaveBeenCalled();

    setEditorText(edit, "。");
    expect(getSendButton().disabled).toBe(false);
    clickElement(getSendButton());
    expect(onSubmit).toHaveBeenCalledTimes(1);

    act(() => {
      ref.current?.clear();
      ref.current?.insertChip({ kind: "mention", label: "联网搜", skillId: "web-search" });
    });
    expect(getSendButton().disabled).toBe(false);

    act(() => {
      ref.current?.clear();
    });
    await selectFile(new File(["素材"], "brief.md", { type: "text/markdown" }));
    expect(getSendButton().disabled).toBe(false);
  });

  it("Ctrl/Cmd+Enter 仍是发送别名，发送按钮提示同步展示新键位", async () => {
    const onSubmit = vi.fn();
    await render(
      <ChatInput
        {...baseFolderProps()}
        placeholder="输入"
        onSubmit={onSubmit}
      />,
    );
    const edit = getEditor();
    setEditorText(edit, "保留肌肉记忆");

    act(() => {
      edit.dispatchEvent(keyboardEvent("Enter", { ctrlKey: true }));
      edit.dispatchEvent(keyboardEvent("Enter", { metaKey: true }));
    });

    expect(onSubmit).toHaveBeenCalledTimes(2);
    expect(host?.querySelector<HTMLButtonElement>("button[title*='Enter 发送']")?.title)
      .toBe("Enter 发送 · Shift+Enter 换行");
  });

  it("会话内文件 input 启用多选，一次选择的文件全部生成 attach chip", async () => {
    const ref = createRef<ChatInputHandle>();
    await render(
      <ChatInput
        {...baseFolderProps()}
        ref={ref}
        placeholder="输入"
        onSubmit={() => undefined}
      />,
    );
    const alpha = new File(["alpha"], "alpha.txt", { type: "text/plain" });
    const beta = new File(["beta"], "beta.txt", { type: "text/plain" });

    expect(getFileInput().multiple).toBe(true);
    await selectFiles([alpha, beta]);

    expect(ref.current?.snapshot().files.map((file) => file.name)).toEqual([
      "alpha.txt",
      "beta.txt",
    ]);
    expect(attachChipLabels()).toEqual(["alpha.txt", "beta.txt"]);
  });

  it("选择真实文件后立即进入校验中，完成前不可提交，校验通过才进入可用态", async () => {
    await render(
      <ChatInput
        {...baseFolderProps()}
        placeholder="输入"
        onSubmit={() => undefined}
      />,
    );
    let resolveBytes!: (value: ArrayBuffer) => void;
    const file = new File(["pending"], "pending.md", { type: "text/markdown" });
    const originalSlice = file.slice.bind(file);
    vi.spyOn(file, "slice").mockImplementation((start, end, contentType) => {
      const sample = originalSlice(start, end, contentType);
      Object.defineProperty(sample, "arrayBuffer", {
        configurable: true,
        value: () => new Promise<ArrayBuffer>((resolve) => {
          resolveBytes = resolve;
        }),
      });
      return sample;
    });
    const input = getFileInput();
    Object.defineProperty(input, "files", {
      configurable: true,
      value: [file],
    });
    expect(input.files).toHaveLength(1);

    act(() => {
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });

    const chip = getEditor().querySelector<HTMLElement>('[data-wf="WsAttachmentChip"]');
    expect(chip?.dataset.attachmentState).toBe("validating");
    expect(chip?.textContent).toContain("校验中");
    expect(getSendButton().disabled).toBe(true);

    resolveBytes(new TextEncoder().encode("pending").buffer);
    await waitForAttachmentValidation();
    expect(chip?.dataset.attachmentState).toBe("ready");
    expect(getSendButton().disabled).toBe(false);
  });

  it("PNG 改名 DOCX 只留下可读错误 chip 与重新选择，不进入可提交文件", async () => {
    const ref = createRef<ChatInputHandle>();
    await render(
      <ChatInput
        {...baseFolderProps()}
        ref={ref}
        placeholder="输入"
        onSubmit={() => undefined}
      />,
    );
    const fakeDocx = new File(
      [new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])],
      "A-r6-fake-image.docx",
      { type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" },
    );

    await selectFile(fakeDocx);

    const chip = getEditor().querySelector<HTMLElement>('[data-wf="WsAttachmentChip"]');
    expect(chip?.dataset.attachmentState).toBe("error");
    expect(chip?.textContent).toContain("文件格式与内容不一致");
    expect(chip?.querySelector(".c-reselect")?.textContent).toBe("重新选择");
    expect(ref.current?.snapshot().files).toEqual([]);
    expect(getSendButton().disabled).toBe(true);
  });

  it("长附件文件名中间省略并保留扩展名，短名保持原样，hover 展示全名", async () => {
    await render(
      <ChatInput
        {...baseFolderProps()}
        placeholder="输入"
        onSubmit={() => undefined}
      />,
    );
    const longName = "这是一份非常非常长的中文项目验收报告最终版.pdf";
    const shortName = "简报.md";

    await selectFiles([
      new File(["%PDF-1.7\n%%EOF"], longName, { type: "application/pdf" }),
      new File(["short"], shortName, { type: "text/markdown" }),
    ]);

    const labels = Array.from(
      getEditor().querySelectorAll<HTMLElement>('.chat-chip[data-kind="attach"] .c-label'),
    );
    expect(labels[0]?.textContent).toContain("…");
    expect(labels[0]?.textContent).toMatch(/\.pdf$/);
    expect(labels[0]?.textContent).not.toBe(longName);
    expect(labels[0]?.title).toBe(longName);
    expect(labels[1]?.textContent).toBe(shortName);
    expect(labels[1]?.title).toBe(shortName);
  });

  it("素材引用 chip 的长文件名中间省略且扩展名与完整 title 可见", async () => {
    const longName = "29887bbc-932c-408e-b5fc-93f2.png";
    await render(
      <ChatInput
        {...baseFolderProps()}
        placeholder="输入"
        onSubmit={() => undefined}
        materialParseRows={[readyMaterialRow("res-long-name", longName)]}
      />,
    );

    clickElement(getLinkedFilesBar());
    const referenceButton = Array.from(rowByText(longName).querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent?.includes("引用"));
    if (!referenceButton) throw new Error("reference button not found");
    clickElement(referenceButton);

    const label = getEditor().querySelector<HTMLElement>('.chat-chip[data-kind="attach"] .c-label');
    expect(label?.textContent).toContain("…");
    expect(label?.textContent).toMatch(/\.png$/);
    expect(label?.textContent).not.toBe(longName);
    expect(label?.title).toBe(longName);
  });

  it("不同内容的同名附件保留独立对象与 chip，不再按文件名静默去重", async () => {
    const ref = createRef<ChatInputHandle>();
    await render(
      <ChatInput
        {...baseFolderProps()}
        ref={ref}
        placeholder="输入"
        onSubmit={() => undefined}
      />,
    );

    await selectFile(new File(["a"], "report.md", { type: "text/markdown" }));
    await selectFile(new File(["b"], "report.md", { type: "text/markdown" }));

    expect(ref.current?.snapshot().files.map((file) => file.name)).toEqual([
      "report.md",
      "report.md",
    ]);
    expect(attachChipLabels()).toEqual(["report.md", "report.md"]);
    const attachmentIds = Array.from(
      getEditor().querySelectorAll<HTMLElement>(
        '.chat-chip[data-kind="attach"]',
      ),
      (chip) => chip.dataset.attachmentId,
    );
    expect(new Set(attachmentIds).size).toBe(2);
  });

  it("点击 attach chip 删除按钮时只删除对应 File 和同对象残留 chip", async () => {
    const ref = createRef<ChatInputHandle>();
    await render(
      <ChatInput
        {...baseFolderProps()}
        ref={ref}
        placeholder="输入"
        onSubmit={() => undefined}
      />,
    );
    const first = new File(["a"], "report.md", { type: "text/markdown" });
    const second = new File(["b"], "report.md", { type: "text/markdown" });
    await selectFiles([first, second]);
    const edit = getEditor();
    const chip = edit.querySelector<HTMLElement>(".chat-chip");
    if (!chip) throw new Error("attach chip not found");
    edit.appendChild(chip.cloneNode(true));
    expect(attachChipLabels()).toEqual(["report.md", "report.md", "report.md"]);

    const removeButton = edit.querySelector<HTMLElement>(".chat-chip .c-x");
    if (!removeButton) throw new Error("chip remove button not found");
    clickElement(removeButton);

    expect(ref.current?.snapshot().files).toEqual([second]);
    expect(attachChipLabels()).toEqual(["report.md"]);
  });

  it("选择文件未发送时只插 attach chip，不渲染已关联素材条", async () => {
    const ref = createRef<ChatInputHandle>();
    await render(
      <ChatInput
        {...baseFolderProps()}
        ref={ref}
        placeholder="输入"
        onSubmit={() => undefined}
      />,
    );

    await selectFile(new File(["a"], "draft.md", { type: "text/markdown" }));

    expect(ref.current?.snapshot().files.map((file) => file.name)).toEqual(["draft.md"]);
    expect(attachChipLabels()).toEqual(["draft.md"]);
    expect(host?.querySelector('[data-wf="LinkedFilesBar"]')).toBeNull();
    expect(host?.querySelector('[data-wf="LinkedFilesPanel"]')).toBeNull();
  });

  it("文件菜单选择超限文件时显示上限 toast，且不加入待发送附件", async () => {
    const ref = createRef<ChatInputHandle>();
    const onToast = vi.fn();
    await render(
      <ChatInput
        {...baseFolderProps()}
        ref={ref}
        placeholder="输入"
        onSubmit={() => undefined}
        onToast={onToast}
      />,
    );
    const oversized = new File(["x"], "52m.bin", { type: "application/octet-stream" });
    Object.defineProperty(oversized, "size", {
      value: DEFAULT_UPLOAD_MAX_BYTES + 1,
    });

    openFileMenu();
    clickElement(getChooseFileRow());
    await selectFile(oversized);

    expect(onToast).toHaveBeenCalledWith("文件过大（上传上限 50 MiB）");
    expect(ref.current?.snapshot().files).toEqual([]);
    expect(attachChipLabels()).toEqual([]);
    expect(host?.querySelector('[data-wf="WsFileMenu"]')).toBeNull();
  });

  it("工具栏只保留 技能 / 文件 两个动作入口", async () => {
    await render(
      <ChatInput
        {...baseFolderProps()}
        placeholder="输入"
        onSubmit={() => undefined}
      />,
    );

    const buttons = Array.from(
      host?.querySelectorAll<HTMLButtonElement>('[data-wf="WsFileBtn"], [data-wf="WsSkillBtn"]') ?? [],
    );
    expect(buttons.map((button) => button.dataset.wf)).toEqual(["WsSkillBtn", "WsFileBtn"]);
    expect(host?.querySelector('[data-wf="WsFolderBtn"]')).toBeNull();
  });

  it("selection chip 序列化/还原保留多行 selectionRefs", async () => {
    const ref = createRef<ChatInputHandle>();
    await render(
      <ChatInput
        {...baseFolderProps()}
        ref={ref}
        placeholder="输入"
        onSubmit={() => undefined}
      />,
    );

    act(() => {
      ref.current?.insertChip({
        kind: "sel",
        label: "第一行\n第二行",
        suffix: "批注",
        from: 10,
        to: 20,
        blockId: "item-1",
        selectionRefs: ["item-1", "item-2"],
      });
    });

    const chip = getEditor().querySelector<HTMLElement>('.chat-chip[data-kind="sel"]');
    expect(chip?.dataset.selectionRefs).toBe(JSON.stringify(["item-1", "item-2"]));
    const snapshot = ref.current?.snapshot();
    expect(snapshot?.chips[0]).toMatchObject({
      kind: "sel",
      blockId: "item-1",
      selectionRefs: ["item-1", "item-2"],
    });

    act(() => {
      ref.current?.clear();
      ref.current?.restore(snapshot!);
    });

    expect(ref.current?.snapshot().chips[0]).toMatchObject({
      kind: "sel",
      blockId: "item-1",
      selectionRefs: ["item-1", "item-2"],
    });
  });

  it("批注 chip 只显示短标签，hover 浮层确认后更新完整指令并在 snapshot 原位展开", async () => {
    const ref = createRef<ChatInputHandle>();
    await render(
      <ChatInput
        {...baseFolderProps()}
        ref={ref}
        placeholder="输入"
        onSubmit={() => undefined}
      />,
    );

    act(() => {
      ref.current?.insertChip({
        kind: "annotation",
        label: "批注·金额口径漂移",
        text: "按批注修改:「原句」——改为120亿元（原因:素材口径不一致）",
      });
    });

    const chip = getEditor().querySelector<HTMLElement>('.chat-chip[data-kind="annotation"]');
    expect(chip?.getAttribute("contenteditable")).toBe("false");
    expect(chip?.querySelector(".c-label")?.textContent).toBe("批注·金额口径漂移");
    expect(chip?.textContent).not.toContain("素材口径不一致");
    const pop = chip?.querySelector<HTMLElement>(".annotation-chip-pop");
    const textarea = pop?.querySelector<HTMLTextAreaElement>(".annotation-chip-editor");
    expect(pop).not.toBeNull();
    expect(textarea?.value).toContain("改为120亿元");

    act(() => {
      chip?.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(
        textarea,
        "按批注修改:「原句」——改为125亿元（原因:用户确认新口径）",
      );
      textarea?.dispatchEvent(new Event("input", { bubbles: true }));
    });
    clickElement(pop!.querySelector<HTMLButtonElement>(".annotation-chip-confirm")!);

    const snapshot = ref.current?.snapshot();
    expect(snapshot?.chips).toEqual([expect.objectContaining({
      kind: "annotation",
      label: "批注·金额口径漂移",
      text: "按批注修改:「原句」——改为125亿元（原因:用户确认新口径）",
    })]);
    expect(snapshot?.richText).toBe("{{chip:0}}");
    expect(snapshot?.text).toBe("按批注修改:「原句」——改为125亿元（原因:用户确认新口径）");

    act(() => {
      ref.current?.clear();
      ref.current?.restore(snapshot!);
      ref.current?.insertChip({
        kind: "annotation",
        label: "批注·日期先后错误",
        text: "按批注修改:「日期」——调整先后顺序（原因:素材时间线相反）",
      });
    });
    expect(getEditor().querySelector<HTMLTextAreaElement>(".annotation-chip-editor")?.value)
      .toBe("按批注修改:「原句」——改为125亿元（原因:用户确认新口径）");
    expect(getEditor().querySelectorAll('.chat-chip[data-kind="annotation"]')).toHaveLength(2);
  });

  it("表格 selection chip 的 snapshot/restore 保留结构化范围", async () => {
    const ref = createRef<ChatInputHandle>();
    await render(
      <ChatInput
        {...baseFolderProps()}
        ref={ref}
        placeholder="输入"
        onSubmit={() => undefined}
      />,
    );
    const tableSelection = {
      axis: "column" as const,
      startIndex: 1,
      endIndex: 2,
      signature: "fnv1a-deadbeef",
    };

    let inserted = false;
    act(() => {
      inserted = ref.current?.insertChip({
        kind: "sel",
        label: "甲\n乙",
        suffix: "表格·第2–3列",
        blockId: "table-1",
        tableSelection,
      }) ?? false;
    });

    expect(inserted).toBe(true);
    const chip = getEditor().querySelector<HTMLElement>('.chat-chip[data-kind="sel"]');
    expect(chip?.dataset.tableSelection).toBe(JSON.stringify(tableSelection));
    const snapshot = ref.current?.snapshot();
    expect(snapshot?.chips[0]?.tableSelection).toEqual(tableSelection);

    act(() => {
      ref.current?.clear();
      ref.current?.restore(snapshot!);
    });

    expect(ref.current?.snapshot().chips[0]?.tableSelection).toEqual(tableSelection);
  });

  it("insertChip 在 disabled 或编辑器卸载后返回 false", async () => {
    const disabledRef = createRef<ChatInputHandle>();
    await render(
      <ChatInput
        {...baseFolderProps()}
        ref={disabledRef}
        disabled
        placeholder="输入"
        onSubmit={() => undefined}
      />,
    );
    expect(disabledRef.current?.insertChip({ kind: "sel", label: "不可插入" })).toBe(false);
    expect(disabledRef.current?.appendText("不可追加")).toBe(false);
    expect(disabledRef.current?.openFileMenu()).toBe(false);
    expect(disabledRef.current?.snapshot().chips).toEqual([]);

    const handle = disabledRef.current!;
    act(() => root?.unmount());
    root = null;
    expect(handle.insertChip({ kind: "sel", label: "已卸载" })).toBe(false);
    expect(handle.appendText("已卸载")).toBe(false);
  });

  it("openFileMenu 复用输入框素材入口并直接打开菜单", async () => {
    const ref = createRef<ChatInputHandle>();
    await render(
      <ChatInput
        {...baseFolderProps()}
        ref={ref}
        placeholder="输入"
        onSubmit={() => undefined}
      />,
    );

    act(() => {
      expect(ref.current?.openFileMenu()).toBe(true);
    });
    expect(host?.querySelector('[data-wf="WsFileMenu"]')).not.toBeNull();
    expect(host?.querySelector('[data-wf="WsFileMenuChooseFile"]')?.textContent).toContain("选择文件");
  });

  it("removeChipAt 仅移除指定的过期表格 chip", async () => {
    const ref = createRef<ChatInputHandle>();
    await render(
      <ChatInput
        {...baseFolderProps()}
        ref={ref}
        placeholder="输入"
        onSubmit={() => undefined}
      />,
    );
    act(() => {
      ref.current?.insertChip({ kind: "attach", label: "资料.pdf" });
      ref.current?.insertChip({
        kind: "sel",
        label: "A1",
        blockId: "table-1",
        tableSelection: { axis: "row", startIndex: 0, endIndex: 0, signature: "fnv1a-deadbeef" },
      });
      ref.current?.removeChipAt(1);
    });
    expect(ref.current?.snapshot().chips).toEqual([expect.objectContaining({ kind: "attach", label: "资料.pdf" })]);
  });

  it("文件菜单连接本地文件夹：首次显示引导框，勾选后下次跳过", async () => {
    const onAttachFolder = vi.fn(async () => undefined);
    await render(
      <ChatInput
        {...baseFolderProps({ onAttachFolder })}
        placeholder="输入"
        onSubmit={() => undefined}
      />,
    );

    openFileMenu();
    clickElement(getAttachFolderRow());
    const checkbox = getFolderIntroCheckbox();
    expect(checkbox.checked).toBe(false);
    expect(onAttachFolder).not.toHaveBeenCalled();

    await setCheckbox(checkbox, true);
    await clickElementAsync(getFolderIntroContinueButton());

    expect(window.localStorage.getItem(FOLDER_INTRO_STORAGE_KEY)).toBe("1");
    expect(onAttachFolder).toHaveBeenCalledTimes(1);
    expect(host?.querySelector('[data-wf="WsFolderIntroOverlay"]')).toBeNull();

    openFileMenu();
    await clickElementAsync(getAttachFolderRow());

    expect(onAttachFolder).toHaveBeenCalledTimes(2);
    expect(host?.querySelector('[data-wf="WsFolderIntroOverlay"]')).toBeNull();
  });

  it("文件夹引导框支持取消、Escape 和遮罩关闭且不触发连接", async () => {
    const onAttachFolder = vi.fn(async () => undefined);
    await render(
      <ChatInput
        {...baseFolderProps({ onAttachFolder })}
        placeholder="输入"
        onSubmit={() => undefined}
      />,
    );

    openFileMenu();
    clickElement(getAttachFolderRow());
    clickElement(getFolderIntroCancelButton());
    expect(onAttachFolder).not.toHaveBeenCalled();
    expect(window.localStorage.getItem(FOLDER_INTRO_STORAGE_KEY)).toBeNull();
    expect(host?.querySelector('[data-wf="WsFolderIntroOverlay"]')).toBeNull();

    openFileMenu();
    clickElement(getAttachFolderRow());
    act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(host?.querySelector('[data-wf="WsFolderIntroOverlay"]')).toBeNull();

    openFileMenu();
    clickElement(getAttachFolderRow());
    clickElement(getFolderIntroOverlay());
    expect(host?.querySelector('[data-wf="WsFolderIntroOverlay"]')).toBeNull();
    expect(onAttachFolder).not.toHaveBeenCalled();
  });

  it("已连接时文件菜单第二行展示文件夹名、呼吸绿点和断开入口", async () => {
    await render(
      <ChatInput
        {...baseFolderProps({ folderSource: mockFolderSource })}
        placeholder="输入"
        onSubmit={() => undefined}
      />,
    );

    openFileMenu();
    const row = getFolderStatusRow();
    expect(row.textContent).toContain("客户资料");
    expect(row.textContent).toContain("已连接 · 点击查看与管理");
    expect(row.querySelector(".qa-file-folder-dot")).not.toBeNull();
    expect(getMenuDisconnectButton()).not.toBeNull();
    expect(host?.querySelector('[data-wf="WsFolderPopover"]')).toBeNull();
  });

  it("点已连接状态行本体会展开已关联素材树并收起菜单", async () => {
    await render(
      <ChatInput
        {...baseFolderProps({
          folderSource: mockFolderSource,
        })}
        placeholder="输入"
        onSubmit={() => undefined}
      />,
    );

    openFileMenu();
    clickElement(getFolderStatusRow());

    expect(host?.querySelector('[data-wf="WsFileMenu"]')).toBeNull();
    expect(host?.querySelector('[data-wf="LinkedFilesPanel"]')).not.toBeNull();
    expect(host?.querySelector('[data-wf="LinkedFolderRootRow"]')?.textContent).toContain("客户资料");
  });

  it("进入已关联文件夹的会话时素材树保持收起", async () => {
    await render(
      <ChatInput {...baseFolderProps()} placeholder="输入" onSubmit={() => undefined} />,
    );
    // 会话数据异步到达：folderSource 由 null 变为已连接。
    await rerender(
      <ChatInput
        {...baseFolderProps({ folderSource: mockFolderSource })}
        placeholder="输入"
        onSubmit={() => undefined}
      />,
    );

    expect(host?.querySelector('[data-wf="LinkedFilesPanel"]')).toBeNull();
    expect(getLinkedFilesBar().textContent).toContain("文件夹「客户资料」");
  });

  it("本会话完成关联动作后素材树在 folderSource 到达时自动展开", async () => {
    window.localStorage.setItem(FOLDER_INTRO_STORAGE_KEY, "1");
    const onAttachFolder = vi.fn(async () => undefined);
    await render(
      <ChatInput
        {...baseFolderProps({ onAttachFolder })}
        placeholder="输入"
        onSubmit={() => undefined}
      />,
    );

    openFileMenu();
    await clickElementAsync(getAttachFolderRow());
    expect(onAttachFolder).toHaveBeenCalledTimes(1);

    await rerender(
      <ChatInput
        {...baseFolderProps({ folderSource: mockFolderSource, onAttachFolder })}
        placeholder="输入"
        onSubmit={() => undefined}
      />,
    );

    expect(host?.querySelector('[data-wf="LinkedFilesPanel"]')).not.toBeNull();
    expect(host?.querySelector('[data-wf="LinkedFolderRootRow"]')?.classList.contains("is-located")).toBe(true);
  });

  it("文件夹子文件引用把 folderId 与完整相对路径写入 chip", async () => {
    const ref = createRef<ChatInputHandle>();
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      return Promise.resolve(new Response(JSON.stringify({
        entries: url.includes("path=%E9%83%A8%E9%97%A8%E7%94%B2")
          ? [{ name: "报告.md", kind: "file", childCount: null, byteLen: 12 }]
          : [{ name: "部门甲", kind: "dir", childCount: 1, byteLen: null }],
        truncated: false,
        nextCursor: null,
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }));
    }));
    await render(
      <ChatInput
        {...baseFolderProps({ folderSource: mockFolderSource })}
        ref={ref}
        placeholder="输入"
        onSubmit={() => undefined}
      />,
    );

    clickElement(getLinkedFilesBar());
    await clickElementAsync(host!.querySelector<HTMLElement>('[data-wf="LinkedFolderRootRow"]')!);
    await clickElementAsync(rowByText("部门甲"));
    clickElement(
      Array.from(rowByText("报告.md").querySelectorAll<HTMLButtonElement>("button"))
        .find((button) => button.textContent?.includes("引用"))!,
    );

    expect(ref.current?.snapshot().chips).toEqual([expect.objectContaining({
      kind: "attach",
      label: "部门甲/报告.md",
      resourceId: "folder:fld_test:%E9%83%A8%E9%97%A8%E7%94%B2%2F%E6%8A%A5%E5%91%8A.md",
    })]);
  });

  it("已关联素材行点击会透传 onPreviewMaterial", async () => {
    const onPreviewMaterial = vi.fn();
    await render(
      <ChatInput
        {...baseFolderProps()}
        placeholder="输入"
        onSubmit={() => undefined}
        materialParseRows={[readyMaterialRow("res-preview", "preview.pdf")]}
        onPreviewMaterial={onPreviewMaterial}
      />,
    );

    clickElement(getLinkedFilesBar());
    clickElement(rowByText("preview.pdf"));

    expect(onPreviewMaterial).toHaveBeenCalledTimes(1);
    expect(onPreviewMaterial).toHaveBeenCalledWith(expect.objectContaining({
      id: "res-preview",
      name: "preview.pdf",
      fileId: "file-res-preview",
    }));
  });

  it("菜单断开按钮打开断开确认，不调选择器", async () => {
    const onAttachFolder = vi.fn(async () => undefined);
    const onDetachFolder = vi.fn(async () => undefined);
    await render(
      <ChatInput
        {...baseFolderProps({ folderSource: mockFolderSource, onAttachFolder, onDetachFolder })}
        placeholder="输入"
        onSubmit={() => undefined}
      />,
    );

    openFileMenu();
    clickElement(getMenuDisconnectButton());

    expect(onAttachFolder).not.toHaveBeenCalled();
    expect(host?.textContent).toContain("断开「客户资料」连接？");
    expect(host?.textContent).toContain("文件不会被删除");

    await clickElementAsync(getDisconnectConfirmButton());

    expect(onDetachFolder).toHaveBeenCalledWith("fld_test");
  });

  it("capability 不支持时仅置灰连接文件夹行，选择文件不受影响", async () => {
    const onAttachFolder = vi.fn(async () => undefined);
    let inputClicked = 0;
    await render(
      <ChatInput
        {...baseFolderProps({
          folderCapability: { enabled: false, reason: "网页版暂未开放" },
          onAttachFolder,
        })}
        placeholder="输入"
        onSubmit={() => undefined}
      />,
    );
    const input = getFileInput();
    vi.spyOn(input, "click").mockImplementation(() => {
      inputClicked += 1;
    });

    openFileMenu();
    const row = getAttachFolderRow();
    expect(row.disabled).toBe(true);
    expect(row.classList.contains("is-disabled")).toBe(true);
    expect(row.textContent).toContain("网页版暂未开放");
    clickElement(row);
    expect(onAttachFolder).not.toHaveBeenCalled();
    clickElement(getChooseFileRow());
    expect(inputClicked).toBe(1);
  });

  it("文件按钮只开关菜单并用 is-active 高亮，不显示文件计数", async () => {
    await render(
      <ChatInput
        {...baseFolderProps()}
        placeholder="输入"
        onSubmit={() => undefined}
      />,
    );

    const button = getFileButton();
    expect(button.textContent?.trim()).toBe("素材");
    expect(button.classList.contains("is-active")).toBe(false);

    clickElement(button);
    expect(button.classList.contains("is-active")).toBe(true);
    expect(getFileMenu()).not.toBeNull();

    clickElement(button);
    expect(button.classList.contains("is-active")).toBe(false);
    expect(host?.querySelector('[data-wf="WsFileMenu"]')).toBeNull();
  });

  it("文件菜单支持 Esc 和点外部关闭", async () => {
    await render(
      <ChatInput
        {...baseFolderProps()}
        placeholder="输入"
        onSubmit={() => undefined}
      />,
    );

    openFileMenu();
    act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(host?.querySelector('[data-wf="WsFileMenu"]')).toBeNull();

    openFileMenu();
    act(() => {
      document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    });
    expect(host?.querySelector('[data-wf="WsFileMenu"]')).toBeNull();
  });

  it("文件菜单与技能菜单互斥", async () => {
    await render(
      <ChatInput
        {...baseFolderProps()}
        placeholder="输入"
        onSubmit={() => undefined}
      />,
    );

    openFileMenu();
    expect(getFileMenu()).not.toBeNull();
    clickElement(getSkillButton());
    expect(host?.querySelector('[data-wf="WsFileMenu"]')).toBeNull();
    expect(host?.querySelector('[data-wf="SkillMenu"]')).not.toBeNull();

    openFileMenu();
    expect(host?.querySelector('[data-wf="SkillMenu"]')).toBeNull();
    expect(getFileMenu()).not.toBeNull();
  });

  it("技能菜单由 API 自动准入：只显示已启用且 userInvocable 的技能", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        if (String(input).endsWith("/api/v1/skills")) {
          return new Response(
            JSON.stringify({
              skills: [
                {
                  name: "web-search",
                  description: "联网调研",
                  label: "联网搜",
                  summary: "搜资料、核事实、找出处",
                  icon: "search",
                  source: "builtin",
                  userInvocable: true,
                  placeholder: "搜索主题",
                  tools: ["webSearch"],
                  enabled: true,
                },
                {
                  name: "doc-calc",
                  description: "精确计算",
                  label: "算数据",
                  summary: "表格统计与精确计算",
                  icon: "calc",
                  source: "builtin",
                  userInvocable: true,
                  tools: ["run_js"],
                  enabled: false,
                },
                {
                  name: "materials",
                  description: "素材",
                  label: "读资料",
                  summary: "读取上传文件与资料库并引用",
                  icon: "materials",
                  source: "builtin",
                  userInvocable: false,
                  tools: ["readDocument", "searchDocuments"],
                  enabled: true,
                },
                {
                  name: "custom-research",
                  description: "自装研究技能",
                  label: "研资料",
                  summary: "整理用户资料",
                  icon: "star",
                  source: "installed",
                  userInvocable: true,
                  placeholder: "说明资料",
                  tools: [],
                  enabled: true,
                },
              ],
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        return new Response("{}", { status: 200 });
      }),
    );
    await render(
      <ChatInput
        {...baseFolderProps()}
        placeholder="输入"
        onSubmit={() => undefined}
      />,
    );
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });

    clickElement(getSkillButton());
    const menu = host?.querySelector<HTMLElement>('[data-wf="SkillMenu"]');
    expect(menu?.textContent).toContain("联网搜");
    expect(menu?.textContent).toContain("搜资料、核事实、找出处");
    expect(menu?.textContent).toContain("研资料");
    expect(menu?.textContent).not.toContain("算数据");
    expect(menu?.textContent).not.toContain("读资料");
  });

  it("技能变更事件会刷新已挂载输入框菜单", async () => {
    const ref = createRef<ChatInputHandle>();
    let skillsPayload = [
      skillPayload({
        name: "web-search",
        label: "联网搜",
        summary: "搜资料、核事实、找出处",
        icon: "search",
        userInvocable: true,
        enabled: true,
      }),
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        if (String(input).endsWith("/api/v1/skills")) {
          return new Response(JSON.stringify({ skills: skillsPayload }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response("{}", { status: 200 });
      }),
    );
    await render(
      <ChatInput
        {...baseFolderProps()}
        ref={ref}
        placeholder="输入"
        onSubmit={() => undefined}
      />,
    );
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });

    clickElement(getSkillButton());
    expect(host?.querySelector('[data-wf="SkillMenu"]')?.textContent).toContain("联网搜");
    expect(host?.querySelector('[data-wf="SkillMenu"]')?.textContent).not.toContain("研资料");

    skillsPayload = [
      skillPayload({
        name: "web-search",
        label: "联网搜",
        summary: "搜资料、核事实、找出处",
        icon: "search",
        userInvocable: true,
        enabled: false,
      }),
      skillPayload({
        name: "custom-research",
        label: "研资料",
        summary: "整理用户资料",
        icon: "star",
        userInvocable: true,
        enabled: true,
        source: "installed",
      }),
    ];
    await act(async () => {
      window.dispatchEvent(new Event(SKILLS_CHANGED_EVENT));
      await new Promise((r) => setTimeout(r, 0));
    });

    const menu = host?.querySelector<HTMLElement>('[data-wf="SkillMenu"]');
    expect(menu?.textContent).toContain("研资料");
    expect(menu?.textContent).not.toContain("联网搜");

    const row = Array.from(host?.querySelectorAll<HTMLButtonElement>(".qa-skill-row") ?? []).find((node) =>
      node.textContent?.includes("研资料"),
    );
    if (!row) throw new Error("imported skill row not found");
    await act(async () => {
      row.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    });

    const chip = getEditor().querySelector<HTMLElement>('.chat-chip[data-kind="mention"]');
    expect(chip?.dataset.skillId).toBe("custom-research");
    expect(chip?.dataset.label).toBe("研资料");
    expect(ref.current?.snapshot().skills).toEqual([{ id: "custom-research", version: null }]);
  });
});

const mockFolderSource: FolderSource = {
  id: "fld_test",
  sessionId: "s1",
  provider: "desktop-local",
  name: "客户资料",
  pathLabel: "~/Documents/客户资料",
  mountName: "source_test",
  mountPath: "/sources/source_test",
  readOnly: true,
  fileCount: 14,
  fileCountCapped: false,
  status: "connected",
  error: null,
  createdAt: "2026-06-18T00:00:00.000Z",
  updatedAt: "2026-06-18T00:00:00.000Z",
};

function baseFolderProps(overrides: Partial<FolderInputProps> = {}): FolderInputProps {
  return {
    folderSource: null,
    folderCapability: { enabled: true, reason: null },
    onAttachFolder: vi.fn(async () => undefined),
    onDetachFolder: vi.fn(async () => undefined),
    ...overrides,
  };
}

function skillPayload(overrides: Partial<{
  name: string;
  description: string;
  label: string;
  summary: string;
  icon: string;
  source: "builtin" | "installed";
  userInvocable: boolean;
  placeholder?: string;
  tools: string[];
  enabled: boolean;
}> = {}) {
  const name = overrides.name ?? "web-search";
  const summary = overrides.summary ?? "技能简介";
  return {
    name,
    description: overrides.description ?? summary,
    label: overrides.label ?? name.slice(0, 6),
    summary,
    icon: overrides.icon ?? "star",
    source: overrides.source ?? "builtin",
    userInvocable: overrides.userInvocable ?? false,
    placeholder: overrides.placeholder,
    tools: overrides.tools ?? [],
    enabled: overrides.enabled ?? true,
  };
}

async function render(element: ReactNode): Promise<void> {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(element);
  });
}

async function rerender(element: ReactNode): Promise<void> {
  await act(async () => {
    root?.render(element);
    await Promise.resolve();
    await Promise.resolve();
  });
}

function getEditor(): HTMLDivElement {
  const edit = host?.querySelector<HTMLDivElement>('[data-wf="ChatInput"]');
  if (!edit) throw new Error("ChatInput editor not found");
  return edit;
}

function getFileInput(): HTMLInputElement {
  const input = host?.querySelector<HTMLInputElement>('input[type="file"]');
  if (!input) throw new Error("file input not found");
  return input;
}

function getFileButton(): HTMLButtonElement {
  const button = host?.querySelector<HTMLButtonElement>('[data-wf="WsFileBtn"]');
  if (!button) throw new Error("file button not found");
  return button;
}

function getSkillButton(): HTMLButtonElement {
  const button = host?.querySelector<HTMLButtonElement>('[data-wf="WsSkillBtn"]');
  if (!button) throw new Error("skill button not found");
  return button;
}

function getSendButton(): HTMLButtonElement {
  const button = host?.querySelector<HTMLButtonElement>('[data-wf="WsSendBtn"]');
  if (!button) throw new Error("send button not found");
  return button;
}

function getFileMenu(): HTMLElement {
  const menu = host?.querySelector<HTMLElement>('[data-wf="WsFileMenu"]');
  if (!menu) throw new Error("file menu not found");
  return menu;
}

function getLinkedFilesBar(): HTMLElement {
  const bar = host?.querySelector<HTMLElement>('[data-wf="LinkedFilesBar"]');
  if (!bar) throw new Error("linked files bar not found");
  return bar;
}

function rowByText(text: string): HTMLElement {
  const row = Array.from(host?.querySelectorAll<HTMLElement>(".lf-row") ?? []).find((item) =>
    item.textContent?.includes(text),
  );
  if (!row) throw new Error(`row not found: ${text}`);
  return row;
}

function getChooseFileRow(): HTMLButtonElement {
  const row = host?.querySelector<HTMLButtonElement>('[data-wf="WsFileMenuChooseFile"]');
  if (!row) throw new Error("choose file row not found");
  return row;
}

function getAttachFolderRow(): HTMLButtonElement {
  const row = host?.querySelector<HTMLButtonElement>('[data-wf="WsFileMenuAttachFolder"]');
  if (!row) throw new Error("attach folder row not found");
  return row;
}

function getFolderStatusRow(): HTMLElement {
  const row = host?.querySelector<HTMLElement>('[data-wf="WsFileMenuFolderStatus"]');
  if (!row) throw new Error("folder status row not found");
  return row;
}

function getMenuDisconnectButton(): HTMLButtonElement {
  const button = host?.querySelector<HTMLButtonElement>('[data-wf="WsFileMenuDisconnect"]');
  if (!button) throw new Error("menu disconnect button not found");
  return button;
}

function getFolderIntroCheckbox(): HTMLInputElement {
  const checkbox = host?.querySelector<HTMLInputElement>('[data-wf="WsFolderIntroOverlay"] input[type="checkbox"]');
  if (!checkbox) throw new Error("folder intro checkbox not found");
  return checkbox;
}

function getFolderIntroOverlay(): HTMLElement {
  const overlay = host?.querySelector<HTMLElement>('[data-wf="WsFolderIntroOverlay"]');
  if (!overlay) throw new Error("folder intro overlay not found");
  return overlay;
}

function openFileMenu(): void {
  clickElement(getFileButton());
}

function getFolderIntroContinueButton(): HTMLButtonElement {
  const button = Array.from(host?.querySelectorAll<HTMLButtonElement>(".ws-folder-modal-primary") ?? []).find(
    (node) => node.textContent?.includes("我知道了，选择文件夹"),
  );
  if (!button) throw new Error("folder intro continue button not found");
  return button;
}

function getFolderIntroCancelButton(): HTMLButtonElement {
  const button = Array.from(host?.querySelectorAll<HTMLButtonElement>(".ws-folder-modal-secondary") ?? []).find(
    (node) => node.textContent?.includes("取消"),
  );
  if (!button) throw new Error("folder intro cancel button not found");
  return button;
}

function getDisconnectConfirmButton(): HTMLButtonElement {
  const button = Array.from(host?.querySelectorAll<HTMLButtonElement>(".ws-folder-modal-danger") ?? []).find(
    (node) => node.textContent?.includes("断开连接"),
  );
  if (!button) throw new Error("disconnect confirm button not found");
  return button;
}

function attachChipLabels(): string[] {
  return Array.from(getEditor().querySelectorAll<HTMLElement>('.chat-chip[data-kind="attach"]')).map(
    (chip) => chip.dataset.label ?? "",
  );
}

async function selectFile(file: File): Promise<void> {
  await selectFiles([file]);
}

async function selectFiles(files: File[]): Promise<void> {
  const input = getFileInput();
  Object.defineProperty(input, "files", {
    configurable: true,
    value: files,
  });
  await act(async () => {
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await waitForAttachmentValidation();
}

async function waitForAttachmentValidation(): Promise<void> {
  await vi.waitFor(() => {
    expect(
      getEditor().querySelector('[data-attachment-state="validating"]'),
    ).toBeNull();
  });
}

function clickElement(element: HTMLElement): void {
  act(() => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

async function clickElementAsync(element: HTMLElement): Promise<void> {
  await act(async () => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

async function setCheckbox(element: HTMLInputElement, checked: boolean): Promise<void> {
  await act(async () => {
    if (element.checked !== checked) {
      element.click();
    }
  });
}

function bindInnerText(element: HTMLElement): void {
  Object.defineProperty(element, "innerText", {
    configurable: true,
    get: () => element.textContent ?? "",
    set: (value: string) => {
      element.textContent = value;
    },
  });
}

function setEditorText(element: HTMLElement, text: string): void {
  bindInnerText(element);
  act(() => {
    element.innerText = text;
    element.dispatchEvent(inputEvent(false));
  });
}

function keyboardEvent(
  key: string,
  init: KeyboardEventInit & { keyCode?: number } = {},
): KeyboardEvent {
  const event = new KeyboardEvent("keydown", {
    key,
    bubbles: true,
    cancelable: true,
    ...init,
  });
  if (init.keyCode !== undefined && event.keyCode !== init.keyCode) {
    Object.defineProperty(event, "keyCode", {
      configurable: true,
      value: init.keyCode,
    });
  }
  return event;
}

function compositionEvent(type: "compositionstart" | "compositionend"): Event {
  if (typeof CompositionEvent === "function") {
    return new CompositionEvent(type, { bubbles: true, cancelable: true });
  }
  return new Event(type, { bubbles: true, cancelable: true });
}

function inputEvent(isComposing: boolean): Event {
  if (typeof InputEvent === "function") {
    return new InputEvent("input", {
      bubbles: true,
      cancelable: true,
      inputType: "insertText",
      isComposing,
    } as InputEventInit);
  }
  const event = new Event("input", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "isComposing", {
    configurable: true,
    value: isComposing,
  });
  return event;
}

function readyMaterialRow(id: string, filename: string): MaterialParseRow {
  const resource = resourceFor(id, filename, { fileId: `file-${id}` });
  return {
    id,
    fileId: `file-${id}`,
    filename,
    mime: "application/pdf",
    state: "ready",
    parseError: null,
    resource,
    source: "resource",
  };
}

function resourceFor(id: string, displayName: string, metadata: unknown): Resource {
  return {
    resourceRef: { id, domain: { kind: "file" } },
    displayName,
    summary: "",
    mime: "application/pdf",
    byteLen: 8200,
    createdAt: "2026-07-04T00:00:00.000Z",
    metadata,
  };
}
