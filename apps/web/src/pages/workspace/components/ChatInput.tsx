import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import { Button } from "@qingagent/ui-kit";
import type { FolderSource, Resource, SkillRef, TableSelection } from "@qingagent/contract-ts";
import { useSkills } from "../../../overlays/settings/useSkills";
import { useResourceList } from "../../../system/resources/hooks";
import { invocableSkillActionsFromApi } from "../../../system/skillDisplay";
import { SkillMenu, SparkleIcon, SPARKLE_SVG, FILE_CHIP_SVG, SKILL_MENU_WIDTH, type SkillMenuAction } from "../../../system/SkillMenu";
import type { AssetSource } from "../data/sources";
import type { MaterialParseRow } from "../data/useMaterialParseTracker";
import {
  ACCEPTED_UPLOAD_ACCEPT_ATTR,
  isAcceptedUploadFile,
  FolderDisconnectDialog,
  FolderIntroDialog,
  useFolderSourceActions,
  type FolderCapability,
} from "../../../system";
import { truncateLabel } from "../textUtils";
import { NoKeyTip } from "../../../system/modelKeyGate";
import {
  buildLongTextChip,
  collectClipboardImageFiles,
  longTextChipFromClick,
  shouldCollapsePastedText,
  LongTextFullscreen,
} from "../../../system/longText";
import { FileActionMenu } from "./FileActionMenu";
import { LinkedFilesPanel } from "./LinkedFilesPanel";
import { uploadFailureMessage, uploadFileSizeError } from "../data/uploadAsset";

export interface ChatChipSpec {
  kind: "sel" | "attach" | "mention" | "longtext" | "annotation";
  /** Bracket prefix shown before the label (e.g. "§"). */
  prefix?: string;
  /** Display text inside the chip body. */
  label: string;
  /** Trailing context shown after the label. */
  suffix?: string;
  /** ProseMirror absolute position of the selection start (selection chips only). */
  from?: number;
  /** ProseMirror absolute position of the selection end (selection chips only). */
  to?: number;
  /**
   * 稳定块锚:被引用块的 blockId(选区/块引用 chip 用)。后端按它精确找回引用的块,
   * 不再依赖会随表格/列表/原子块漂移的 PM 位置估算。
   */
  blockId?: string;
  /** 多行列表选区覆盖的 item refs，按文档顺序排列。 */
  selectionRefs?: string[];
  /** 表格行/列选区，0-based inclusive。 */
  tableSelection?: TableSelection;
  /**
   * 技能占位 chip 携带的 skill id(mention chip 用)。选技能=往正文插一个带 skillId 的占位
   * token,提交时由 snapshot() 从这些 token 反推出本轮 skills(去重)发后端做检索预加载/记录。
   * 不再维护单独的"已选中技能"状态。
   */
  skillId?: string;
  /**
   * 长文本折叠卡片(kind="longtext")承载完整原文；批注标记(kind="annotation")承载完整修改指令。
   * 发送时由 snapshot() 原位展开回 text 进入模型上下文；卡片本身只是输入区/气泡的短展示。
   */
  text?: string;
}

export interface ChatInputSnapshot {
  text: string;
  chips: ChatChipSpec[];
  files: File[];
  richText: string;
  skills: SkillRef[];
}

export interface ChatInputHandle {
  /** Insert a chip at the current caret. */
  insertChip: (spec: ChatChipSpec) => boolean;
  /** 按 snapshot 中的 chip 顺序移除一个 chip。 */
  removeChipAt: (index: number) => void;
  /** Insert plain text at the current caret. */
  insertText: (text: string) => void;
  /** Clear the editor. */
  clear: () => void;
  /**
   * Snapshot current text + chip payloads + files without forcing
   * a re-render. Each chip's structured data (kind / prefix / label /
   * suffix) is serialized from the chip node's data-* attributes so
   * Stage C receives the same `ChatChip` contract the protocol defines.
   *
   * `richText` preserves the interleaved order of text and chips using
   * `{{chip:N}}` markers (N = 0-based chip index). This enables inline
   * rendering of chips alongside text in sent message bubbles.
   */
  snapshot: () => ChatInputSnapshot;
  /** Restore a previously captured draft after an optimistic send fails. */
  restore: (snapshot: ChatInputSnapshot) => void;
  /** Focus the editor. */
  focus: () => void;
}

export interface ChatInputProps {
  /**
   * Initial seed chips for the wireframe-aligned demo state. The
   * editor is uncontrolled afterward; the parent owns a ref to push
   * imperative actions like `insertChip`.
   */
  seedChips?: ChatChipSpec[];
  placeholder: string;
  disabled?: boolean;
  /** Agent 是否在跑(含刚发出、请求在途)——为真时给输入框挂环境辉光,表示"请求在途"。 */
  agentActive?: boolean;
  sendEnabledWhenDisabled?: boolean;
  onChange?: (text: string, chips: number) => void;
  onSubmit: () => void;
  showStop?: boolean;
  onStop?: () => void;
  onOpenSkillMenu?: () => void;
  /** 兼容旧预览链路；任务5B 起树行不再触发素材预览。 */
  onPreviewMaterial?: (source: AssetSource | null) => void;
  /** 连接文件夹内的文件预览；不对应 materialId。 */
  onPreviewFolderFile?: (source: AssetSource) => void;
  /** 删除已解析素材 → 父级二次确认并发 removeMaterial 命令。 */
  onRemoveMaterial?: (source: AssetSource) => void;
  /** 复用页面级全局 toast。 */
  onToast?: (message: string) => void;
  /** 收起素材区时通知父级(关掉右侧预览)。 */
  onPanelClose?: () => void;
  /** 当前会话已连接的文件夹资料库；P0 每会话至多一个。 */
  folderSource: FolderSource | null;
  folderCapability: FolderCapability;
  onAttachFolder: () => Promise<void>;
  onDetachFolder: (folderId: string) => Promise<void>;
  /** 已发送文件的解析态合并视图；任务5 会替换为 LinkedFilesPanel。 */
  materialParseRows?: readonly MaterialParseRow[];
  onRetryMaterialParse?: (fileId: string) => void;
  /** 未配置模型 key:发送按钮置灰 + hover 引导去配置。 */
  noModelKey?: boolean;
  onConfigureModel?: () => void;
}


