import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import {
  buildLongTextChip,
  collectClipboardImageFiles,
  longTextChipFromClick,
  shouldCollapsePastedText,
  LongTextFullscreen,
} from "../../../system/longText";

export interface ChipSpec {
  /** chip 的稳定 id；附件 chip 用它同步父组件状态。 */
  id?: string;
  /** Source kind, e.g. "yuque", "pdf", "md". */
  type: string;
  /** Display name shown inside the chip. */
  name: string;
}

export interface StarterEditorHandle {
  /** Insert a `[name]` chip at the current cursor (or at end if unfocused). */
  insertChip: (spec: ChipSpec) => void;
  /** Insert plain text at the current cursor. */
  insertText: (text: string) => void;
  /** Replace the entire content with plain text and place cursor at end. */
  setText: (text: string) => void;
  /** Focus the editor. */
  focus: () => void;
  /**
   * Snapshot current content without forcing a re-render(0702 WYSIWYG 重构):
   * - text:仅打字文本(chip 剥除)——发给服务端的 text;
   * - richText:按 DOM 顺序的文本 + `{{chip:N}}` 占位——气泡按它渲染,与输入框所见一致;
   * - chips:按 DOM 顺序的 chip 规格(N 即数组下标),chip 可穿插在文本任意位置。
   * 输入框 DOM 是唯一真相源:提交方从这里派生一切(含技能),不另设并行状态。
   */
  snapshot: () => { text: string; richText: string; chips: ChipSpec[] };
}

export interface StarterEditorProps {
  placeholder: string;
  /** Called when the user types or chips change. */
  onChange: (text: string, chips: number) => void;
  /** Called on Cmd/Ctrl+Enter. */
  onSubmit: () => void;
  /** chip 从编辑器 DOM 删除时通知父组件同步状态。 */
  onRemoveChip?: (spec: ChipSpec) => void;
  /** 父级先于编辑器拦截按键(技能菜单 ↑/↓/Enter/反斜杠唤起)。返回 true = 已处理,编辑器不再处理。 */
  onKeyDownCapture?: (e: React.KeyboardEvent<HTMLDivElement>) => boolean;
  /** 粘贴图片 → 交父级走上传文件链路(与编辑页一致,变成待解析附件)。 */
  onPasteFiles?: (files: File[]) => void;
}

/** 编辑器纯文本抽取:长文本小条原位展开回完整原文(保留其换行),其余 chip 剔除。 */
function extractEditorText(edit: HTMLElement): string {
  let out = "";
  const walk = (node: Node) => {
    if (node.nodeType === Node.ELEMENT_NODE) {
      const el = node as HTMLElement;
      if (el.classList.contains("chat-chip-longtext")) {
        out += el.dataset.text ?? "";
        return;
      }
      if (el.classList.contains("src-chip")) return;
      if (el.tagName === "BR") return; // 原行为:starter 输入吐出时不保留换行
    }
    if (node.nodeType === Node.TEXT_NODE) {
      out += node.textContent ?? "";
      return;
    }
    for (const c of node.childNodes) walk(c);
  };
  for (const c of edit.childNodes) walk(c);
  return out;
}

/**
 * Encapsulates the wireframe's contenteditable starter input.
 *
 * The DOM is uncontrolled (the browser drives caret + selection); we
 * sync OUT via `onChange` after every input/blur. Chip insertion is
 * driven imperatively via the ref handle, which uses Range/Selection
 * to splice nodes at the caret — this matches the wireframe behavior
 * exactly while keeping the rest of the page idiomatic React.
 */
