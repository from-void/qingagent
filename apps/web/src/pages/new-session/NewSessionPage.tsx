import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { routeToHash } from "../../shell";
import type { ChatChip } from "@qingagent/contract-ts";
import {
  ACCEPTED_UPLOAD_ACCEPT_ATTR,
  ACCEPTED_UPLOAD_LABEL,
  acceptedDocumentExtension,
  clearPendingFolderSource,
  deriveFolderCapability,
  FolderSourceControl,
  isAcceptedUploadFile,
  setPendingFolderSource,
  setPendingFiles,
  useClientCapabilities,
  useToast,
  type FolderSourceControlSource,
  type PendingFolderSource,
} from "../../system";
import "./new-session.css";
import "./new-session-qing.css";
import { StarterEditor } from "./components/StarterEditor";
import type { StarterEditorHandle } from "./components/StarterEditor";
import { CardSwap } from "./components/CardSwap";
import type { CardSwapHandle } from "./components/CardSwap";
import { HanziMatrix, getHanziMatrixHandle } from "./components/HanziMatrix";
import { HanziMatrixPanel } from "./components/HanziMatrixPanel";
import { SkillMenu, SparkleIcon, SKILL_MENU_WIDTH, type SkillMenuAction } from "../../system/SkillMenu";
import { invocableSkillActionsFromApi } from "../../system/skillDisplay";
import { useSkills } from "../../overlays/settings/useSkills";
import type { TemplateEntry } from "./data/templates";
import { buildCardTextures } from "./transition/textures";
import { createInkWipe } from "./transition/inkWipe";
import type { InkWipeHandle } from "./transition/inkWipe";
import { createDust } from "./transition/dust";
import {
  clearNpArrive,
  computeNewCardLandingRect,
  computeWorkspaceDocRect,
  peekNpArrive,
  setHomeArrive,
  setNpLandingRect,
} from "./transition/origin";
import { pickBrowserFolderSource } from "../workspace/data/browserFolderBridge";
import { DEFAULT_CHAT_INPUT_PLACEHOLDER } from "../workspace/data/chatInputBlockReason";
import { useModelKeyConfigured, goConfigureModel, NoKeyTip } from "../../system/modelKeyGate";

// 占位符与编辑页统一(用编辑页默认提示)。
const PLACEHOLDER = DEFAULT_CHAT_INPUT_PLACEHOLDER;
const EASE = "cubic-bezier(.2,.8,.2,1)";
const DESKTOP_FOLDER_TOKEN_SAFE_TTL_MS = 110_000;

export interface PendingAttachmentEntry {
  id: string;
  file: File;
}

export function pendingFilesVisibleInSnapshot(
  entries: readonly PendingAttachmentEntry[],
  chips: readonly { id?: string; type: string }[],
): File[] {
  const visibleIds = new Set(
    chips
      .filter((chip) => chip.type !== "skill" && chip.id)
      .map((chip) => chip.id!),
  );
  return entries
    .filter((entry) => visibleIds.has(entry.id))
    .map((entry) => entry.file);
}

function pendingFolderToDisplaySource(source: PendingFolderSource): FolderSourceControlSource {
  if (source.provider === "desktop-local") {
    return {
      id: "new-session-pending-folder",
      provider: "desktop-local",
      name: source.selection.name,
      pathLabel: source.selection.pathLabel,
      mountPath: "提交后连接到工作区",
      fileCount: source.selection.fileCount,
      fileCountCapped: source.selection.fileCountCapped,
      status: "connected",
      error: null,
    };
  }
  return {
    id: "new-session-pending-folder",
    provider: "browser-fs-access",
    name: source.picked.name,
    pathLabel: null,
    mountPath: "浏览器授权已暂存，提交后连接",
    fileCount: null,
    fileCountCapped: false,
    status: "connected",
    error: null,
  };
}

// 提交转场:汉字「吸入聚拢」到顶卡(demo play() 复刻)。
// 每个字朝顶卡中心带参差地飞入、缩小、淡出;时长/延迟/落点/缩放/旋转按字伪随机抖动。
function convergeHanzi(page: HTMLElement | null, cx: number, cy: number, cw: number, ch: number) {
  const host = page ? page.querySelector<HTMLElement>(".ccx-hanzi") : null;
  getHanziMatrixHandle(host)?.converge({ ch, cw, cx, cy });
}