/**
 * Workspace chat input. Wraps a contenteditable element with chip
 * insertion via Range/Selection. Conceptually the same pattern as
 * `pages/new-session/components/StarterEditor.tsx`; once Stage B
 * extracts a shared `ChipEditor` to ui-kit, this component will
 * become the consumer site rather than a parallel implementation.
 */
export const ChatInput = forwardRef<ChatInputHandle, ChatInputProps>(function ChatInput(
  {
    seedChips,
    placeholder,
    disabled = false,
    agentActive = false,
    sendEnabledWhenDisabled = false,
    onChange,
    onSubmit,
    showStop = false,
    onStop,
    onOpenSkillMenu,
    onPreviewMaterial,
    onPreviewFolderFile,
    onRemoveMaterial,
    onToast,
    folderSource,
    folderCapability,
    onAttachFolder,
    onDetachFolder,
    materialParseRows,
    onRetryMaterialParse,
    noModelKey = false,
    onConfigureModel,
  },
  ref,
) {
  const editRef = useRef<HTMLDivElement>(null);
  const savedRangeRef = useRef<Range | null>(null);
  const seededRef = useRef(false);
  const composingRef = useRef(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const fileButtonRef = useRef<HTMLButtonElement>(null);
  const fileWrapRef = useRef<HTMLDivElement>(null);
  const folderIntroPrimaryRef = useRef<HTMLButtonElement>(null);
  const folderDisconnectCancelRef = useRef<HTMLButtonElement>(null);
  const [attachedFiles, setAttachedFiles] = useState<File[]>([]);
  const [skillMenuOpen, setSkillMenuOpen] = useState(false);
  const [fileMenuOpen, setFileMenuOpen] = useState(false);
  // 技能菜单键盘高亮行(/ 唤起后 ↑/↓ 改它、Enter 选中)。
  const [skillIndex, setSkillIndex] = useState(0);
  // 「/」唤起时菜单浮在光标正上方的锚点(相对技能容器的 absolute 坐标);点按钮唤起则为 null(贴按钮上方)。
  const [skillAnchor, setSkillAnchor] = useState<{ left: number; bottom: number } | null>(null);
  // 技能菜单容器(按钮+浮层)ref:用于点外部/Esc 关闭。
  const skillWrapRef = useRef<HTMLDivElement>(null);
  // 文件菜单状态行点击后,让底部树展开并短暂定位高亮文件夹根节点。
  const [locateFolderSignal, setLocateFolderSignal] = useState(0);
  const fileResources = useResourceList({ kind: "file" });
  // 输入框是否为空(无文本且无 chip)——驱动"停止/发送"按钮切换。
  const [isEmpty, setIsEmpty] = useState(true);
  // 长文本小条点击 → 全屏查看的原文(null = 不显示)。
  const [longTextView, setLongTextView] = useState<string | null>(null);
  const { skills } = useSkills();
  const invocableSkillActions: SkillMenuAction[] = invocableSkillActionsFromApi(skills);
  const sendDisabled = disabled && !sendEnabledWhenDisabled;
  const {
    folderDialog,
    folderActionPending,
    requestAttach: requestAttachFolder,
    requestDetach: requestDetachFolder,
    introDialogProps,
    disconnectDialogProps,
  } = useFolderSourceActions({
    folderSource,
    folderCapability,
    onAttachFolder,
    onDetachFolder,
    disabled,
    restoreFocusRef: fileButtonRef,
  });

  // 未配置 key 时按发送快捷键:不放行,改成强弹引导气泡(短暂 is-forced),~2.6s 后自动收起。
  const [keyTipForced, setKeyTipForced] = useState(false);
  const keyTipTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flashKeyTip = useCallback(() => {
    if (keyTipTimerRef.current) clearTimeout(keyTipTimerRef.current);
    setKeyTipForced(false);
    // 双 rAF 让 is-forced 重新触发抖动动画(连续按多次也能再次抖)
    requestAnimationFrame(() => {
      requestAnimationFrame(() => setKeyTipForced(true));
    });
    keyTipTimerRef.current = setTimeout(() => setKeyTipForced(false), 2600);
  }, []);
  useEffect(() => () => {
    if (keyTipTimerRef.current) clearTimeout(keyTipTimerRef.current);
  }, []);

  const fallbackMaterialRows = fileResources.map(resourceToReadyRow);
  const effectiveMaterialRows = materialParseRows ?? fallbackMaterialRows;

  const reportChange = useCallback(() => {
    const edit = editRef.current;
    if (!edit) return;
    const text = (edit.innerText || "").trim();
    const chips = edit.querySelectorAll(".chat-chip").length;
    setIsEmpty(text.length === 0 && chips === 0);
    onChange?.(text, chips);
  }, [onChange]);

  const handleInput = useCallback((e: React.FormEvent<HTMLDivElement>) => {
    // 占位符空态按真实 DOM 内容刷新:中文 IME 组字阶段 input 已带组字文本(innerText 非空),
    // 此刻就要藏占位符,否则"字还没上屏、占位符还压着字"。组字期间仍不向上 onChange(不发半截)。
    const edit = editRef.current;
    if (edit) {
      const text = (edit.innerText || "").trim();
      setIsEmpty(text.length === 0 && edit.querySelectorAll(".chat-chip").length === 0);
    }
    if (composingRef.current || (e.nativeEvent as InputEvent).isComposing) return;
    reportChange();
  }, [reportChange]);

  const handleCompositionStart = useCallback(() => {
    composingRef.current = true;
    // 组字一开始就已有未上屏文本 → 立刻藏占位符(不等 input/compositionend),根治"占位符压在组字文字上"。
    setIsEmpty(false);
  }, []);

  const handleCompositionEnd = useCallback(() => {
    composingRef.current = false;
    reportChange();
  }, [reportChange]);

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
    if (sel.rangeCount > 0 && edit.contains(sel.anchorNode)) {
      return sel.getRangeAt(0);
    }
    if (savedRangeRef.current && edit.contains(savedRangeRef.current.startContainer)) {
      sel.removeAllRanges();
      sel.addRange(savedRangeRef.current);
      return savedRangeRef.current;
    }
    const r = document.createRange();
    r.selectNodeContents(edit);
    r.collapse(false);
    sel.removeAllRanges();
    sel.addRange(r);
    return r;
  }, []);

  // Seed initial chips (wireframe-aligned demo content) once on mount.
  useEffect(() => {
    if (seededRef.current) return;
    seededRef.current = true;
    const edit = editRef.current;
    if (!edit) return;
    if (seedChips && seedChips.length > 0) {
      for (const spec of seedChips) {
        const chip = makeChatChipNode(spec);
        edit.appendChild(chip);
        edit.appendChild(document.createTextNode(" "));
      }
      reportChange();
    }
  }, [seedChips, reportChange]);

  useImperativeHandle(
    ref,
    (): ChatInputHandle => ({
      focus() {
        editRef.current?.focus();
      },
      snapshot() {
        const edit = editRef.current;
        if (!edit) return { text: "", chips: [], files: [], richText: "", skills: [] };
        const chipNodes = edit.querySelectorAll<HTMLElement>(".chat-chip");
        const chips: ChatChipSpec[] = Array.from(chipNodes).map(readChipNode);
        // Extract only user-typed text, excluding chip visual content.
        // Clone the node, strip chip spans, then read innerText so the
        // backend receives a clean message without §/×/label noise.
        const clone = edit.cloneNode(true) as HTMLElement;
        for (const c of clone.querySelectorAll<HTMLElement>(".chat-chip")) {
          // 长文本/批注卡片:原位展开完整载荷,让 sendMessage.text 与后端/模型都拿到真实正文；
          // 其余引用型 chip 仍剔除，仅由 richText + chips 协议表达。
          if (
            (c.dataset.kind === "longtext" || c.dataset.kind === "annotation")
            && c.dataset.text != null
          ) {
            c.replaceWith(document.createTextNode(c.dataset.text));
          } else {
            c.remove();
          }
        }
        // Preserve newlines so sent messages retain line breaks
        const text = (clone.innerText || clone.textContent || "").trim();

        // Build richText: walk childNodes in document order, emitting
        // text as-is and chip placeholders like {{chip:0}}.
        // This preserves the interleaved order for inline rendering.
        let chipIndex = 0;
        const richParts: string[] = [];
        function walk(node: Node) {
          if (
            node.nodeType === Node.ELEMENT_NODE &&
            (node as HTMLElement).classList?.contains("chat-chip")
          ) {
            richParts.push(`{{chip:${chipIndex++}}}`);
            return;
          }
          if (node.nodeType === Node.TEXT_NODE) {
            richParts.push(node.textContent ?? "");
            return;
          }
          if (
            node.nodeType === Node.ELEMENT_NODE &&
            (node as HTMLElement).tagName === "BR"
          ) {
            richParts.push("\n");
            return;
          }
          // Recurse into child nodes (e.g. divs created by Enter key)
          for (const child of node.childNodes) {
            walk(child);
          }
        }
        for (const child of edit.childNodes) {
          walk(child);
        }
        const richText = richParts.join("").trim();

        // 本轮 skills 直接从正文里的技能占位 chip 反推(按 skillId 去重),发后端做检索预加载/记录。
        const seenSkill = new Set<string>();
        const skills: SkillRef[] = [];
        for (const c of chips) {
          if (c.skillId && !seenSkill.has(c.skillId)) {
            seenSkill.add(c.skillId);
            skills.push({ id: c.skillId, version: null });
          }
        }

        return {
          text,
          chips,
          files: [...attachedFiles],
          richText,
          skills,
        };
      },
      clear() {
        const edit = editRef.current;
        if (!edit) return;
        while (edit.firstChild) edit.removeChild(edit.firstChild);
        setAttachedFiles([]);
        setSkillMenuOpen(false);
        setFileMenuOpen(false);
        reportChange();
      },
      removeChipAt(index) {
        const edit = editRef.current;
        if (!edit || !Number.isInteger(index) || index < 0) return;
        const chip = edit.querySelectorAll<HTMLElement>(".chat-chip")[index];
        if (!chip) return;
        const next = chip.nextSibling;
        if (
          next?.nodeType === Node.TEXT_NODE &&
          (next.textContent === " " || next.textContent === " ")
        ) {
          next.remove();
        }
        const prev = chip.previousSibling;
        if (prev?.nodeName === "BR") prev.remove();
        chip.remove();
        reportChange();
      },
      restore(snapshot) {
        const edit = editRef.current;
        if (!edit) return;
        restoreSnapshotContent(edit, snapshot);
        setAttachedFiles([...snapshot.files]);
        setSkillMenuOpen(false);
        setFileMenuOpen(false);
        focusEditorEnd(edit);
        reportChange();
      },
      insertText(text) {
        const edit = editRef.current;
        if (!edit || disabled) return;
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
        if (!edit || disabled) return false;
        // 选区批注 chip 同一时刻只应有一个:连续 ✨AI修改 换选区却未发送时,先清掉上一个未发送的
        // 旧 sel chip(及其相邻的尾随空格/前导换行),避免多个 sel chip 叠加导致候选误改多处/错字
        // (e2e ai-modify-chip-residue,高频)。attach/mention chip 可多个,不受影响。
        if (spec.kind === "sel") {
          edit.querySelectorAll('.chat-chip[data-kind="sel"]').forEach((old) => {
            const next = old.nextSibling;
            if (
              next &&
              next.nodeType === Node.TEXT_NODE &&
              (next.textContent === " " || next.textContent === " ")
            ) {
              next.remove();
            }
            const prev = old.previousSibling;
            if (prev && prev.nodeName === "BR") prev.remove();
            old.remove();
          });
        }
        const chip = makeChatChipNode(spec);

        const hasContent = !!(edit.textContent && edit.textContent.trim().length > 0);

        if (hasContent) {
          // Append a line break then the chip at the END of the editor
          edit.appendChild(document.createElement("br"));
          edit.appendChild(chip);
        } else {
          // Empty editor: just append the chip
          edit.appendChild(chip);
        }

        // Add a trailing space after the chip
        const space = document.createTextNode("\u00a0");
        chip.after(space);

        reportChange();

        // Defer focus + caret placement with a double-defer: rAF then
        // setTimeout(0). A single rAF is not enough because the caller
        // chain (DocToolbar.handleAiModify) runs editor.commands.blur(),
        // setPos(null), setOpenDd(null), and showToast *synchronously
        // after* insertChip returns. React 18 batches those setState
        // calls and may flush the commit in the same frame as the rAF
        // callback, wiping the DOM selection we just set. The extra
        // setTimeout(0) pushes our focus call to a new macrotask that
        // runs after React's commit phase and the TipTap blur have
        // fully settled.
        requestAnimationFrame(() => {
          setTimeout(() => {
            edit.focus();
            try {
              const r2 = document.createRange();
              r2.setStartAfter(space);
              r2.collapse(true);
              const sel2 = window.getSelection();
              if (sel2) {
                sel2.removeAllRanges();
                sel2.addRange(r2);
                savedRangeRef.current = r2.cloneRange();
              }
            } catch {
              // Non-critical: caret positioning may fail but chip is inserted.
            }
          }, 0);
        });
        return true;
      },
    }),
    [restoreOrEndRange, reportChange, attachedFiles, disabled],
  );

  // 选技能 = 往正文末尾插一个技能占位 token(带 skillId)。可重复插 N 个;不维护"选中态"。
  // 菜单保持打开,方便连插多个;点外部/Esc 才关闭。
  const addSkill = useCallback((action: SkillMenuAction) => {
    const edit = editRef.current;
    if (!edit || disabled) return;
    const chip = makeChatChipNode({
      kind: "mention",
      label: action.label,
      prefix: "",
      skillId: action.id,
    });
    const spacer = document.createTextNode(" ");
    edit.appendChild(chip);
    edit.appendChild(spacer);
    edit.focus();
    const range = document.createRange();
    range.setStartAfter(spacer);
    range.collapse(true);
    const selection = window.getSelection();
    if (selection) {
      selection.removeAllRanges();
      selection.addRange(range);
    }
    savedRangeRef.current = range.cloneRange();
    setSkillMenuOpen(false);
    reportChange();
  }, [disabled, reportChange]);

  // 技能菜单:点面板外部或按 Esc 自动收起(修"失焦不消失")。
  useEffect(() => {
    if (!skillMenuOpen) return;
    const onPointerDown = (e: MouseEvent) => {
      if (!skillWrapRef.current?.contains(e.target as Node)) {
        setSkillMenuOpen(false);
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setSkillMenuOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [skillMenuOpen]);

  // 文件菜单同技能菜单:点外部或按 Esc 自动收起。
  useEffect(() => {
    if (!fileMenuOpen) return;
    const onPointerDown = (e: MouseEvent) => {
      if (!fileWrapRef.current?.contains(e.target as Node)) {
        setFileMenuOpen(false);
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setFileMenuOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [fileMenuOpen]);

  const handleKey = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (disabled) {
        e.preventDefault();
        return;
      }
      // 技能菜单开着:↑/↓ 选行、Enter 选中、Esc/Backspace 关、其它字符键关并放行(Codex 式)。
      if (skillMenuOpen) {
        const n = invocableSkillActions.length;
        if (e.key === "ArrowDown") {
          e.preventDefault();
          if (n) setSkillIndex((i) => (i + 1) % n);
          return;
        }
        if (e.key === "ArrowUp") {
          e.preventDefault();
          if (n) setSkillIndex((i) => (i - 1 + n) % n);
          return;
        }
        if (e.key === "Enter") {
          e.preventDefault();
          const action = invocableSkillActions[skillIndex];
          if (action) addSkill(action);
          return;
        }
        if (e.key === "Escape" || e.key === "Backspace") {
          e.preventDefault();
          setSkillMenuOpen(false);
          return;
        }
        if (e.key.length === 1) setSkillMenuOpen(false);
      }
      // 「/」唤起技能菜单(仅词首/空白后触发,避免误吃日期、路径里的斜杠);菜单浮在光标正上方。
      if (e.key === "/" && !skillMenuOpen) {
        const sel = window.getSelection();
        let atStart = true;
        let caretLeft: number | null = null;
        let caretTop: number | null = null;
        if (sel && sel.rangeCount > 0) {
          const r = sel.getRangeAt(0);
          if (r.collapsed && r.startContainer.nodeType === Node.TEXT_NODE) {
            const before = (r.startContainer.textContent ?? "").charAt(r.startOffset - 1);
            atStart = r.startOffset === 0 || /\s/.test(before);
          }
          const rect = r.getBoundingClientRect();
          if (rect.height || rect.top || rect.left) {
            caretLeft = rect.left;
            caretTop = rect.top;
          }
        }
        if (!atStart) return; // 词中的「/」按普通字符输入,不唤起
        e.preventDefault();
        // 光标视口坐标 → 相对技能容器的 absolute 锚点(不用 fixed:祖先 backdrop-filter/transform 会带偏)。
        let anchor: { left: number; bottom: number } | null = null;
        const wrapRect = skillWrapRef.current?.getBoundingClientRect();
        if (wrapRect && caretTop != null && caretLeft != null) {
          const vpLeft = Math.max(8, Math.min(caretLeft, window.innerWidth - SKILL_MENU_WIDTH - 12));
          anchor = { left: vpLeft - wrapRect.left, bottom: wrapRect.bottom - caretTop + 6 };
        }
        setSkillIndex(0);
        setSkillAnchor(anchor);
        setFileMenuOpen(false);
        setSkillMenuOpen(true);
        onOpenSkillMenu?.();
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault();
        // 未配置模型 key:快捷键与置灰的发送按钮一样不放行,改成强弹引导气泡。
        if (noModelKey) {
          flashKeyTip();
          return;
        }
        onSubmit();
        return;
      }
      if (e.key === "Backspace") {
        const sel = window.getSelection();
        if (!sel || sel.rangeCount === 0) return;
        const range = sel.getRangeAt(0);
        if (!range.collapsed) return;
        const n = range.startContainer;
        const offset = range.startOffset;

        // Helper: check if a node is a chip element
        const isChip = (node: Node | null): node is HTMLElement =>
          node !== null &&
          node.nodeType === Node.ELEMENT_NODE &&
          (node as HTMLElement).classList?.contains("chat-chip") === true;

        // Helper: check if a text node is a trailing spacer (NBSP or ZWS)
        const isSpacer = (node: Node | null): boolean =>
          node !== null &&
          node.nodeType === Node.TEXT_NODE &&
          /^[ ​\s]*$/.test(node.textContent ?? "");

        // Case 1: cursor at offset 0 of a text node whose previousSibling is a chip
        if (offset === 0 && n.nodeType === Node.TEXT_NODE && isChip(n.previousSibling)) {
          e.preventDefault();
          n.previousSibling.remove();
          // Clean up if current node is an orphaned spacer
          if (isSpacer(n)) n.parentNode?.removeChild(n);
          reportChange();
          return;
        }

        // Case 2: cursor at offset 0-1 in a spacer text node following a chip
        // (NBSP or ZWS inserted after chip)
        if (
          offset <= 1 &&
          n.nodeType === Node.TEXT_NODE &&
          isSpacer(n) &&
          isChip(n.previousSibling)
        ) {
          e.preventDefault();
          const chip = n.previousSibling;
          n.parentNode?.removeChild(n);
          chip.remove();
          reportChange();
          return;
        }

        // Case 3: cursor is inside an element node (e.g. the editor div itself)
        // and the child before the cursor offset is a chip
        if (n.nodeType === Node.ELEMENT_NODE && offset > 0) {
          const childBefore = n.childNodes[offset - 1];
          if (isChip(childBefore ?? null)) {
            e.preventDefault();
            // Also remove a trailing spacer after the chip if present
            const nextSib = childBefore!.nextSibling;
            if (isSpacer(nextSib)) nextSib!.parentNode?.removeChild(nextSib!);
            childBefore!.remove();
            reportChange();
            return;
          }
          // Check if child before cursor is a spacer preceded by a chip
          if (
            childBefore &&
            isSpacer(childBefore) &&
            isChip(childBefore.previousSibling)
          ) {
            e.preventDefault();
            const chip = childBefore.previousSibling;
            childBefore.parentNode?.removeChild(childBefore);
            chip!.remove();
            reportChange();
            return;
          }
        }
      }
    },
    [disabled, onSubmit, reportChange, skillMenuOpen, invocableSkillActions, skillIndex, addSkill, onOpenSkillMenu],
  );

  const removeAttachment = useCallback(
    (filename: string) => {
      setAttachedFiles((prev) => prev.filter((f) => attachmentFileKey(f) !== filename));
      const edit = editRef.current;
      if (!edit) return;
      removeAttachChips(edit, filename);
      reportChange();
    },
    [reportChange],
  );

  const handleClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (disabled) {
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      const target = e.target as HTMLElement;
      if (target.classList.contains("annotation-chip-confirm")) {
        const chip = target.closest<HTMLElement>('.chat-chip[data-kind="annotation"]');
        const textarea = chip?.querySelector<HTMLTextAreaElement>(".annotation-chip-editor");
        if (chip && textarea) {
          e.preventDefault();
          e.stopPropagation();
          const instruction = textarea.value.trim();
          if (!instruction) {
            textarea.setAttribute("aria-invalid", "true");
            textarea.focus();
            return;
          }
          chip.dataset.text = instruction;
          textarea.removeAttribute("aria-invalid");
          target.setAttribute("data-saved", "true");
          reportChange();
        }
        return;
      }
      if (target.classList.contains("c-x")) {
        const chip = target.closest(".chat-chip") as HTMLElement | null;
        if (chip) {
          e.preventDefault();
          e.stopPropagation();
          if (chip.dataset.kind === "attach" && chip.dataset.label) {
            removeAttachment(chip.dataset.label);
            return;
          }
          chip.remove();
          reportChange();
        }
        return;
      }
      // 点击长文本小条本体(非 ×)→ 全屏查看原文。
      const longChip = longTextChipFromClick(target);
      if (longChip?.dataset.text != null) {
        e.preventDefault();
        setLongTextView(longChip.dataset.text);
      }
    },
    [disabled, removeAttachment, reportChange],
  );

  // 粘贴图片 → 走上传文件链路:重命名唯一名、落入 attachedFiles、插一个引用 chip,
  // 复用提交时的 uploadFiles/fileIds(与「上传文件」按钮完全一致),不内联进正文。
  const acceptPastedImages = useCallback(
    (files: File[]) => {
      const edit = editRef.current;
      if (!edit || disabled) return;
      const accepted = files.filter((f) => isAcceptedUploadFile(f));
      if (accepted.length === 0) return;
      setAttachedFiles((prev) => {
        const next = [...prev];
        for (const f of accepted) {
          const key = attachmentFileKey(f);
          if (!next.some((x) => attachmentFileKey(x) === key)) next.push(f);
        }
        return next;
      });
      for (const f of accepted) {
        const key = attachmentFileKey(f);
        if (hasAttachChip(edit, key)) continue;
        const chip = makeChatChipNode({ kind: "attach", label: key });
        const hasContent = !!(edit.textContent && edit.textContent.trim().length > 0);
        if (hasContent) edit.appendChild(document.createElement("br"));
        edit.appendChild(chip);
        edit.appendChild(document.createTextNode(" "));
      }
      focusEditorEnd(edit);
      reportChange();
    },
    [disabled, reportChange],
  );

  // 粘贴超长文本 → 折叠成卡片 chip 插在光标处(原文存 data-text,发送时 snapshot 原位展开)。
  const insertLongTextChip = useCallback(
    (text: string) => {
      const edit = editRef.current;
      if (!edit || disabled) return;
      edit.focus();
      const r = restoreOrEndRange();
      r.deleteContents();
      const chip = buildLongTextChip(text);
      r.insertNode(chip);
      const space = document.createTextNode(" ");
      chip.after(space);
      const r2 = document.createRange();
      r2.setStartAfter(space);
      r2.collapse(true);
      const sel = window.getSelection();
      if (sel) {
        sel.removeAllRanges();
        sel.addRange(r2);
        savedRangeRef.current = r2.cloneRange();
      }
      reportChange();
    },
    [disabled, restoreOrEndRange, reportChange],
  );

  // 粘贴处理:① 图片走上传链路;② 超长文本折叠成卡片;③ 其余只取 text/plain 插光标处。
  // 始终 preventDefault,避免浏览器把富 HTML 直接注进可编辑区、破坏 chat-chip 约束并绕过 onChange。
  const handlePaste = useCallback(
    (e: React.ClipboardEvent<HTMLDivElement>) => {
      e.preventDefault();
      if (disabled) return;
      const data = e.clipboardData;
      const text = data.getData("text/plain") || "";
      // 图片:仅在没有实质文本时才当图片粘贴(避免劫持网页富文本里夹带的图)。
      if (!text.trim()) {
        const images = collectClipboardImageFiles(data);
        if (images.length > 0) {
          acceptPastedImages(images);
          return;
        }
      }
      if (!text) return;
      if (shouldCollapsePastedText(text)) {
        insertLongTextChip(text);
        return;
      }
      document.execCommand("insertText", false, text);
    },
    [disabled, acceptPastedImages, insertLongTextChip],
  );

  const handleFileSelect = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (disabled) {
        e.target.value = "";
        return;
      }
      if (!file) return;
      // Reset input so the same file can be re-selected
      e.target.value = "";

      const sizeError = uploadFileSizeError(file);
      if (sizeError) {
        onToast?.(uploadFailureMessage(sizeError, "文件上传失败，请重试"));
        return;
      }

      if (!isAcceptedUploadFile(file)) {
        window.alert(
          `暂不支持这种文件，可以试试 PDF、Word、Excel、PPT、TXT、Markdown 或图片。`,
        );
        return;
      }

      const key = attachmentFileKey(file);

      // Store native File object — upload deferred to submit time。未发送文件只作为输入框 chip 存在,
      // 发送后解析 tracker/resource 才会让它进入「已关联文件」面板。
      setAttachedFiles((prev) => (prev.some((f) => attachmentFileKey(f) === key) ? prev : [...prev, file]));

      // Insert an attach chip showing the filename(面板上传与按钮上传一致,都自动引用)
      const edit = editRef.current;
      if (!edit) return;
      if (hasAttachChip(edit, key)) {
        edit.focus();
        reportChange();
        return;
      }
      edit.focus();
      const r = restoreOrEndRange();
      r.deleteContents();
      const chip = makeChatChipNode({ kind: "attach", label: key });
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
    [attachedFiles, disabled, onToast, restoreOrEndRange, reportChange],
  );

  // 引用:把素材作为下一条消息上下文,在编辑器末尾插入 attach chip(文件名)。
  const insertAttachChip = useCallback(
    (label: string) => {
      const edit = editRef.current;
      if (!edit || disabled) return;
      // 同名 attach chip 已存在则不重复插(避免「引用」多次留下重复 chip)。
      if (hasAttachChip(edit, label)) {
        edit.focus();
        reportChange();
        return;
      }
      const chip = makeChatChipNode({ kind: "attach", label });
      const hasContent = !!(edit.textContent && edit.textContent.trim().length > 0);
      if (hasContent) edit.appendChild(document.createElement("br"));
      edit.appendChild(chip);
      const space = document.createTextNode(" ");
      chip.after(space);
      edit.focus();
      const r = document.createRange();
      r.setStartAfter(space);
      r.collapse(true);
      const sel = window.getSelection();
      if (sel) {
        sel.removeAllRanges();
        sel.addRange(r);
        savedRangeRef.current = r.cloneRange();
      }
      reportChange();
    },
    [disabled, reportChange],
  );

  const handleFileButton = useCallback(() => {
    setSkillMenuOpen(false);
    setFileMenuOpen((open) => !open);
  }, []);

  const handleChooseFileFromMenu = useCallback(() => {
    setFileMenuOpen(false);
    fileInputRef.current?.click();
  }, []);

  const handleAttachFolderFromMenu = useCallback(() => {
    setFileMenuOpen(false);
    requestAttachFolder();
  }, [requestAttachFolder]);

  const handleOpenFolderPanelFromMenu = useCallback(() => {
    setFileMenuOpen(false);
    setLocateFolderSignal((value) => value + 1);
  }, []);

  const handleDetachFolderFromMenu = useCallback(() => {
    setFileMenuOpen(false);
    requestDetachFolder();
  }, [requestDetachFolder]);

  useEffect(() => {
    const onSel = () => captureRange();
    document.addEventListener("selectionchange", onSel);
    return () => document.removeEventListener("selectionchange", onSel);
  }, [captureRange]);

  return (
    <div
      className={`wf-input${disabled ? " is-disabled" : ""}${agentActive ? " is-agent-active" : ""}`}
      data-wf="ChatInputWrap"
    >
      {longTextView !== null && (
        <LongTextFullscreen text={longTextView} onClose={() => setLongTextView(null)} />
      )}
      {folderDialog === "intro" && (
        <FolderIntroDialog
          anchor={fileButtonRef.current}
          dataWf="WsFolderIntroOverlay"
          titleId="ws-folder-intro-title"
          initialFocusRef={folderIntroPrimaryRef}
          {...introDialogProps}
        />
      )}
      {folderDialog === "disconnectConfirm" && disconnectDialogProps && (
        <FolderDisconnectDialog
          anchor={fileButtonRef.current}
          dataWf="WsFolderDisconnectOverlay"
          titleId="ws-folder-disconnect-title"
          initialFocusRef={folderDisconnectCancelRef}
          {...disconnectDialogProps}
        />
      )}
      <input
        ref={fileInputRef}
        type="file"
        accept={ACCEPTED_UPLOAD_ACCEPT_ATTR}
        disabled={disabled}
        style={{ display: "none" }}
        onChange={handleFileSelect}
      />
      <div
        ref={editRef}
        className={`chat-edit${disabled ? " is-disabled" : ""}${isEmpty ? " is-empty" : ""}`}
        data-wf="ChatInput"
        data-placeholder={placeholder}
        contentEditable={!disabled}
        suppressContentEditableWarning
        role="textbox"
        aria-multiline="true"
        aria-disabled={disabled}
        tabIndex={disabled ? -1 : 0}
        onInput={handleInput}
        onCompositionStart={handleCompositionStart}
        onCompositionEnd={handleCompositionEnd}
        onKeyDown={handleKey}
        onPaste={handlePaste}
        onClick={handleClick}
        onBlur={captureRange}
      />
      <div className="ws-input-tools">
        <div style={{ display: "flex", gap: 4, position: "relative" }}>
          <div ref={skillWrapRef} style={{ position: "relative", display: "inline-flex" }}>
          <button
            type="button"
            className="wf-btn small ghost ws-pill"
            onClick={() => {
              onOpenSkillMenu?.();
              setFileMenuOpen(false);
              setSkillMenuOpen((open) => {
                if (!open) {
                  setSkillIndex(0);
                  setSkillAnchor(null);
                }
                return !open;
              });
            }}
            disabled={disabled}
            data-wf="WsSkillBtn"
          >
            <SparkleIcon className="ws-tool-ico" />{" "}
            技能
          </button>
          {skillMenuOpen && (
            <SkillMenu
              actions={invocableSkillActions}
              onPick={addSkill}
              disabled={disabled}
              selectedIndex={skillIndex}
              onHoverIndex={setSkillIndex}
              anchor={skillAnchor}
              dataWf="SkillMenu"
            />
          )}
          </div>
          <div ref={fileWrapRef} style={{ position: "relative", display: "inline-flex" }}>
            <button
              ref={fileButtonRef}
              type="button"
              className={`wf-btn small ghost ws-pill${fileMenuOpen ? " is-active" : ""}`}
              onClick={handleFileButton}
              disabled={disabled}
              aria-expanded={fileMenuOpen}
              aria-haspopup="menu"
              data-wf="WsFileBtn"
            >
              <svg
                className="ws-tool-ico"
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M13.5 3.5H6.5A1.5 1.5 0 0 0 5 5v14a1.5 1.5 0 0 0 1.5 1.5h11A1.5 1.5 0 0 0 19 19V9z" />
                <path d="M13.5 3.5V9H19" />
              </svg>{" "}
              文件
            </button>
            {fileMenuOpen && (
              <FileActionMenu
                folderSource={folderSource}
                folderCapability={folderCapability}
                folderActionPending={folderActionPending}
                onChooseFile={handleChooseFileFromMenu}
                onAttachFolder={handleAttachFolderFromMenu}
                onOpenFolderPanel={handleOpenFolderPanelFromMenu}
                onDetachFolder={handleDetachFolderFromMenu}
              />
            )}
          </div>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          {showStop && isEmpty ? (
            // 正在输出中 且 输入框为空 → 停止;其余情况(含输出中但已输入新内容,
            // 即中断改写)→ 发送。
            <Button
              variant="ghost"
              size="small"
              onClick={onStop}
              disabled={!onStop}
              data-wf="WsStopBtn"
              title="停止输出"
            >
              停止
            </Button>
          ) : (
            // 快捷键提示改成 hover 文案(去掉常驻的 ⌘⏎ 按钮);未配置 key 时置灰 + 引导气泡
            <NoKeyTip active={noModelKey} forced={keyTipForced} onConfigure={() => onConfigureModel?.()}>
              <Button
                variant="primary"
                size="small"
                onClick={() => {
                  if (!noModelKey) onSubmit();
                }}
                disabled={sendDisabled || noModelKey}
                title={noModelKey ? "还没配置模型 key" : "发送 · ⌘ / Ctrl + Enter"}
              >
                发送 →
              </Button>
            </NoKeyTip>
          )}
        </div>
      </div>
      <LinkedFilesPanel
        materialRows={effectiveMaterialRows}
        folderSource={folderSource}
        disabled={disabled}
        locateFolderSignal={locateFolderSignal}
        onReference={insertAttachChip}
        onPreviewMaterial={onPreviewMaterial}
        onPreviewFolderFile={onPreviewFolderFile}
        onRemoveMaterial={onRemoveMaterial}
        onRetryMaterialParse={onRetryMaterialParse}
        onAttachFolder={requestAttachFolder}
        onDetachFolder={requestDetachFolder}
        onToast={onToast}
      />
    </div>
  );
});

function resourceToReadyRow(resource: Resource): MaterialParseRow {
  const metadata = resource.metadata !== null && typeof resource.metadata === "object" && !Array.isArray(resource.metadata)
    ? resource.metadata as { fileId?: unknown; parseState?: unknown; parseError?: unknown }
    : {};
  const state = metadata.parseState === "error" ? "error" : "ready";
  return {
    id: resource.resourceRef.id,
    fileId: typeof metadata.fileId === "string" && metadata.fileId.length > 0 ? metadata.fileId : null,
    filename: resource.displayName,
    mime: resource.mime ?? null,
    state,
    parseError: state === "error" && typeof metadata.parseError === "string" ? metadata.parseError : null,
    resource,
    source: "resource",
  };
}

const CHIP_KIND_ICONS: Record<ChatChipSpec["kind"], string> = {
  sel: "❝",
  attach: "📎",
  mention: "@",
  longtext: "❝",
  annotation: "※",
};

function makeChatChipNode(spec: ChatChipSpec): HTMLSpanElement {
  // 长文本小条:统一走共享 builder(单行小条 + hover 预览 + data-text),与新建页/气泡一致。
  if (spec.kind === "longtext") return buildLongTextChip(spec.text ?? "");

  const chip = document.createElement("span");
  chip.className = "chat-chip";
  chip.setAttribute("contenteditable", "false");
  // Persist the structured spec on the node so `snapshot()` can rebuild
  // the protocol's ChatChip without parsing visual DOM. Empty strings
  // are preserved as-is via dataset; absent fields get no attribute.
  chip.dataset.kind = spec.kind;
  chip.dataset.label = spec.label;
  if (spec.prefix !== undefined) chip.dataset.prefix = spec.prefix;
  if (spec.suffix !== undefined) chip.dataset.suffix = spec.suffix;
  if (spec.from !== undefined) chip.dataset.from = String(spec.from);
  if (spec.to !== undefined) chip.dataset.to = String(spec.to);
  if (spec.blockId !== undefined) chip.dataset.blockId = spec.blockId;
  if (spec.skillId !== undefined) chip.dataset.skillId = spec.skillId;
  if (spec.text !== undefined) chip.dataset.text = spec.text;
  if (spec.selectionRefs && spec.selectionRefs.length > 0) {
    chip.dataset.selectionRefs = JSON.stringify(spec.selectionRefs);
  }
  if (spec.tableSelection !== undefined) {
    chip.dataset.tableSelection = JSON.stringify(spec.tableSelection);
  }

  // Display text: for selection chips, truncate for compact display
  const displayLabel = spec.kind === "sel" ? truncateLabel(spec.label) : spec.label;

  // 统一样式:左侧 kind 图标 + 主标签 +(可选)后缀小标签 + 移除。去掉原来括号 + 等宽字体那套
  // 低对比小字渲染(图片/附件 chip 在暖纸面上几乎看不清)。
  const ico = document.createElement("span");
  ico.className = "c-ico";
  // 技能(mention)用魔法双星、文件(attach)用线性文件图标,其余沿用文字符号(去掉 📎 emoji)。
  if (spec.kind === "mention") {
    ico.innerHTML = SPARKLE_SVG;
  } else if (spec.kind === "attach") {
    ico.innerHTML = FILE_CHIP_SVG;
  } else {
    ico.textContent = CHIP_KIND_ICONS[spec.kind] ?? "❝";
  }
  chip.appendChild(ico);

  if (spec.prefix) {
    const pre = document.createElement("span");
    pre.className = "c-tag";
    pre.textContent = spec.prefix;
    chip.appendChild(pre);
  }

  const labelEl = document.createElement("span");
  labelEl.className = "c-label";
  labelEl.textContent = displayLabel;
  chip.appendChild(labelEl);

  if (spec.suffix) {
    const sx = document.createElement("span");
    sx.className = "c-tag";
    sx.textContent = spec.suffix;
    chip.appendChild(sx);
  }

  if (spec.kind === "annotation") {
    chip.classList.add("chat-chip-annotation");
    const pop = document.createElement("span");
    pop.className = "annotation-chip-pop";
    pop.setAttribute("contenteditable", "false");
    pop.setAttribute("role", "group");
    pop.setAttribute("aria-label", "编辑批注指令");

    const title = document.createElement("span");
    title.className = "annotation-chip-pop-title";
    title.textContent = "完整修改指令";
    pop.appendChild(title);

    const editor = document.createElement("textarea");
    editor.className = "annotation-chip-editor";
    editor.rows = 5;
    editor.value = spec.text ?? "";
    editor.setAttribute("aria-label", "完整修改指令");
    pop.appendChild(editor);

    const confirm = document.createElement("button");
    confirm.type = "button";
    confirm.className = "annotation-chip-confirm";
    confirm.textContent = "确认";
    pop.appendChild(confirm);
    chip.appendChild(pop);
  }

  const x = document.createElement("span");
  x.className = "c-x";
  x.title = "移除";
  x.textContent = "×";
  chip.appendChild(x);
  return chip;
}

function attachmentFileKey(file: File): string {
  return file.name;
}

function hasAttachChip(edit: HTMLElement, label: string): boolean {
  return Array.from(edit.querySelectorAll<HTMLElement>(".chat-chip")).some(
    (chip) => chip.dataset.kind === "attach" && chip.dataset.label === label,
  );
}

function removeAttachChips(edit: HTMLElement, label: string): void {
  const chips = edit.querySelectorAll<HTMLElement>(".chat-chip");
  for (const chip of chips) {
    if (chip.dataset.kind === "attach" && chip.dataset.label === label) {
      chip.remove();
    }
  }
}

function restoreSnapshotContent(edit: HTMLElement, snapshot: ChatInputSnapshot): void {
  while (edit.firstChild) edit.removeChild(edit.firstChild);

  const source = snapshot.richText || snapshot.text;
  const marker = /\{\{chip:(\d+)\}\}/g;
  let lastIndex = 0;
  let matched = false;
  let match: RegExpExecArray | null;

  while ((match = marker.exec(source)) !== null) {
    matched = true;
    appendTextPreservingLines(edit, source.slice(lastIndex, match.index));
    const chip = snapshot.chips[Number(match[1])];
    if (chip) {
      edit.appendChild(makeChatChipNode(chip));
      const nextChar = source[marker.lastIndex] ?? "";
      if (nextChar === "" || !/\s/.test(nextChar)) {
        edit.appendChild(document.createTextNode("\u00a0"));
      }
    }
    lastIndex = marker.lastIndex;
  }

  appendTextPreservingLines(edit, source.slice(lastIndex));
  if (!matched && source === snapshot.text) {
    for (const chip of snapshot.chips) {
      if (edit.childNodes.length > 0) edit.appendChild(document.createElement("br"));
      edit.appendChild(makeChatChipNode(chip));
      edit.appendChild(document.createTextNode("\u00a0"));
    }
  }
}

function appendTextPreservingLines(parent: HTMLElement, text: string): void {
  if (!text) return;
  const parts = text.split("\n");
  parts.forEach((part, index) => {
    if (index > 0) parent.appendChild(document.createElement("br"));
    if (part) parent.appendChild(document.createTextNode(part));
  });
}

function focusEditorEnd(edit: HTMLElement): void {
  edit.focus();
  const range = document.createRange();
  range.selectNodeContents(edit);
  range.collapse(false);
  const selection = window.getSelection();
  if (!selection) return;
  selection.removeAllRanges();
  selection.addRange(range);
}

function parseSelectionRefs(raw: string | undefined): string[] | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return undefined;
    const refs = parsed.filter((item): item is string => typeof item === "string" && item.length > 0);
    return refs.length > 0 ? refs : undefined;
  } catch {
    return undefined;
  }
}