export const StarterEditor = forwardRef<StarterEditorHandle, StarterEditorProps>(
  function StarterEditor({ placeholder, onChange, onSubmit, onRemoveChip, onKeyDownCapture, onPasteFiles }, ref) {
    const editRef = useRef<HTMLDivElement>(null);
    /** Last known caret range while the editor was focused. */
    const savedRangeRef = useRef<Range | null>(null);
    // 长文本小条点击 → 全屏查看的原文(null = 不显示)。
    const [longTextView, setLongTextView] = useState<string | null>(null);

    const captureRange = useCallback(() => {
      const sel = window.getSelection();
      if (!sel || sel.rangeCount === 0) return;
      const r = sel.getRangeAt(0);
      if (editRef.current && editRef.current.contains(r.commonAncestorContainer)) {
        savedRangeRef.current = r.cloneRange();
      }
    }, []);

    const restoreOrEndRange = useCallback((): Range => {
      const edit = editRef.current!;
      const sel = window.getSelection()!;
      // Prefer current live selection if still inside the editor.
      if (sel.rangeCount > 0 && edit.contains(sel.anchorNode)) {
        return sel.getRangeAt(0);
      }
      // Fall back to the last captured range.
      if (savedRangeRef.current && edit.contains(savedRangeRef.current.startContainer)) {
        sel.removeAllRanges();
        sel.addRange(savedRangeRef.current);
        return savedRangeRef.current;
      }
      // Otherwise: collapse to end.
      const r = document.createRange();
      r.selectNodeContents(edit);
      r.collapse(false);
      sel.removeAllRanges();
      sel.addRange(r);
      return r;
    }, []);

    const reportChange = useCallback(() => {
      const edit = editRef.current;
      if (!edit) return;
      const text = extractEditorText(edit).replace(/\r?\n/g, "");
      const chips = edit.querySelectorAll(".src-chip").length;
      onChange(text, chips);
    }, [onChange]);

    const notifyRemovedChips = useCallback(
      (chips: Iterable<HTMLElement>) => {
        for (const chip of chips) {
          onRemoveChip?.(readChipNode(chip));
        }
      },
      [onRemoveChip],
    );

    const removeChipNode = useCallback(
      (chip: HTMLElement) => {
        notifyRemovedChips([chip]);
        chip.remove();
        reportChange();
      },
      [notifyRemovedChips, reportChange],
    );

    useImperativeHandle(
      ref,
      (): StarterEditorHandle => ({
        focus() {
          editRef.current?.focus();
        },
        snapshot() {
          const edit = editRef.current;
          if (!edit) return { text: "", richText: "", chips: [] };
          let text = "";
          let richText = "";
          const chips: ChipSpec[] = [];
          const walk = (node: Node) => {
            if (node.nodeType === Node.TEXT_NODE) {
              const t = (node.textContent ?? "").replace(/\r?\n/g, "");
              text += t;
              richText += t;
              return;
            }
            if (node instanceof HTMLElement && node.classList.contains("src-chip")) {
              richText += `{{chip:${chips.length}}}`;
              chips.push(readChipNode(node));
              return;
            }
            node.childNodes.forEach(walk);
          };
          edit.childNodes.forEach(walk);
          return { text, richText, chips };
        },
        insertText(text) {
          const edit = editRef.current;
          if (!edit) return;
          edit.focus();
          const r = restoreOrEndRange();
          r.deleteContents();
          const node = document.createTextNode(text);
          r.insertNode(node);
          const r2 = document.createRange();
          r2.setStartAfter(node);
          r2.collapse(true);
          const sel = window.getSelection()!;
          sel.removeAllRanges();
          sel.addRange(r2);
          savedRangeRef.current = r2.cloneRange();
          reportChange();
        },
        insertChip(spec) {
          const edit = editRef.current;
          if (!edit) return;
          edit.focus();
          const r = restoreOrEndRange();
          r.deleteContents();
          const chip = makeChipNode(spec);
          r.insertNode(chip);
          const space = document.createTextNode(" ");
          chip.after(space);
          const r2 = document.createRange();
          r2.setStartAfter(space);
          r2.collapse(true);
          const sel = window.getSelection()!;
          sel.removeAllRanges();
          sel.addRange(r2);
          savedRangeRef.current = r2.cloneRange();
          reportChange();
        },
        setText(text) {
          const edit = editRef.current;
          if (!edit) return;
          notifyRemovedChips(edit.querySelectorAll<HTMLElement>(".src-chip"));
          while (edit.firstChild) edit.removeChild(edit.firstChild);
          if (text) edit.appendChild(document.createTextNode(text));
          edit.focus();
          const r = document.createRange();
          r.selectNodeContents(edit);
          r.collapse(false);
          const sel = window.getSelection()!;
          sel.removeAllRanges();
          sel.addRange(r);
          savedRangeRef.current = r.cloneRange();
          reportChange();
        },
      }),
      [restoreOrEndRange, reportChange, notifyRemovedChips],
    );

    // Removal of a chip via its built-in × button: bubble up by class。
    // 长文本小条:× 移除;点本体 → 全屏看原文。
    const handleClick = useCallback(
      (e: React.MouseEvent<HTMLDivElement>) => {
        const target = e.target as HTMLElement;
        if (target.classList.contains("c-x")) {
          const chip = target.closest(".src-chip") as HTMLElement | null;
          if (chip) {
            e.preventDefault();
            e.stopPropagation();
            removeChipNode(chip);
            return;
          }
          const longChip = target.closest(".chat-chip-longtext") as HTMLElement | null;
          if (longChip) {
            e.preventDefault();
            e.stopPropagation();
            longChip.remove();
            reportChange();
          }
          return;
        }
        const longChip = longTextChipFromClick(target);
        if (longChip?.dataset.text != null) {
          e.preventDefault();
          setLongTextView(longChip.dataset.text);
        }
      },
      [removeChipNode, reportChange],
    );

    const handleKey = useCallback(
      (e: React.KeyboardEvent<HTMLDivElement>) => {
        if (onKeyDownCapture?.(e)) return;
        if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
          e.preventDefault();
          onSubmit();
          return;
        }
        if (e.key === "Backspace") {
          // Delete a chip directly to the left of an empty caret.
          const sel = window.getSelection();
          if (!sel || sel.rangeCount === 0) return;
          const range = sel.getRangeAt(0);
          if (!range.collapsed) return;
          const isRemovableChip = (el: HTMLElement | null | undefined): el is HTMLElement =>
            !!el?.classList && (el.classList.contains("src-chip") || el.classList.contains("chat-chip-longtext"));
          const n = range.startContainer;
          if (range.startOffset === 0 && n.previousSibling) {
            const sib = n.previousSibling as HTMLElement;
            if (isRemovableChip(sib)) {
              e.preventDefault();
              removeChipNode(sib);
              return;
            }
          }
          if (n.nodeType === Node.ELEMENT_NODE) {
            const prev = (n as HTMLElement).childNodes[range.startOffset - 1] as HTMLElement | null;
            if (isRemovableChip(prev)) {
              e.preventDefault();
              removeChipNode(prev);
              return;
            }
          }
        }
      },
      [onSubmit, removeChipNode, onKeyDownCapture],
    );

    // 粘贴超长文本 → 折叠成长文本小条插在光标处(与编辑页一致,snapshot 时原位展开)。
    const insertLongTextChip = useCallback(
      (text: string) => {
        const edit = editRef.current;
        if (!edit) return;
        edit.focus();
        const r = restoreOrEndRange();
        r.deleteContents();
        const chip = buildLongTextChip(text);
        r.insertNode(chip);
        const space = document.createTextNode(" ");
        chip.after(space);
        const r2 = document.createRange();
        r2.setStartAfter(space);
        r2.collapse(true);
        const sel = window.getSelection()!;
        sel.removeAllRanges();
        sel.addRange(r2);
        savedRangeRef.current = r2.cloneRange();
        reportChange();
      },
      [restoreOrEndRange, reportChange],
    );

    const handlePaste = useCallback(
      (e: React.ClipboardEvent<HTMLDivElement>) => {
        e.preventDefault();
        const data = e.clipboardData;
        const text = data.getData("text/plain") || "";
        // 图片:无实质文本时走上传文件链路(交父级 handleFilesPicked 一致处理)。
        if (!text.trim()) {
          const images = collectClipboardImageFiles(data);
          if (images.length > 0) {
            onPasteFiles?.(images);
            return;
          }
        }
        if (!text) return;
        // 超长文本 → 折叠小条;否则纯文本插入光标处。
        if (shouldCollapsePastedText(text)) {
          insertLongTextChip(text);
          return;
        }
        // document.execCommand 已废弃但仍是 contenteditable 纯文本插入最简跨浏览器路径。
        document.execCommand("insertText", false, text);
      },
      [onPasteFiles, insertLongTextChip],
    );

    // Track caret continuously so chip insertion has a target even
    // when a button click moved focus to the toolbar.
    useEffect(() => {
      const onSelectionChange = () => captureRange();
      document.addEventListener("selectionchange", onSelectionChange);
      return () => document.removeEventListener("selectionchange", onSelectionChange);
    }, [captureRange]);

    return (
      <>
        <div
          ref={editRef}
          className="starter-edit"
          data-wf="StarterInput"
          data-placeholder={placeholder}
          contentEditable
          suppressContentEditableWarning
          role="textbox"
          aria-multiline="true"
          tabIndex={0}
          onInput={reportChange}
          onKeyDown={handleKey}
          onPaste={handlePaste}
          onClick={handleClick}
          onBlur={captureRange}
        />
        {longTextView !== null && (
          <LongTextFullscreen text={longTextView} onClose={() => setLongTextView(null)} />
        )}
      </>
    );
  },
);