export function NewSessionPage() {
  const editorRef = useRef<StarterEditorHandle>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const swapRef = useRef<CardSwapHandle>(null);

  // 过渡用 DOM 引用
  const pageRef = useRef<HTMLDivElement>(null);
  const inkCanvasRef = useRef<HTMLCanvasElement>(null);
  const dustCanvasRef = useRef<HTMLCanvasElement>(null);
  const morphRef = useRef<HTMLDivElement>(null);
  const newpageRef = useRef<HTMLDivElement>(null);
  const toastElRef = useRef<HTMLDivElement>(null);
  const revealRefs = useRef<(HTMLElement | null)[]>([]);

  const inkRef = useRef<InkWipeHandle | null>(null);
  const dustRef = useRef<ReturnType<typeof createDust> | null>(null);
  const busyRef = useRef(false);
  const texturesRef = useRef(buildCardTextures());
  const attachmentSeqRef = useRef(0);

  const [textLen, setTextLen] = useState(0);
  const [chipCount, setChipCount] = useState(0);
  const [menu, setMenu] = useState<null | "skill" | "file">(null);
  // 技能菜单键盘高亮行(/ 唤起后 ↑/↓ 改它、Enter 选中)。
  const [skillIndex, setSkillIndex] = useState(0);
  // 「/」唤起时菜单浮在光标正上方的锚点(相对技能容器的 absolute 坐标);点按钮唤起则为 null。
  const [skillAnchor, setSkillAnchor] = useState<{ left: number; bottom: number } | null>(null);
  // 技能按钮所在的 .ccx-tool 容器(position:relative),菜单锚点相对它换算。
  const skillToolRef = useRef<HTMLDivElement>(null);
  const [swapHidden, setSwapHidden] = useState(false);
  const [pendingAttachments, setPendingAttachments] = useState<PendingAttachmentEntry[]>([]);
  const [pendingFolder, setPendingFolder] = useState<PendingFolderSource | null>(null);
  const toast = useToast();
  const pendingFolderDisplaySource = useMemo(
    () => (pendingFolder ? pendingFolderToDisplaySource(pendingFolder) : null),
    [pendingFolder],
  );
  const clientCapabilities = useClientCapabilities();
  const folderCapability = deriveFolderCapability(clientCapabilities);
  const { skills } = useSkills();
  const newSessionSkillActions: SkillMenuAction[] = useMemo(
    () => invocableSkillActionsFromApi(skills),
    [skills],
  );

  const createAttachmentId = useCallback(() => {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return crypto.randomUUID();
    }
    attachmentSeqRef.current += 1;
    return `new-att-${Date.now()}-${attachmentSeqRef.current}`;
  }, []);

  const showCcxToast = useCallback((msg: string) => {
    const el = toastElRef.current;
    if (!el) return;
    el.textContent = msg;
    el.classList.add("on");
    window.clearTimeout((el as HTMLElement & { _tm?: number })._tm);
    (el as HTMLElement & { _tm?: number })._tm = window.setTimeout(
      () => el.classList.remove("on"),
      1800,
    );
  }, []);

  // ===== 真实业务逻辑(复用既有逻辑,版面换成 cc-b) =====

  const handleEditorChange = useCallback((text: string, chips: number) => {
    setTextLen(text.trim().length);
    setChipCount(chips);
    // 输入超过约 3 行 → 收起副标题让位(大标题保持不动,输入框向上铺展)
    const comp = revealRefs.current[3];
    const left = comp?.closest<HTMLElement>(".ccx-left");
    const edit = comp?.querySelector<HTMLElement>(".starter-edit");
    if (left && edit) {
      left.classList.toggle("is-dense", edit.scrollHeight > 112);
    }
  }, []);

  const hasModelKey = useModelKeyConfigured();
  // 未配置 key 时按发送快捷键:不放行,改成强弹引导气泡(短暂 is-forced),~2.6s 后自动收起。
  const [keyTipForced, setKeyTipForced] = useState(false);
  const keyTipTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flashKeyTip = useCallback(() => {
    if (keyTipTimerRef.current) clearTimeout(keyTipTimerRef.current);
    setKeyTipForced(false);
    requestAnimationFrame(() => {
      requestAnimationFrame(() => setKeyTipForced(true));
    });
    keyTipTimerRef.current = setTimeout(() => setKeyTipForced(false), 2600);
  }, []);
  useEffect(() => () => {
    if (keyTipTimerRef.current) clearTimeout(keyTipTimerRef.current);
  }, []);

  const handleSubmit = useCallback(() => {
    // 未配置模型 key:无论点按钮还是按快捷键,一律不放行,改成强弹引导气泡。
    if (!hasModelKey) {
      flashKeyTip();
      return;
    }
    const snap = editorRef.current?.snapshot();
    const visiblePendingFiles = snap
      ? pendingFilesVisibleInSnapshot(pendingAttachments, snap.chips)
      : [];
    if (
      !snap ||
      (snap.text.trim().length === 0 &&
        snap.chips.length === 0 &&
        visiblePendingFiles.length === 0 &&
        pendingFolder === null)
    ) {
      showCcxToast("先写点描述,或者加个素材吧");
      return;
    }
    // WYSIWYG(0702 重构):气泡与输入框所见完全一致——text=打字文本、chips 按原位置内联
    // ({{chip:N}} 占位,可穿插在文本任意处),**不再有任何"替用户说话"的兜底文案**
    // (旧"请帮我分析以下素材"/"请使用「」技能"都删了:前者把模型带偏找不存在的素材,
    // 后者不是用户说的话)。技能意图从 chip 派生成结构化 SkillRef 传后端(用于检索预加载/记录),
    // 文件意图由 fileIds/附件上下文承载——text 为空也是合法发送,气泡就显示 chip 本身。
    const contractChips: ChatChip[] = snap.chips.map((c) =>
      c.type === "skill"
        ? {
            kind: { kind: "skill" },
            resourceRef: null,
            skillId: c.id,
            prefix: null,
            label: c.name,
            suffix: null,
          }
        : {
            kind: { kind: "attach" },
            resourceRef: { id: c.id ?? `att-${Date.now()}`, domain: { kind: "file" } },
            prefix: null,
            label: c.name,
            suffix: null,
          },
    );
    const skillRefs = [
      ...new Set(snap.chips.filter((c) => c.type === "skill" && c.id).map((c) => c.id!)),
    ].map((id) => ({ id, version: null }));
    if (busyRef.current) return;
    if (
      pendingFolder?.provider === "desktop-local" &&
      Date.now() - pendingFolder.selectedAt > DESKTOP_FOLDER_TOKEN_SAFE_TTL_MS
    ) {
      showCcxToast("文件夹选择已过期，请重新选择");
      setPendingFolder(null);
      return;
    }
    sessionStorage.setItem("qingagent:pending-message", snap.text);
    if (snap.chips.length > 0) {
      sessionStorage.setItem("qingagent:pending-richtext", snap.richText);
      sessionStorage.setItem("qingagent:pending-chips", JSON.stringify(contractChips));
    } else {
      sessionStorage.removeItem("qingagent:pending-richtext");
      sessionStorage.removeItem("qingagent:pending-chips");
    }
    if (skillRefs.length > 0) {
      sessionStorage.setItem("qingagent:pending-skills", JSON.stringify(skillRefs));
    } else {
      sessionStorage.removeItem("qingagent:pending-skills");
    }
    if (visiblePendingFiles.length > 0) {
      setPendingFiles(visiblePendingFiles);
    }
    if (pendingFolder) {
      setPendingFolderSource(pendingFolder);
    } else {
      clearPendingFolderSource();
    }
    busyRef.current = true;
    showCcxToast("已起一卷新稿 · 开始读取素材");
    // 离场:左侧文案/输入/返回钮淡出(汉字不在此淡出 —— 改为逐字吸入顶卡)
    pageRef.current?.classList.add("is-leaving");

    const goWorkspace = () => {
      window.location.hash = routeToHash("workspace");
    };

    const fly = swapRef.current?.flyTopCard;
    if (fly && !swapHidden) {
      // 停轮换、量出顶卡 rect(= 汉字吸入的汇聚点 + 翻转起点)
      swapRef.current?.pause();
      const cardRect = swapRef.current?.topCardRect();
      const cx = cardRect ? cardRect.left + cardRect.width / 2 : window.innerWidth * 0.72;
      const cy = cardRect ? cardRect.top + cardRect.height / 2 : window.innerHeight / 2;
      const cardW = cardRect?.width ?? 300;
      const cardH = cardRect?.height ?? 380;

      // ① 汉字逐字吸入顶卡(参差);吸入大半后剩余汉字层缓慢隐去
      convergeHanzi(pageRef.current, cx, cy, cardW, cardH);
      window.setTimeout(() => pageRef.current?.classList.add("is-hz-gone"), 900);

      // ② 顶卡「掀页」翻转放大成 800 宽文档纸 —— 落点 = 编辑页那张纸的真实 rect。
      //    翻转结束帧 = 编辑页初始帧(computeWorkspaceDocRect 与 workspace-ink-skin.css 同一几何)。
      const docRect = computeWorkspaceDocRect();
      window.setTimeout(() => {
        fly(docRect).then(goWorkspace);
      }, 760);
    } else {
      // 兜底:无叠卡(直链态)时维持原 180ms 快速淡出
      window.setTimeout(goWorkspace, 180);
    }
  }, [hasModelKey, flashKeyTip, pendingAttachments, pendingFolder, showCcxToast, swapHidden]);

  const handleRemoveEditorChip = useCallback(
    (chip: { id?: string; type?: string; name?: string }) => {
      // 技能 chip 不需要状态同步(提交时从快照派生);附件 chip 按 id 同步待传文件。
      if (chip.type === "skill" || !chip.id) return;
      setPendingAttachments((prev) => prev.filter((entry) => entry.id !== chip.id));
    },
    [],
  );

  // 接收一批文件(选择/拖拽/粘贴图片共用):过滤可接受类型、为每个生成 id、插引用 chip、落待解析。
  const addAttachmentFiles = useCallback(
    (files: File[]) => {
      if (files.length === 0) return;
      let n = 0;
      let skipped = 0;
      const acceptedEntries: PendingAttachmentEntry[] = [];
      for (const f of files) {
        if (!isAcceptedUploadFile(f)) {
          skipped += 1;
          continue;
        }
        const id = createAttachmentId();
        const ext = acceptedDocumentExtension(f.name).replace(/^\./, "") || "file";
        editorRef.current?.insertChip({ id, type: ext.length <= 5 ? ext : "file", name: f.name });
        n += 1;
        acceptedEntries.push({ id, file: f });
      }
      if (acceptedEntries.length > 0) {
        setPendingAttachments((prev) => [...prev, ...acceptedEntries]);
      }
      if (n > 0) showCcxToast(`+ 已插入 ${n} 个本地文件`);
      if (skipped > 0) showCcxToast(`仅支持上传 ${ACCEPTED_UPLOAD_LABEL}`);
    },
    [createAttachmentId, showCcxToast],
  );

  const handleFilesPicked = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = e.target.files;
      if (files && files.length > 0) addAttachmentFiles(Array.from(files));
      e.target.value = "";
    },
    [addAttachmentFiles],
  );

  const handlePickSkill = useCallback((skill: SkillMenuAction) => {
    // 共用结构里 label 即 API 下发的技能短名。
    // chip 携带 skill id(dataset.chipId),提交时从快照的 chips 里派生 SkillRef——
    // 输入框 DOM 即唯一真相源,不设并行 selectedSkills 状态(0702:并行状态会与输入框脱节)。
    editorRef.current?.insertChip({ id: skill.id, type: "skill", name: skill.label });
    setMenu(null);
  }, []);

  // 反斜杠唤起技能菜单 + ↑/↓/Enter/Esc 导航(与编辑页一致)。返回 true = 已处理,编辑器不再处理。
  const handleSkillKey = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>): boolean => {
      if (menu === "skill") {
        const n = newSessionSkillActions.length;
        if (e.key === "ArrowDown") {
          e.preventDefault();
          if (n) setSkillIndex((i) => (i + 1) % n);
          return true;
        }
        if (e.key === "ArrowUp") {
          e.preventDefault();
          if (n) setSkillIndex((i) => (i - 1 + n) % n);
          return true;
        }
        if (e.key === "Enter") {
          e.preventDefault();
          const action = newSessionSkillActions[skillIndex];
          if (action) handlePickSkill(action);
          return true;
        }
        if (e.key === "Escape" || e.key === "Backspace") {
          e.preventDefault();
          setMenu(null);
          return true;
        }
        if (e.key.length === 1) setMenu(null);
      }
      // 「/」唤起(仅词首/空白后);菜单浮在光标正上方。
      if (e.key === "/" && menu !== "skill") {
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
        if (!atStart) return false;
        e.preventDefault();
        // 光标视口坐标 → 相对 .ccx-tool 的 absolute 锚点(不用 fixed:祖先 backdrop-filter/transform 会带偏)。
        let anchor: { left: number; bottom: number } | null = null;
        const wrapRect = skillToolRef.current?.getBoundingClientRect();
        if (wrapRect && caretTop != null && caretLeft != null) {
          const vpLeft = Math.max(8, Math.min(caretLeft, window.innerWidth - SKILL_MENU_WIDTH - 12));
          anchor = { left: vpLeft - wrapRect.left, bottom: wrapRect.bottom - caretTop + 6 };
        }
        setSkillIndex(0);
        setSkillAnchor(anchor);
        setMenu("skill");
        return true;
      }
      return false;
    },
    [menu, skillIndex, newSessionSkillActions, handlePickSkill],
  );

  const handlePickLocalFile = useCallback(() => {
    setMenu(null);
    fileInputRef.current?.click();
  }, []);

  const handleAttachFolder = useCallback(async () => {
    setMenu(null);
    const selectFolderSource = window.electron?.isDesktop
      ? window.electron.selectFolderSource
      : undefined;
    if (selectFolderSource) {
      try {
        const selection = await selectFolderSource();
        if (!selection) return;
        setPendingFolder({ provider: "desktop-local", selectedAt: Date.now(), selection });
        showCcxToast(`已选择文件夹：${selection.name}`);
      } catch (error) {
        console.error("[NewSessionPage] selectFolderSource failed", error);
        showCcxToast("选择文件夹失败，请重试");
      }
      return;
    }

    if (folderCapability.enabled && typeof window.showDirectoryPicker === "function") {
      try {
        const picked = await pickBrowserFolderSource("new-session");
        setPendingFolder({ provider: "browser-fs-access", picked });
        showCcxToast(`已选择文件夹：${picked.name}`);
      } catch (error) {
        // 用户在系统选择器里点了取消(AbortError)→ 不弹任何提示(原来会弹一条英文 toast)。
        if (error instanceof DOMException && error.name === "AbortError") return;
        console.error("[NewSessionPage] showDirectoryPicker failed", error);
        showCcxToast(error instanceof Error ? error.message : "选择文件夹失败，请重试");
      }
      return;
    }

    showCcxToast(folderCapability.reason ?? "当前环境暂不支持连接文件夹");
  }, [folderCapability.enabled, folderCapability.reason, showCcxToast]);

  const handleRemovePendingFolder = useCallback(() => {
    setPendingFolder(null);
    showCcxToast("已移除文件夹");
  }, [showCcxToast]);

  // 模板回填:setText + 渐变扫入(由左向右带渐变边显形)+ 输入框金边一闪
  const handleFillTemplate = useCallback(
    (tpl: TemplateEntry) => {
      editorRef.current?.setText(tpl.fill);
      const comp = revealRefs.current[3]; // .ccx-composer
      if (comp) {
        comp.classList.remove("ccx-filled");
        void comp.offsetWidth;
        comp.classList.add("ccx-filled");
        window.setTimeout(() => comp.classList.remove("ccx-filled"), 780);
        const edit = comp.querySelector<HTMLElement>(".starter-edit");
        if (edit) {
          edit.classList.remove("ccx-wipe");
          void edit.offsetWidth;
          edit.classList.add("ccx-wipe");
          window.setTimeout(() => edit.classList.remove("ccx-wipe"), 460);
        }
      }
      showCcxToast(`已使用模板「${tpl.name}」`);
    },
    [showCcxToast],
  );

  // 预热编辑页 chunk:用户一进新建页(下一步多半是创建→进编辑页),空闲时就把
  // workspace(最重,含 tiptap)的 chunk 拉好,争取最大提前量,消除「新建页→编辑页」首切白屏。
  // Vite 对同一动态 import 去重,与 App 的预热共用同一 chunk、只拉一次。
  useEffect(() => {
    const warm = () => {
      void import("../workspace/WorkspacePage");
    };
    const ric = (window as typeof window & {
      requestIdleCallback?: (cb: () => void) => number;
    }).requestIdleCallback;
    if (ric) {
      ric(warm);
      return;
    }
    const t = window.setTimeout(warm, 150);
    return () => window.clearTimeout(t);
  }, []);

  // 拖拽文件(仅本页挂载时生效)
  useEffect(() => {
    let dragDepth = 0;
    const isFileDrag = (e: DragEvent): boolean => {
      const dt = e.dataTransfer;
      if (!dt) return false;
      for (let i = 0; i < dt.types.length; i += 1) {
        if (dt.types[i] === "Files") return true;
      }
      return false;
    };
    const onEnter = (e: DragEvent) => {
      if (!isFileDrag(e)) return;
      dragDepth += 1;
      e.preventDefault();
    };
    const onOver = (e: DragEvent) => {
      if (isFileDrag(e)) e.preventDefault();
    };
    const onLeave = () => {
      dragDepth = Math.max(0, dragDepth - 1);
    };
    const onDrop = (e: DragEvent) => {
      dragDepth = 0;
      if (!isFileDrag(e)) return;
      e.preventDefault();
      const files = e.dataTransfer?.files;
      if (!files || files.length === 0) return;
      let n = 0;
      let skipped = 0;
      const acceptedEntries: PendingAttachmentEntry[] = [];
      for (const f of Array.from(files)) {
        if (!isAcceptedUploadFile(f)) {
          skipped += 1;
          continue;
        }
        const id = createAttachmentId();
        const ext = acceptedDocumentExtension(f.name).replace(/^\./, "") || "file";
        editorRef.current?.insertChip({ id, type: ext.length <= 5 ? ext : "file", name: f.name });
        n += 1;
        acceptedEntries.push({ id, file: f });
      }
      if (acceptedEntries.length > 0) {
        setPendingAttachments((prev) => [...prev, ...acceptedEntries]);
      }
      if (n > 0) showCcxToast(`+ 已拖入 ${n} 个文件`);
      if (skipped > 0) showCcxToast(`仅支持上传 ${ACCEPTED_UPLOAD_LABEL}`);
    };
    window.addEventListener("dragenter", onEnter);
    window.addEventListener("dragover", onOver);
    window.addEventListener("dragleave", onLeave);
    window.addEventListener("drop", onDrop);
    return () => {
      window.removeEventListener("dragenter", onEnter);
      window.removeEventListener("dragover", onOver);
      window.removeEventListener("dragleave", onLeave);
      window.removeEventListener("drop", onDrop);
    };
  }, [createAttachmentId, showCcxToast]);

  // 点空白关菜单
  useEffect(() => {
    if (!menu) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (target?.closest(".ccx-tool")) return;
      setMenu(null);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [menu]);

  // ===== 过渡编排:墨水 reveal + morph 飞卡 + 左侧 cascade =====

  const revealLeftCascade = useCallback(() => {
    revealRefs.current.forEach((el, i) => {
      if (!el || el.classList.contains("on")) return;
      window.setTimeout(() => el.classList.add("on"), i * 90);
    });
  }, []);

  // 文字入场:淡入 + 上浮 + 去模糊
  const inkInText = useCallback(
    (el: Element | null, baseTransform: string, restOpacity = 1) => {
      if (!el || !(el as HTMLElement).animate) return;
      (el as HTMLElement).animate(
        [
          { opacity: 0, transform: `${baseTransform} translateY(14px)`, filter: "blur(3px)" },
          { opacity: restOpacity, transform: `${baseTransform} translateY(0)`, filter: "blur(0)" },
        ],
        { duration: 380, easing: EASE, fill: "both" },
      );
    },
    [],
  );

  // 方案4 · 进场到达态:核心动效(卡飞 + 墨水/背景变深)已在首页跑完,这里**不**再播放;
  // 挂载即「已到达态」静帧 —— 背景瞬时已深(零淡入)、morph 卡正好停在落点 rect(零飞行),
  // 然后只对左文案/输入/右叠卡/返回钮做淡入。最后回写真实落点 rect 供下次进场像素对齐。
  // ⚠️ useLayoutEffect:到达态(置深背景 + 卡静停)必须在首帧 paint 前完成,否则会先闪一帧
  //    浅色/未就位再跳到位 → 切换瞬间闪。
  useLayoutEffect(() => {
    const page = pageRef.current;
    const morph = morphRef.current;
    const newpage = newpageRef.current;
    if (!page || !morph || !newpage) return;

    // 初始化墨水 / 墨尘引擎(返回时墨退复用 ink;到达态背景靠 CSS is-dark,无需播墨)
    let ink: InkWipeHandle | null = null;
    if (inkCanvasRef.current) {
      ink = createInkWipe(inkCanvasRef.current);
      inkRef.current = ink;
    }
    if (dustCanvasRef.current) {
      dustRef.current = createDust(dustCanvasRef.current);
    }

    // peek 语义:不在此清除(防 StrictMode 第一次被丢弃的挂载误消费),待到达态编排提交后再 clear。
    const arrive = peekNpArrive();

    const revealExtras = () => {
      // 左文案/输入 cascade + 返回钮(.ccx-back 由 is-np 控制)
      page.classList.add("is-np");
      revealLeftCascade();
    };

    if (!arrive) {
      // 无到达态(直链 #/new 或 storage 不可用):直接显现兜底(对卡也不飞)。
      page.classList.add("no-ink", "is-dark");
      dustRef.current?.start();
      newpage.style.opacity = "1";
      newpage.style.visibility = "visible";
      revealExtras();
      requestAnimationFrame(() => {
        newpage.querySelectorAll<HTMLElement>(".ccx-tname").forEach((n) => {
          n.style.opacity = "";
        });
        const real = swapRef.current?.topCardRect();
        if (real) setNpLandingRect({ left: real.left, top: real.top, width: real.width, height: real.height });
      });
      return () => {
        inkRef.current?.dispose();
        dustRef.current?.dispose();
      };
    }

    // —— 有到达态:静帧落地,零入场动画 ——
    busyRef.current = true;
    // 背景瞬时已深(is-ink-wipe 让 .ccx-space 无慢渐显;is-dark 立刻满深)→ 与首页最后一帧一致。
    page.classList.add("is-ink-wipe", "is-dark");
    dustRef.current?.start();

    // morph 卡静停在落点(= 首页交付的 landing rect),与首页最后一帧 morph 同坐标 → 切换不跳。
    const land = arrive.rect;
    morph.style.transition = "none";
    morph.style.width = land.width + "px";
    morph.style.height = land.height + "px";
    morph.style.transform = `translate(${land.left}px,${land.top}px)`;
    morph.style.opacity = "1";

    // 右叠卡先隐(morph 顶着),壳就位后再交接显形。
    setSwapHidden(true);
    newpage.style.visibility = "visible";
    newpage.style.opacity = "1";

    // 下一帧:真实叠卡显形并接管 morph 位置 → 交叉淡出 morph,淡入额外元素。
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        // 到达态编排已提交,此刻消费到达态(避开 StrictMode 第一次挂载误清)。
        clearNpArrive();
        // 回写真实测量落点 rect(覆盖首页 CSS 解析估计)→ 下次进场像素级对齐。
        const real = swapRef.current?.topCardRect();
        if (real) setNpLandingRect({ left: real.left, top: real.top, width: real.width, height: real.height });

        // 模板名先隐,叠卡显形后入场浮现
        newpage.querySelectorAll<HTMLElement>(".ccx-tname").forEach((n) => {
          n.style.opacity = "0";
        });
        setSwapHidden(false); // 真实叠卡显形(就位于 morph 之下,同一 rect)
        revealExtras();

        requestAnimationFrame(() => {
          // 到达态已确立:墨层与 is-ink-wipe 状态退场(背景由 is-dark 维持)。
          inkRef.current?.hide();
          page.classList.remove("is-ink-wipe");
          // 交叉淡出 morph(叠卡已在其下同位)
          morph.style.transition = "opacity 0.3s ease";
          morph.style.opacity = "0";
          const names = newpage.querySelectorAll<HTMLElement>(".ccx-tname");
          names.forEach((nameEl, depth) => {
            window.setTimeout(() => {
              nameEl.style.opacity = "";
              inkInText(nameEl, "translateY(-50%)");
            }, depth * 40);
          });
          busyRef.current = false;
        });
      });
    });

    return () => {
      inkRef.current?.dispose();
      dustRef.current?.dispose();
    };
    // 仅挂载时执行一次到达态编排
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ===== 方案4 · 返回:先淡出额外元素,只留卡 + 深背景 → 切路由,首页跑反向核心动效 =====
  // 本页**不**再播放卡飞回 / 墨退(那是首页的活)。这里只:① 淡出左文案/输入/叠卡/返回钮;
  // ② 把 morph 克隆体静停在「当前顶层卡 rect」(切换瞬间首页 snapArrived 用同一 rect 接管);
  // ③ 交付到达态(rect + 墨退中心)给首页,切回 #/。
  const goBack = useCallback(() => {
    if (busyRef.current) return;
    const page = pageRef.current;
    const morph = morphRef.current;
    const newpage = newpageRef.current;
    if (!page || !morph || !newpage) {
      setHomeArrive({
        rect: computeNewCardLandingRect(),
        x: window.innerWidth / 2,
        y: window.innerHeight / 2,
      });
      window.location.hash = routeToHash("home");
      return;
    }
    busyRef.current = true;
    swapRef.current?.pause();

    // 起点 = 当前顶层卡 rect(交给首页做反向核心动效的起点)。
    const topRect = swapRef.current?.topCardRect();
    const fromRect = topRect
      ? { left: topRect.left, top: topRect.top, width: topRect.width, height: topRect.height }
      : computeNewCardLandingRect();

    // morph 静停在该 rect(零动画),叠卡随即隐去 → 切换瞬间「只剩卡 + 深背景」。
    morph.style.transition = "none";
    morph.style.width = fromRect.width + "px";
    morph.style.height = fromRect.height + "px";
    morph.style.transform = `translate(${fromRect.left}px,${fromRect.top}px)`;
    morph.style.opacity = "1";
    setSwapHidden(true);

    // 额外元素淡出(左文案/输入/返回钮:.ccx-reveal + is-returning;右 label 同属 reveal)。
    page.classList.add("is-returning");
    revealRefs.current.forEach((el) => el?.classList.remove("on"));

    // 等额外元素淡出帧数后切路由(只切「卡 + 深背景」这层静止帧 → 首页用同 rect 接管)。
    window.setTimeout(() => {
      setHomeArrive({
        rect: fromRect,
        x: fromRect.left + fromRect.width / 2,
        y: fromRect.top + fromRect.height / 2,
      });
      window.location.hash = routeToHash("home");
    }, 460);
  }, []);

  // Ctrl+Shift+H 唤起/收起汉字矩阵调参面板(右下角,默认隐藏)。
  // 与首页 cleanMode / workspace 调试面板同一快捷键约定。
  const [hanziPanelOpen, setHanziPanelOpen] = useState(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === "H" || e.key === "h")) {
        e.preventDefault();
        setHanziPanelOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Esc 返回
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.key !== "Escape") return;
      if (document.querySelector('[aria-modal="true"], [role="dialog"]')) return;
      goBack();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [goBack]);

  const canSubmit =
    textLen > 0 ||
    chipCount > 0 ||
    pendingAttachments.length > 0 ||
    pendingFolder !== null;
  const textures = texturesRef.current;

  return (
    <section
      data-view="new-session"
      data-wf="NewSessionPage"
      className="active ccx-page"
      ref={pageRef}
    >
      {/* 玄青夜空 / 汉字矩阵 / 墨尘 / 墨水 reveal */}
      <div className="ccx-space" />
      <HanziMatrix />
      <canvas className="ccx-dust" ref={dustCanvasRef} />
      <canvas className="ccx-ink" ref={inkCanvasRef} />

      {/* 共享元素 morph 飞卡 */}
      <div className="ccx-morph">
        {/* face 是用户看到的唯一纸边；ref 的几何写入不得落到装饰外盒。 */}
        <div
          className="ccx-morph-face"
          data-wf="TransitionPaperFace"
          ref={morphRef}
        >
          <div
            className="ccx-morph-noise"
            style={{ background: `${textures.noise} repeat` }}
          />
          <div className="ccx-morph-frame" />
          <i className="ccx-morph-corner tl" />
          <i className="ccx-morph-corner br" />
        </div>
      </div>

      {/* 返回按钮 */}
      <button type="button" className="ccx-back" title="返回首页" onClick={goBack}>
        <span className="a">←</span>
      </button>

      {/* 新建页内容 */}
      <div className="ccx-newpage" ref={newpageRef}>
        <div className="ccx-left">
          <div
            className="ccx-kicker ccx-reveal"
            ref={(el) => {
              revealRefs.current[0] = el;
            }}
          >
            <img
              className="seal-img"
              src="/chinese-masonry-assets/curated-backgrounds/seal-kongshengmiaoyou.png"
              alt="空生妙有"
            />{" "}
            新起一卷
          </div>
          <h1
            className="ccx-h1 ccx-reveal"
            ref={(el) => {
              revealRefs.current[1] = el;
            }}
          >
            一句起笔，
            <br />
            还你一篇<span className="em">成章</span>
          </h1>
          <p
            className="ccx-lede ccx-reveal"
            ref={(el) => {
              revealRefs.current[2] = el;
            }}
          >
            选择技能或上传参考文件，写作、改写、润色、扩写都能做。
          </p>

          <div
            className="ccx-composer ccx-reveal"
            ref={(el) => {
              revealRefs.current[3] = el;
            }}
          >
            <StarterEditor
              ref={editorRef}
              placeholder={PLACEHOLDER}
              onChange={handleEditorChange}
              onSubmit={handleSubmit}
              onRemoveChip={handleRemoveEditorChip}
              onKeyDownCapture={handleSkillKey}
              onPasteFiles={addAttachmentFiles}
            />
            <input
              ref={fileInputRef}
              type="file"
              multiple
              accept={ACCEPTED_UPLOAD_ACCEPT_ATTR}
              style={{ display: "none" }}
              onChange={handleFilesPicked}
            />
            <div className="ccx-toolbar">
              <div className="ccx-tool" ref={skillToolRef}>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    setMenu((m) => {
                      const next = m === "skill" ? null : "skill";
                      if (next === "skill") {
                        setSkillIndex(0);
                        setSkillAnchor(null);
                      }
                      return next;
                    });
                  }}
                >
                  <SparkleIcon className="ccx-ico" />
                  技能
                </button>
                {menu === "skill" ? (
                  <SkillMenu
                    actions={newSessionSkillActions}
                    onPick={handlePickSkill}
                    selectedIndex={skillIndex}
                    onHoverIndex={setSkillIndex}
                    anchor={skillAnchor}
                    dataWf="NsSkillMenu"
                  />
                ) : null}
              </div>
              <div className="ccx-tool">
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    // 「文件」直接弹系统选择器(原来那个只有「本地文件」一项的中间菜单是多余的)。
                    handlePickLocalFile();
                  }}
                >
                  <FileSvg />
                  文件
                </button>
              </div>
              <FolderSourceControl
                rootClassName="ccx-tool ccx-folder-wrap"
                buttonClassName={({ active, selecting }) =>
                  `ccx-folder-btn${active ? " is-active" : ""}${selecting ? " is-selecting" : ""}`
                }
                folderSource={pendingFolderDisplaySource}
                folderCapability={folderCapability}
                onAttachFolder={handleAttachFolder}
                onDetachFolder={async () => handleRemovePendingFolder()}
                disabled={false}
                dataWfPrefix="NewSession"
                tooltipId="ccx-folder-tooltip"
                introTitleId="ccx-folder-intro-title"
                disconnectTitleId="ccx-folder-disconnect-title"
                connectedBehavior="confirm-detach"
                connectedHint="提交后将连接到工作区"
              />
              <NoKeyTip active={!hasModelKey} forced={keyTipForced} onConfigure={() => goConfigureModel(goBack)}>
                <button
                  type="button"
                  className={`ccx-send${canSubmit && hasModelKey ? "" : " disabled"}`}
                  aria-disabled={!canSubmit || !hasModelKey}
                  title={
                    !hasModelKey
                      ? "还没配置模型 key"
                      : !canSubmit
                        ? "先写点描述，或加个素材"
                        : "开始写作"
                  }
                  onClick={() => {
                    if (hasModelKey) handleSubmit();
                  }}
                  data-wf="StartSession"
                >
                  →
                </button>
              </NoKeyTip>
            </div>
          </div>
        </div>

        <div className="ccx-right">
          <CardSwap
            ref={swapRef}
            textures={textures}
            onFill={handleFillTemplate}
            hidden={swapHidden}
          />
        </div>
      </div>

      <div className="ccx-toast" ref={toastElRef} />

      {/* 汉字矩阵调参面板:Ctrl+Shift+H 唤起 */}
      {hanziPanelOpen && <HanziMatrixPanel />}
    </section>
  );
}

function FileSvg() {
  return (
    <svg
      className="ccx-ico"
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M13.5 3.5H6.5A1.5 1.5 0 0 0 5 5v14a1.5 1.5 0 0 0 1.5 1.5h11A1.5 1.5 0 0 0 19 19V9z" />
      <path d="M13.5 3.5V9H19" />
    </svg>
  );
}