function parseTableSelection(raw: string | undefined): TableSelection | undefined {
  if (!raw) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    const value = parsed as Record<string, unknown>;
    if (value.axis !== "row" && value.axis !== "column") return undefined;
    if (!Number.isInteger(value.startIndex) || (value.startIndex as number) < 0) return undefined;
    if (!Number.isInteger(value.endIndex) || (value.endIndex as number) < 0) return undefined;
    if ((value.startIndex as number) > (value.endIndex as number)) return undefined;
    if (value.signature !== undefined && typeof value.signature !== "string") return undefined;
    return {
      axis: value.axis,
      startIndex: value.startIndex as number,
      endIndex: value.endIndex as number,
      ...(typeof value.signature === "string" ? { signature: value.signature } : {}),
    };
  } catch {
    return undefined;
  }
}

/** Rebuild a ChatChipSpec from a chip DOM node's data-* attributes. */
function readChipNode(el: HTMLElement): ChatChipSpec {
  const kind = (el.dataset.kind as ChatChipSpec["kind"]) ?? "sel";
  const spec: ChatChipSpec = {
    kind,
    label: el.dataset.label ?? "",
  };
  if (el.dataset.prefix !== undefined) spec.prefix = el.dataset.prefix;
  if (el.dataset.suffix !== undefined) spec.suffix = el.dataset.suffix;
  if (el.dataset.from !== undefined) spec.from = parseInt(el.dataset.from, 10);
  if (el.dataset.to !== undefined) spec.to = parseInt(el.dataset.to, 10);
  if (el.dataset.blockId !== undefined) spec.blockId = el.dataset.blockId;
  if (el.dataset.skillId !== undefined) spec.skillId = el.dataset.skillId;
  if (el.dataset.text !== undefined) spec.text = el.dataset.text;
  const selectionRefs = parseSelectionRefs(el.dataset.selectionRefs);
  if (selectionRefs) spec.selectionRefs = selectionRefs;
  const tableSelection = parseTableSelection(el.dataset.tableSelection);
  if (tableSelection) spec.tableSelection = tableSelection;
  return spec;
}
