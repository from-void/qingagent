import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import { Button } from "@qingagent/ui-kit";
import {
  parseChipRichText,
  serializeChipRichText,
  type ChipRichTextPart,
  type FolderSource,
  type Resource,
  type SkillRef,
  type TableSelection,
} from "@qingagent/contract-ts";
import { ArrowRightIcon } from "../../../system/icons";
import { useSkills } from "../../../overlays/settings/useSkills";
import { useResourceList } from "../../../system/resources/hooks";
import { invocableSkillActionsFromApi } from "../../../system/skillDisplay";
import { SkillMenu, SparkleIcon, SPARKLE_SVG, FILE_CHIP_SVG, SKILL_MENU_WIDTH, type SkillMenuAction } from "../../../system/SkillMenu";
import { recordSkillUsage, sortSkillActionsByUsage } from "../../../system/skillUsage";
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
import { truncateFilenameMiddle, truncateLabel } from "../textUtils";
import { NoKeyTip } from "../../../system/modelKeyGate";
import {
  buildLongTextChip,
  collectClipboardImageFiles,
  longTextChipFromClick,
  shouldCollapsePastedText,
  LongTextFullscreen,
} from "../../../system/longText";
import { FileActionMenu } from "./FileActionMenu";
import { LinkedFilesPanel, type LinkedFileReference } from "./LinkedFilesPanel";
import { uploadFailureMessage, uploadFileSizeError } from "../data/uploadAsset";
import type { ChatChipSpec, ChatInputHandle, ChatInputSnapshot } from "../data/chatInputTypes";
export type { ChatChipSpec, ChatInputHandle, ChatInputSnapshot } from "../data/chatInputTypes";

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
  onAttachFolder: (signal?: AbortSignal) => Promise<void>;
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
 * insertion via Range/Selection. Once a shared `ChipEditor` is
 * extracted to ui-kit, this component will become the consumer site
 * rather than a parallel implementation.
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
  // 打开瞬间冻结行序；本次选用只记账，下次打开才按最新使用记录重排。
  const [skillMenuOrder, setSkillMenuOrder] = useState<string[]>([]);
  const [fileMenuOpen, setFileMenuOpen] = useState(false);
  // 技能菜单键盘高亮行(/ 唤起后 ↑/↓ 改它、Enter 选中)。
  const [skillIndex, setSkillIndex] = useState(0);
  // 「/」唤起时菜单浮在光标正上方的锚点(相对技能容器的 absolute 坐标);点按钮唤起则为 null(贴按钮上方)。
  const [skillAnchor, setSkillAnchor] = useState<{ left: number; bottom: number } | null>(null);
  // 技能菜单容器(按钮+浮层)ref:用于点外部/Esc 关闭。
  const skillWrapRef = useRef<HTMLDivElement>(null);
  // 文件菜单状态行点击后,让底部树展开并短暂定位高亮文件夹根节点。
  const [locateFolderSignal, setLocateFolderSignal] = useState(0);
  // 本客户端刚完成一次「关联文件夹」动作的信号:底部树据此在新 folderSource 到达时自动展开;
  // 进入已关联会话只是数据加载,不会 +1,面板保持收起。
  const [folderAttachSignal, setFolderAttachSignal] = useState(0);
  const fileResources = useResourceList({ kind: "file" });
  // 输入框是否为空(无文本且无 chip)——驱动"停止/发送"按钮切换。
  const [isEmpty, setIsEmpty] = useState(true);
  // 长文本小条点击 → 全屏查看的原文(null = 不显示)。
  const [longTextView, setLongTextView] = useState<string | null>(null);
  const { skills } = useSkills();
  const invocableSkillActions: SkillMenuAction[] = invocableSkillActionsFromApi(skills);
  const orderedSkillActions = useMemo(() => {
    const rank = new Map(skillMenuOrder.map((id, index) => [id, index]));
    return invocableSkillActions
      .map((action, initialIndex) => ({
        action,
        initialIndex,
        rank: rank.get(action.id),
      }))
      .sort((left, right) => {
        if (left.rank != null && right.rank != null) return left.rank - right.rank;
        if (left.rank != null) return -1;
        if (right.rank != null) return 1;
        return left.initialIndex - right.initialIndex;
      })
      .map(({ action }) => action);
  }, [invocableSkillActions, skillMenuOrder]);
  const sendDisabled = disabled && !sendEnabledWhenDisabled;
  const handleFolderAttachSuccess = useCallback(() => {
    setFolderAttachSignal((value) => value + 1);
  }, []);
  const {
    folderDialog,
    folderActionPending,
    requestAttach: requestAttachFolder,
    cancelAttach: cancelAttachFolder,
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
    onAttachSuccess: handleFolderAttachSuccess,
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
        // 纯文本、气泡 richText 与模型上下文共用同一个 DOM walker；不能依赖游离 clone
        // 的 innerText 布局计算，否则 contenteditable 用相邻 div 表示的换行会被吞掉。
        const { text, richText } = serializeChatInputContent(edit);

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
    recordSkillUsage(action.id);
    setSkillMenuOpen(false);
    reportChange();
  }, [disabled, reportChange]);

  const freezeSkillMenuOrder = useCallback(() => {
    setSkillMenuOrder(
      sortSkillActionsByUsage(invocableSkillActions).map((action) => action.id),
    );
  }, [invocableSkillActions]);

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
      // 中文/日文 IME 的 Enter 用于选字：composition 生命周期、原生 isComposing 与
      // Safari/旧浏览器常见的 keyCode 229 任一命中时都交还给输入法。
      if (
        e.key === "Enter" &&
        (composingRef.current ||
          e.nativeEvent.isComposing ||
          e.nativeEvent.keyCode === 229)
      ) {
        return;
      }
      // 技能菜单开着:↑/↓ 选行、Enter 选中、Esc/Backspace 关、其它字符键关并放行。
      if (skillMenuOpen) {
        const n = orderedSkillActions.length;
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
        if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          const action = orderedSkillActions[skillIndex];
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
        freezeSkillMenuOrder();
        setSkillAnchor(anchor);
        setFileMenuOpen(false);
        setSkillMenuOpen(true);
        onOpenSkillMenu?.();
        return;
      }
      // Enter 发送；Shift+Enter 保留 contenteditable 默认换行。Ctrl/Cmd+Enter
      // 自然落入同一发送分支，继续兼容旧快捷键。
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        // 未配置模型 key:键盘发送与置灰的发送按钮一样不放行,改成强弹引导气泡。
        if (noModelKey) {
          flashKeyTip();
          return;
        }
        if (!isEmpty) onSubmit();
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
    [
      disabled,
      onSubmit,
      reportChange,
      skillMenuOpen,
      orderedSkillActions,
      skillIndex,
      addSkill,
      freezeSkillMenuOrder,
      onOpenSkillMenu,
      noModelKey,
      flashKeyTip,
      isEmpty,
    ],
  );

  const removeAttachment = useCallback(
    (attachmentId: string) => {
      setAttachedFiles((prev) =>
        prev.filter((file) => attachmentFileKey(file) !== attachmentId),
      );
      const edit = editRef.current;
      if (!edit) return;
      removeAttachChips(edit, attachmentId);
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
            const attachmentId = chip.dataset.attachmentId;
            if (attachmentId) {
              removeAttachment(attachmentId);
              return;
            }
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
        const attachmentId = attachmentFileKey(f);
        if (hasLocalAttachChip(edit, attachmentId)) continue;
        const chip = makeChatChipNode({
          kind: "attach",
          label: f.name,
          attachmentId,
        });
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
      const files = Array.from(e.target.files ?? []);
      // 先复制 FileList 再清空 input，允许用户原样重选同一批文件。
      e.target.value = "";
      if (disabled) {
        return;
      }
      if (files.length === 0) return;

      const acceptedFiles: File[] = [];
      let hasUnsupportedFile = false;
      for (const file of files) {
        const sizeError = uploadFileSizeError(file);
        if (sizeError) {
          onToast?.(uploadFailureMessage(sizeError, "文件上传失败，请重试"));
          continue;
        }
        if (!isAcceptedUploadFile(file)) {
          hasUnsupportedFile = true;
          continue;
        }
        acceptedFiles.push(file);
      }
      if (hasUnsupportedFile) {
        window.alert(
          `暂不支持这种文件，可以试试 PDF、Word、Excel、PPT、TXT、Markdown 或图片。`,
        );
      }
      if (acceptedFiles.length === 0) return;

      // 保存整批原生 File 对象，延迟到提交时上传。未发送文件只作为输入框 chip 存在,
      // 发送后解析 tracker/resource 才会让它进入「已关联文件」面板。
      setAttachedFiles((prev) => {
        const next = [...prev];
        for (const file of acceptedFiles) {
          const attachmentId = attachmentFileKey(file);
          if (!next.some((existing) => attachmentFileKey(existing) === attachmentId)) {
            next.push(file);
          }
        }
        return next;
      });

      // 每个文件插入一个 attach chip（面板上传与按钮上传一致，都自动引用）。
      const edit = editRef.current;
      if (!edit) return;
      edit.focus();
      for (const file of acceptedFiles) {
        const attachmentId = attachmentFileKey(file);
        if (hasLocalAttachChip(edit, attachmentId)) continue;
        const r = restoreOrEndRange();
        r.deleteContents();
        const chip = makeChatChipNode({
          kind: "attach",
          label: file.name,
          attachmentId,
        });
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
      }
      reportChange();
    },
    [disabled, onToast, restoreOrEndRange, reportChange],
  );

  // 引用:文件夹文件用完整相对路径进入模型上下文，folderId + childRelPath 提供稳定身份。
  const insertAttachChip = useCallback(
    (reference: LinkedFileReference) => {
      const edit = editRef.current;
      if (!edit || disabled) return;
      const label = reference.childRelPath ?? reference.label;
      const resourceId = reference.folderId && reference.childRelPath
        ? folderFileResourceId(reference.folderId, reference.childRelPath)
        : undefined;
      // 同一资源的 attach chip 已存在则不重复插(普通素材沿用文件名去重)。
      if (hasReferencedAttachChip(edit, label, resourceId)) {
        edit.focus();
        reportChange();
        return;
      }
      const chip = makeChatChipNode({ kind: "attach", label, resourceId });
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

  const handleCancelAttachFolderFromMenu = useCallback(() => {
    setFileMenuOpen(false);
    cancelAttachFolder();
  }, [cancelAttachFolder]);

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
        multiple
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
                  freezeSkillMenuOrder();
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
              actions={orderedSkillActions}
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
              素材
            </button>
            {fileMenuOpen && (
              <FileActionMenu
                folderSource={folderSource}
                folderCapability={folderCapability}
                folderActionPending={folderActionPending}
                onChooseFile={handleChooseFileFromMenu}
                onAttachFolder={handleAttachFolderFromMenu}
                onCancelAttachFolder={handleCancelAttachFolderFromMenu}
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
            // 停止是常规操作不是危险操作 → 走次级按钮盒(墨色描边浅底),禁用红色;
            // 几何与「发送」按钮对齐(同字号/同内距/同高),样式落 workspace 皮肤的
            // [data-wf="WsStopBtn"] 选择器,不动 ui-kit 全局 ghost 定义。
            <Button
              size="small"
              onClick={onStop}
              disabled={!onStop}
              data-wf="WsStopBtn"
              title="停止本次输出"
            >
              <svg
                width="10"
                height="10"
                viewBox="0 0 10 10"
                fill="currentColor"
                aria-hidden="true"
                style={{ display: "block", flex: "0 0 auto" }}
              >
                <rect x="0.5" y="0.5" width="9" height="9" rx="1.6" />
              </svg>
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
                title={noModelKey ? "还没配置模型 key" : "Enter 发送 · Shift+Enter 换行"}
              >
                发送<ArrowRightIcon size={12} />
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
        folderAttachSignal={folderAttachSignal}
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
  // 长文本小条:统一走共享 builder(单行小条 + hover 预览 + data-text),与气泡一致。
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
  if (spec.attachmentId !== undefined) {
    chip.dataset.attachmentId = spec.attachmentId;
  }
  if (spec.resourceId !== undefined) chip.dataset.resourceId = spec.resourceId;
  if (spec.text !== undefined) chip.dataset.text = spec.text;
  if (spec.selectionRefs && spec.selectionRefs.length > 0) {
    chip.dataset.selectionRefs = JSON.stringify(spec.selectionRefs);
  }
  if (spec.tableSelection !== undefined) {
    chip.dataset.tableSelection = JSON.stringify(spec.tableSelection);
  }

  // Display text: for selection chips, truncate for compact display
  const displayLabel = spec.kind === "sel"
    ? truncateLabel(spec.label)
    : spec.kind === "attach"
      ? truncateFilenameMiddle(spec.label)
      : spec.label;

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
  if (spec.kind === "attach") labelEl.title = spec.label;
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

const attachmentFileIds = new WeakMap<File, string>();
let attachmentFileIdSequence = 0;

function attachmentFileKey(file: File): string {
  const existing = attachmentFileIds.get(file);
  if (existing) return existing;
  attachmentFileIdSequence += 1;
  const id = `local-attachment-${attachmentFileIdSequence}`;
  attachmentFileIds.set(file, id);
  return id;
}

function hasLocalAttachChip(edit: HTMLElement, attachmentId: string): boolean {
  return Array.from(edit.querySelectorAll<HTMLElement>(".chat-chip")).some(
    (chip) =>
      chip.dataset.kind === "attach" &&
      chip.dataset.attachmentId === attachmentId,
  );
}

function hasReferencedAttachChip(edit: HTMLElement, label: string, resourceId?: string): boolean {
  return Array.from(edit.querySelectorAll<HTMLElement>(".chat-chip")).some(
    (chip) =>
      chip.dataset.kind === "attach" &&
      chip.dataset.attachmentId === undefined &&
      (resourceId ? chip.dataset.resourceId === resourceId : chip.dataset.label === label),
  );
}

function folderFileResourceId(folderId: string, childRelPath: string): string {
  return `folder:${encodeURIComponent(folderId)}:${encodeURIComponent(childRelPath)}`;
}

function removeAttachChips(edit: HTMLElement, attachmentId: string): void {
  const chips = edit.querySelectorAll<HTMLElement>(".chat-chip");
  for (const chip of chips) {
    if (
      chip.dataset.kind === "attach" &&
      chip.dataset.attachmentId === attachmentId
    ) {
      chip.remove();
    }
  }
}

const CHAT_INPUT_BLOCK_TAGS = new Set([
  "ADDRESS",
  "BLOCKQUOTE",
  "DIV",
  "H1",
  "H2",
  "H3",
  "H4",
  "H5",
  "H6",
  "LI",
  "OL",
  "P",
  "PRE",
  "UL",
]);

function serializeChatInputContent(edit: HTMLElement): {
  text: string;
  richText: string;
} {
  let text = "";
  const richTextParts: ChipRichTextPart[] = [];
  let richTextHasContent = false;
  let richTextEndsWithBreak = false;
  let chipIndex = 0;

  const appendRichText = (value: string) => {
    if (!value) return;
    const last = richTextParts.at(-1);
    if (last?.kind === "text") last.text += value;
    else richTextParts.push({ kind: "text", text: value });
    richTextHasContent = true;
    richTextEndsWithBreak = value.endsWith("\n");
  };

  const appendBreak = () => {
    if (text.length > 0 && !text.endsWith("\n")) text += "\n";
    if (richTextHasContent && !richTextEndsWithBreak) appendRichText("\n");
  };

  const walk = (node: Node): void => {
    if (node.nodeType === Node.TEXT_NODE) {
      const value = node.textContent ?? "";
      text += value;
      appendRichText(value);
      return;
    }
    if (!(node instanceof HTMLElement)) return;
    if (node.classList.contains("chat-chip")) {
      if (
        (node.dataset.kind === "longtext" ||
          node.dataset.kind === "annotation") &&
        node.dataset.text != null
      ) {
        text += node.dataset.text;
      }
      const index = chipIndex++;
      richTextParts.push({ kind: "chip", index, marker: `{{chip:${index}}}` });
      richTextHasContent = true;
      richTextEndsWithBreak = false;
      return;
    }
    if (node.tagName === "BR") {
      appendBreak();
      return;
    }

    const isBlock = CHAT_INPUT_BLOCK_TAGS.has(node.tagName);
    if (isBlock) appendBreak();
    node.childNodes.forEach(walk);
    if (isBlock) appendBreak();
  };

  edit.childNodes.forEach(walk);
  return {
    text: text.trim(),
    richText: serializeChipRichText(trimChipRichTextParts(richTextParts)),
  };
}

function restoreSnapshotContent(edit: HTMLElement, snapshot: ChatInputSnapshot): void {
  while (edit.firstChild) edit.removeChild(edit.firstChild);

  const source = snapshot.richText || snapshot.text;
  const parts = parseChipRichText(source);
  const matched = parts.some((part) => part.kind === "chip");
  parts.forEach((part, index) => {
    if (part.kind === "text") {
      appendTextPreservingLines(edit, part.text);
      return;
    }
    const chip = snapshot.chips[part.index];
    if (chip) {
      edit.appendChild(makeChatChipNode(chip));
      const nextPart = parts[index + 1];
      const nextChar = nextPart?.kind === "text" ? nextPart.text[0] ?? "" : "";
      if (nextChar === "" || !/\s/.test(nextChar)) {
        edit.appendChild(document.createTextNode("\u00a0"));
      }
    }
  });
  if (!matched && source === snapshot.text) {
    for (const chip of snapshot.chips) {
      if (edit.childNodes.length > 0) edit.appendChild(document.createElement("br"));
      edit.appendChild(makeChatChipNode(chip));
      edit.appendChild(document.createTextNode("\u00a0"));
    }
  }
}

function trimChipRichTextParts(parts: ChipRichTextPart[]): ChipRichTextPart[] {
  const next = parts.map((part) => ({ ...part }));
  const first = next[0];
  if (first?.kind === "text") first.text = first.text.trimStart();
  const last = next.at(-1);
  if (last?.kind === "text") last.text = last.text.trimEnd();
  return next.filter((part) => part.kind === "chip" || part.text.length > 0);
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
  if (el.dataset.attachmentId !== undefined) {
    spec.attachmentId = el.dataset.attachmentId;
  }
  if (el.dataset.resourceId !== undefined) spec.resourceId = el.dataset.resourceId;
  if (el.dataset.text !== undefined) spec.text = el.dataset.text;
  const selectionRefs = parseSelectionRefs(el.dataset.selectionRefs);
  if (selectionRefs) spec.selectionRefs = selectionRefs;
  const tableSelection = parseTableSelection(el.dataset.tableSelection);
  if (tableSelection) spec.tableSelection = tableSelection;
  return spec;
}