function makeChipNode(spec: ChipSpec): HTMLSpanElement {
  const chip = document.createElement("span");
  chip.className = "src-chip";
  chip.setAttribute("contenteditable", "false");
  if (spec.id) chip.dataset.chipId = spec.id;
  chip.dataset.type = spec.type;
  chip.dataset.name = spec.name;
  if (spec.type === "skill") {
    const icon = document.createElement("span");
    icon.className = "c-skill-ico";
    const label = document.createElement("span");
    label.className = "c-skill-label";
    label.textContent = spec.name;
    const x = document.createElement("span");
    x.className = "c-x";
    x.title = "移除";
    x.textContent = "×";
    chip.appendChild(icon);
    chip.appendChild(label);
    chip.appendChild(x);
    return chip;
  }
  // Use textContent on intermediate nodes to keep this XSS-safe.
  const open = document.createElement("span");
  open.className = "c-br";
  open.textContent = "[";
  const label = document.createTextNode(spec.name);
  const close = document.createElement("span");
  close.className = "c-br";
  close.textContent = "]";
  const x = document.createElement("span");
  x.className = "c-x";
  x.title = "移除";
  x.textContent = "×";
  chip.appendChild(open);
  chip.appendChild(label);
  chip.appendChild(close);
  chip.appendChild(x);
  return chip;
}

function readChipNode(chip: HTMLElement): ChipSpec {
  return {
    ...(chip.dataset.chipId ? { id: chip.dataset.chipId } : {}),
    type: chip.dataset.type ?? "",
    name: chip.dataset.name ?? "",
  };
}
