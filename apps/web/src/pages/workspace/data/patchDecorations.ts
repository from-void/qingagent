import { Extension } from "@tiptap/core";
import type { Editor } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { viewSectionsToHtml } from "./viewDocHtml";
import { createNativeCursorWidget } from "./nativePresentationPm";
import { splitGraphemes } from "./presentationSpans";
import type { DocSuggestion } from "./protocol";
import type { AppliedPatch, BlockPatchInput, PatchOverlayInput, ReviewTarget, ViewBlock } from "./protocol";
import type { PmBlockNode, PmDoc, PmMark, PmNode } from "@qingagent/pm-schema";
import type { Root } from "react-dom/client";
import { TOOLBAR_HIGHLIGHT_COLORS, TOOLBAR_TEXT_COLORS } from "./toolbarUnlock";
import type { ReviewTableCellTypedCounts, ReviewTableTypedByPatch } from "./tableTypewriter";

/** 审阅态块级新增补丁的 React 渲染注入(由 dom 环境的 DocumentSnapshotView 提供;
 *  node 单元测试不注入时 renderBlockInsertDOM 走 innerHTML 降级,零 React/katex 依赖)。 */
export type MountBlockView = (
  container: HTMLElement,
  blocks: readonly ViewBlock[],
  pmNodes?: readonly PmBlockNode[],
  beforePmNodes?: readonly PmBlockNode[],
  patchIndex?: number,
  suppressLocalPopup?: boolean,
  reviewTargets?: readonly ReviewTarget[],
  activeTargetId?: string | null,
  inputIndex?: number,
  tableTypedCounts?: ReviewTableCellTypedCounts,
) => Root;

type PatchDecorationMeta =
  | { kind: "set"; decorations: Decoration[] }
  | { kind: "clear" };

type PatchDecorationKind = "insert" | "delete" | "replace" | "markAdd" | "markRemove";

type PatchDecorationSource = {
  id: string;
  before: string;
  after: string;
  kind?: AppliedPatch["kind"];
  marks?: PmMark[];
  label?: string;
  pmFrom?: number;
  pmTo?: number;
};

type PatchDecorationSpec = {
  "data-patch-id": string;
  "data-patch-index": number;
  patchStatus: "reviewing" | "accepted" | "rejected";
  patchKind: PatchDecorationKind;
};

export type BuildPatchDecorationsArgs = {
  suggestions?: readonly DocSuggestion[];
  overlayInputs?: readonly PatchOverlayInput[];
  blockPatches?: readonly BlockPatchInput[];
  applied: readonly AppliedPatch[];
  baselineDoc: PmDoc;
  acceptedIds?: ReadonlySet<string> | readonly string[];
  rejectedIds?: ReadonlySet<string> | readonly string[];
  activePatchId?: string | null;
  activeReviewTargetId?: string | null;
  reviewTargets?: readonly ReviewTarget[];
  revealedPatchIds?: ReadonlySet<string> | null;
  typedByPatch?: ReadonlyMap<string, number> | null;
  revealCursors?: ReadonlyMap<string, number> | null;
  mountBlockView?: MountBlockView;
  tableTypedByPatch?: ReviewTableTypedByPatch | null;
};

export const patchDecorationKey = new PluginKey<DecorationSet>(
  "patchDecorations",
);

export const PatchDecorations = Extension.create({
  name: "patchDecorations",
  addProseMirrorPlugins() {
    return [
      new Plugin<DecorationSet>({
        key: patchDecorationKey,
        state: {
          init: () => DecorationSet.empty,
          apply(tr, value) {
            const meta = tr.getMeta(patchDecorationKey) as
              | PatchDecorationMeta
              | undefined;
            if (meta?.kind === "set") {
              try {
                return DecorationSet.create(tr.doc, meta.decorations);
              } catch (error) {
                console.warn("[patch] decoration set 创建失败，已逐条过滤坏 decoration", error);
                return createBestEffortDecorationSet(tr.doc, meta.decorations);
              }
            }
            if (meta?.kind === "clear") return DecorationSet.empty;
            return value.map(tr.mapping, tr.doc);
          },
        },
        props: {
          decorations(state) {
            return patchDecorationKey.getState(state);
          },
        },
      }),
    ];
  },
});

export function setPatchDecorations(
  editor: Editor | null,
  decorations: Decoration[],
): void {
  if (!editor || editor.isDestroyed) return;
  const safeDecorations = sanitizePatchDecorations(editor, decorations);
  const tr = editor.state.tr.setMeta(patchDecorationKey, {
    kind: safeDecorations.length > 0 ? "set" : "clear",
    decorations: safeDecorations,
  } satisfies PatchDecorationMeta);
  editor.view.dispatch(tr);
}

export function clearPatchDecorations(editor: Editor | null): void {
  if (!editor || editor.isDestroyed) return;
  const tr = editor.state.tr.setMeta(patchDecorationKey, {
    kind: "clear",
  } satisfies PatchDecorationMeta);
  editor.view.dispatch(tr);
}

export function buildPatchDecorations(args: BuildPatchDecorationsArgs): {
  decorations: Decoration[];
  dropped: string[];
} {
  const docSize = pmDocContentSize(args.baselineDoc);
  const appliedById = new Map(args.applied.map((patch) => [patch.id, patch]));
  const acceptedIds = toReadonlySet(args.acceptedIds);
  const rejectedIds = toReadonlySet(args.rejectedIds);
  const decorations: Decoration[] = [];
  const dropped: string[] = [];
  const blockRanges = topLevelBlockRanges(args.baselineDoc);

  for (const source of collectSources(args)) {
    const applied = appliedById.get(source.id);
    const before = applied?.before ?? source.before;
    const after = applied?.after ?? source.after;
    const kind = resolvePatchDecorationKind(applied?.kind ?? source.kind, before, after);
    if (!kind) continue;
    if (!isPatchRevealed(source.id, args.revealedPatchIds)) continue;

    const from = source.pmFrom;
    const to = source.pmTo;
    if (!validAnchor(from, to, docSize)) {
      dropped.push(source.id);
      continue;
    }

    if (rejectedIds.has(source.id)) continue;

    const index = applied?.index ?? 0;
    const status = acceptedIds.has(source.id) ? "accepted" : "reviewing";
    const spec = patchSpec(source.id, index, status, kind);
    const currentClass = args.activePatchId === source.id ? " is-current" : "";
    const statusClass = status === "accepted" ? " is-accepted" : "";

    if (kind === "markAdd" || kind === "markRemove") {
      if (to! <= from!) {
        dropped.push(source.id);
        continue;
      }
      decorations.push(
        Decoration.inline(
          from!,
          to!,
          {
            class: `wf-patch-ins-wrap wf-patch-mark-wrap wf-patch-mark ${kind === "markAdd" ? "add" : "remove"}${currentClass}${statusClass}`,
            "data-patch-id": source.id,
            "data-patch-index": String(index),
            "data-patch-state": "format",
            ...markDecorationStyle(kind, args.activePatchId === source.id, source.marks),
          },
          spec,
        ),
      );
      continue;
    }

    // 审阅态删除铁律：含 replace 旧值在内，被删正文原位只留「竖线+圆点」游标，
    // 原文仅在 hover 卡展示。改此处前先读 AGENTS.md UI Iron Rules。
    if (kind === "delete" || kind === "replace") {
      if (to! <= from!) {
        dropped.push(source.id);
        continue;
      }
      decorations.push(
        Decoration.inline(
          from!,
          to!,
          {
            class: `wf-patch-del${currentClass}${statusClass}`,
            "data-patch-id": source.id,
            "data-patch-index": String(index),
            "data-patch-state": "delete",
          },
          spec,
        ),
      );
      decorations.push(
        Decoration.widget(
          from!,
          () => renderDeleteMarkerDOM(source.id, index, currentClass, statusClass),
          {
            ...spec,
            // 稳定 key(含 current/accepted 状态):切换 activePatchId 时 ProseMirror 靠 key
            // 复用未变 widget,只重建高亮状态真正变化的一两处,避免全量重挂导致满屏闪烁。
            key: `pdel-${source.id}-${index}-${currentClass}-${statusClass}`,
            side: 1,
            ignoreSelection: true,
          },
        ),
      );
    }

    if (kind === "insert" || kind === "replace") {
      // replace 新值锚到隐藏旧范围末尾，与其起点的紧凑删除游标分离；正文中不会出现旧新拼接。
      const insertAt = kind === "replace" ? to! : from!;
      const insertedText = revealedInsertedText(source.id, after, args.typedByPatch);
      if (insertedText.length > 0) {
        decorations.push(
          Decoration.widget(
            insertAt,
            () => {
              const dom = renderInsertDOM(
                insertedText,
                applied?.marks ?? source.marks,
                kind === "replace" ? "replace" : "insert",
              );
              dom.className = `${dom.className}${currentClass}${statusClass}`;
              dom.dataset.patchId = source.id;
              dom.dataset.patchIndex = String(index);
              dom.dataset.patchState = kind === "replace" ? "replace" : "insert";
              return dom;
            },
            {
              ...spec,
              // key 含已打字长度:流式打字时随字数增长自然重建更新,切换 activePatchId 时
              // 字数不变则复用不重挂(只 current/accepted 变化的重建)。
              key: `pins-${source.id}-${index}-${insertedText.length}-${currentClass}-${statusClass}`,
              side: 1,
              ignoreSelection: true,
            },
          ),
        );
      }
      if (args.revealCursors?.has(source.id)) {
        // revealCursors 的 value = 并发通道号 lane。经 label 传入,
        // createNativeCursorWidget 据此打 data-hc-lane 锚点,供 HumanCursorOverlay
        // 自发现并画出"小赵/小钱"名字(迁移自旧 RevealCursor,不可丢 lane 否则光标无名)。
        const lane = args.revealCursors.get(source.id)!;
        decorations.push(
          Decoration.widget(
            insertAt,
            () => createNativeCursorWidget({ tone: "blue", label: `Agent·${lane}` }),
            {
              ...spec,
              key: `pcur-${source.id}-${lane}`,
              side: 2,
              ignoreSelection: true,
            },
          ),
        );
      }
    }
  }

  // 同一 patchId 若另有 insert/replace 输入,则其 delete 输入是"替换的旧半"(多块 replace 会拆成
   // delete+insert 两条),不画块级红删标记——替换一律"显新块 + hover 原文"。只有真正孤立的纯删除才画。
  const patchIdsWithInsert = new Set(
    (args.blockPatches ?? [])
      .filter((p) => p.op === "insert" || p.op === "replace")
      .map((p) => p.patchId),
  );

  for (const [inputIndex, input] of (args.blockPatches ?? []).entries()) {
    if (rejectedIds.has(input.patchId)) continue;
    if (!isPatchRevealed(input.patchId, args.revealedPatchIds)) continue;
    const applied = appliedById.get(input.patchId);
    const index = applied?.index ?? input.order ?? 0;
    const status = acceptedIds.has(input.patchId) ? "accepted" : "reviewing";
    const currentClass = (args.activeReviewTargetId ?? args.activePatchId) === input.patchId ? " is-current" : "";
    const statusClass = status === "accepted" ? " is-accepted" : "";
    const spec = patchSpec(input.patchId, index, status, input.op);
    const range = resolveBlockPatchRange(input, blockRanges);
    if (!range) {
      dropped.push(input.patchId);
      continue;
    }

    // granular diff 的替换(列表行/表格格与行/callout 和分栏内部块):正文已在容器内部标注增删,
    // insert widget 加 is-granular 去掉整块绿竖线(否则"既有行级又有块级"重复)。
    const granular = input.op === "replace" && input.granular === true;

    if (input.op === "delete" || input.op === "replace") {
      const count = Math.max(1, input.blockCount ?? input.replaceBeforeBlocks?.length ?? input.blocks.length);
      const toRange = blockRanges[range.index + count - 1];
      if (!toRange) {
        dropped.push(input.patchId);
        continue;
      }
      // 隐藏被替换/删除的旧块(delete/replace 都隐藏原位;replace 的原文经 hover 卡看)。
      decorations.push(
        Decoration.node(
          range.from,
          toRange.to,
          {
            class: `wf-blockmark delete${currentClass}${statusClass}`,
            "data-patch-id": input.patchId,
            "data-patch-index": String(index),
            "data-patch-state": "delete",
          },
          spec,
        ),
      );
      // 块级红删标记(红竖线+球):**只在真正孤立的纯删除时画**。替换走"显示新块 + hover 看原文",
      // 不再另出红删标记——含多块 replace 拆成的 delete 半(其 patchId 另有 insert)也不画,口径统一。
      if (input.op === "delete" && !patchIdsWithInsert.has(input.patchId)) {
        decorations.push(
          Decoration.widget(
            range.from,
            () => renderBlockDeleteMarkerDOM(input.patchId, index, currentClass, statusClass),
            {
              ...spec,
              key: `bdel-${input.patchId}-${index}-${currentClass}-${statusClass}`,
              side: -1,
              ignoreSelection: true,
            },
          ),
        );
      }
    }

    if (input.op === "insert" || input.op === "replace") {
      if (input.blocks.length === 0) {
        dropped.push(input.patchId);
        continue;
      }
      const granularClass = granular
        ? ` is-granular${input.granularBlockHover ? " has-block-original-hover" : ""}`
        : "";
      const activeTargetKey = granular ? args.activeReviewTargetId ?? "" : currentClass;
      const tableTypedKey = reviewTableCellTypedCountsKey(args.tableTypedByPatch?.get(input.patchId));
      decorations.push(
        Decoration.widget(
          input.op === "insert" ? range.boundary : range.to,
          () => renderBlockInsertDOM(
            input,
            index,
            currentClass + granularClass,
            statusClass,
            args.mountBlockView,
            args.reviewTargets?.filter((target) => target.patchId === input.patchId),
            args.activeReviewTargetId,
            inputIndex,
            args.tableTypedByPatch?.get(input.patchId),
          ),
          {
            ...spec,
            key: `bins-${input.patchId}-${index}-${activeTargetKey}${granularClass}-${statusClass}-${tableTypedKey}`,
            side: 1,
            ignoreSelection: true,
            destroy: unmountBlockView,
          },
        ),
      );
    }
  }

  return { decorations, dropped };
}

function reviewTableCellTypedCountsKey(values: ReviewTableCellTypedCounts | undefined): string {
  if (!values) return "final";
  return Array.from(values)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}:${value}`)
    .join(",");
}

export function renderInsertDOM(
  text: string,
  marks?: readonly PmMark[],
  state: "insert" | "replace" = "insert",
): HTMLElement {
  const outer = document.createElement("span");
  outer.className = state === "replace" ? "wf-patch-replace-wrap" : "wf-patch-ins-wrap";
  outer.dataset.patchState = state;
  const inner = document.createElement("span");
  inner.className = "wf-patch-ins";
  inner.appendChild(renderMarkedTextDom(text, marks));
  outer.appendChild(inner);
  return outer;
}

function renderDeleteMarkerDOM(
  patchId: string,
  index: number,
  currentClass: string,
  statusClass: string,
): HTMLElement {
  const outer = document.createElement("span");
  outer.className = `wf-patch-del-marker${currentClass}${statusClass}`;
  outer.dataset.patchId = patchId;
  outer.dataset.patchIndex = String(index);
  outer.dataset.patchState = "delete";
  const cursor = document.createElement("span");
  cursor.className = "patch-del-cursor";
  outer.appendChild(cursor);
  return outer;
}

function renderBlockDeleteMarkerDOM(
  patchId: string,
  index: number,
  currentClass: string,
  statusClass: string,
): HTMLElement {
  const outer = document.createElement("span");
  outer.className = `wf-blockmark-del${currentClass}${statusClass}`;
  outer.dataset.patchId = patchId;
  outer.dataset.patchIndex = String(index);
  outer.dataset.patchState = "delete";
  const line = document.createElement("span");
  line.className = "wf-blockmark-del-line";
  line.setAttribute("aria-hidden", "true");
  outer.appendChild(line);
  return outer;
}

function renderBlockInsertDOM(
  input: BlockPatchInput,
  index: number,
  currentClass: string,
  statusClass: string,
  mountBlockView?: MountBlockView,
  reviewTargets?: readonly ReviewTarget[],
  activeTargetId?: string | null,
  inputIndex = 0,
  tableTypedCounts?: ReviewTableCellTypedCounts,
): HTMLElement {
  const outer = document.createElement("div");
  outer.className = `wf-blockmark insert${currentClass}${statusClass}`;
  outer.dataset.patchId = input.patchId;
  outer.dataset.patchIndex = String(index);
  outer.dataset.patchState = input.op === "replace" ? "replace" : "insert";
  outer.style.display = "block";
  const inner = document.createElement("div");
  inner.className = "wf-patch-ins";
  outer.appendChild(inner);
  if (mountBlockView) {
    // 用与基座正文相同的 PmBlockView 渲染:图表/公式/callout 等运行时节点所见即所得。
    (outer as unknown as { __pmRoot?: Root }).__pmRoot = mountBlockView(
      inner,
      input.blocks,
      input.pmNodes,
      input.beforePmNodes,
      index,
      input.granularBlockHover === true,
      reviewTargets,
      activeTargetId,
      inputIndex,
      tableTypedCounts,
    );
  } else {
    // 降级(node 单元测试等无 React 注入时):静态 HTML,图表/公式退化但结构完整。
    inner.innerHTML = viewSectionsToHtml(input.blocks);
  }
  return outer;
}

/** widget 卸载时 unmount React root。延后一拍避免在 ProseMirror update 同步栈里 unmount 的告警。 */
function unmountBlockView(node: Node): void {
  const root = (node as unknown as { __pmRoot?: Root }).__pmRoot;
  if (root) queueMicrotask(() => root.unmount());
}

function sanitizePatchDecorations(
  editor: Editor,
  decorations: Decoration[],
): Decoration[] {
  const size = editor.state.doc.content.size;
  const bounded = decorations.filter((decoration) => {
    const from = decoration.from;
    const to = decoration.to;
    return (
      Number.isInteger(from) &&
      Number.isInteger(to) &&
      from >= 0 &&
      to >= from &&
      from <= size &&
      to <= size
    );
  });
  try {
    DecorationSet.create(editor.state.doc, bounded.slice());
    return bounded;
  } catch (error) {
    console.warn("[patch] decoration set 创建失败，已逐条过滤坏 decoration", error);
    return bounded.filter((decoration) => canCreateDecorationSet(editor.state.doc, [decoration]));
  }
}

function createBestEffortDecorationSet(
  doc: ProseMirrorNode,
  decorations: Decoration[],
): DecorationSet {
  const safe = decorations.filter((decoration) => canCreateDecorationSet(doc, [decoration]));
  if (safe.length === 0) return DecorationSet.empty;
  try {
    return DecorationSet.create(doc, safe.slice());
  } catch {
    return DecorationSet.empty;
  }
}

function canCreateDecorationSet(
  doc: ProseMirrorNode,
  decorations: Decoration[],
): boolean {
  try {
    DecorationSet.create(doc, decorations.slice());
    return true;
  } catch {
    return false;
  }
}

function collectSources(args: BuildPatchDecorationsArgs): PatchDecorationSource[] {
  const sources: PatchDecorationSource[] = [];
  const seen = new Set<string>();
  // 已走块级 patch(表格/图表/列表等结构块)的 id:这些 suggestion 的 preview.insertText 是把整块
  // 拍平成的纯文本,绝不能再当 inline 文本 source 渲染,否则会在结构块之外重复上屏一行绿字源码。
  const blockPatchIds = new Set((args.blockPatches ?? []).map((input) => input.patchId));
  for (const suggestion of args.suggestions ?? []) {
    if (seen.has(suggestion.id) || blockPatchIds.has(suggestion.id)) continue;
    seen.add(suggestion.id);
    sources.push({
      id: suggestion.id,
      before: suggestion.preview.deleteText,
      after: suggestion.preview.insertText,
      kind: suggestionKind(suggestion),
      pmFrom: suggestion.anchor.pmFrom,
      pmTo: suggestion.anchor.pmTo,
      ...(suggestion.diffHunk?.marks ? { marks: suggestion.diffHunk.marks } : {}),
    });
  }

  const blockRanges = lazyTopLevelTextRanges(args.baselineDoc);
  for (const overlay of args.overlayInputs ?? []) {
    if (seen.has(overlay.id) || blockPatchIds.has(overlay.id)) continue;
    seen.add(overlay.id);
    const range = resolveOverlayPmRange(overlay, blockRanges);
    sources.push({
      id: overlay.id,
      before: overlay.before,
      after: overlay.after,
      kind: overlay.kind,
      marks: overlay.marks,
      label: overlay.label,
      pmFrom: range?.from,
      pmTo: range?.to,
    });
  }
  return sources;
}

function suggestionKind(suggestion: DocSuggestion): AppliedPatch["kind"] | undefined {
  const op = suggestion.diffHunk?.op;
  if (op === "markAdd" || op === "markRemove") return op;
  const stepType = suggestion.patch.steps[0]?.stepType;
  if (stepType === "addMark") return "markAdd";
  if (stepType === "removeMark") return "markRemove";
  return undefined;
}

function resolvePatchDecorationKind(
  kind: AppliedPatch["kind"] | undefined,
  before: string,
  after: string,
): PatchDecorationKind | null {
  if (kind === "markAdd" || kind === "markRemove") return kind;
  if (kind === "insert" || (!before && after)) return "insert";
  if (kind === "delete" || (before && !after)) return "delete";
  if (kind === "replace" || kind === "text" || (before && after)) return "replace";
  return null;
}

function patchSpec(
  id: string,
  index: number,
  patchStatus: PatchDecorationSpec["patchStatus"],
  patchKind: PatchDecorationKind,
): PatchDecorationSpec {
  return {
    "data-patch-id": id,
    "data-patch-index": index,
    patchStatus,
    patchKind,
  };
}

function markDecorationStyle(
  kind: "markAdd" | "markRemove",
  isActive: boolean,
  marks?: readonly PmMark[],
): { style: string } {
  const styles: string[] =
    kind === "markAdd"
      ? [
          `background:linear-gradient(to bottom, transparent 46%, rgba(74, 180, 100, ${isActive ? "0.42" : "0.28"}) 46%)`,
          "box-shadow:inset 0 -1px rgba(74, 180, 100, 0.34)",
        ]
      : [
          "background:linear-gradient(to bottom, transparent 46%, rgba(87, 121, 155, 0.22) 46%)",
          "box-shadow:inset 0 -1px rgba(87, 121, 155, 0.34)",
          "text-decoration:line-through",
          "text-decoration-color:rgba(87, 121, 155, 0.65)",
        ];
  // 所见即所得:markAdd 让被标记的字真实呈现「将获得的格式」(加粗/斜体/下划线/行内代码),
  // 而不只是标个绿色底纹。markRemove 保留删除线不叠加格式。
  if (kind === "markAdd" && marks) {
    for (const mark of marks) {
      if (mark.type === "bold") styles.push("font-weight:700");
      else if (mark.type === "italic") styles.push("font-style:italic");
      else if (mark.type === "underline") styles.push("text-decoration:underline");
      else if (mark.type === "strike") styles.push("text-decoration:line-through");
      else if (mark.type === "code") styles.push("font-family:var(--font-mono)");
      else if (mark.type === "link") styles.push("text-decoration:underline");
      // textColor/highlight 的 attrs.color 是主题 key(如 "yellow"),需经主题表解析成真 css 色,
      // 直接用会失真(命中的只是 CSS 命名色)。命中表才加,未知 key 退回只留绿底纹。
      else if (mark.type === "textColor") {
        const c = TOOLBAR_TEXT_COLORS[mark.attrs.color as keyof typeof TOOLBAR_TEXT_COLORS];
        if (c) styles.push(`color:${c}`);
      } else if (mark.type === "highlight") {
        const c = TOOLBAR_HIGHLIGHT_COLORS[mark.attrs.color as keyof typeof TOOLBAR_HIGHLIGHT_COLORS];
        if (c) styles.push(`background-color:${c}`);
      }
    }
  }
  return { style: styles.join(";") };
}

function validAnchor(
  from: number | undefined,
  to: number | undefined,
  docSize: number,
): boolean {
  return (
    Number.isInteger(from) &&
    Number.isInteger(to) &&
    from! >= 0 &&
    to! >= from! &&
    from! <= docSize &&
    to! <= docSize
  );
}

function toReadonlySet(
  ids: ReadonlySet<string> | readonly string[] | undefined,
): ReadonlySet<string> {
  if (!ids) return new Set();
  return ids instanceof Set ? ids : new Set(ids);
}

function isPatchRevealed(
  id: string,
  revealedPatchIds: ReadonlySet<string> | null | undefined,
): boolean {
  return revealedPatchIds == null || revealedPatchIds.has(id);
}

function revealedInsertedText(
  id: string,
  text: string,
  typedByPatch: ReadonlyMap<string, number> | null | undefined,
): string {
  const typed = typedByPatch?.get(id);
  if (typed == null) return text;
  const count = Math.max(0, Math.floor(typed));
  if (count === 0) return "";
  return splitGraphemes(text).slice(0, count).join("");
}

function renderMarkedTextDom(text: string, marks?: readonly PmMark[]): Node {
  if (!marks || marks.length === 0) return document.createTextNode(text);
  let node: Node = document.createTextNode(text);
  for (const mark of marks) {
    switch (mark.type) {
      case "bold":
        node = wrapNode("strong", node);
        break;
      case "italic":
        node = wrapNode("em", node);
        break;
      case "underline":
        node = wrapNode("u", node);
        break;
      case "strike":
        node = wrapNode("s", node);
        break;
      case "code": {
        const el = wrapNode("code", node);
        (el as HTMLElement).className = "inline-code";
        node = el;
        break;
      }
      case "highlight": {
        const el = wrapNode("mark", node);
        (el as HTMLElement).dataset.color = mark.attrs.color;
        node = el;
        break;
      }
      case "link": {
        const el = wrapNode("a", node) as HTMLAnchorElement;
        el.href = mark.attrs.href;
        if (mark.attrs.title) el.title = mark.attrs.title;
        el.target = "_blank";
        el.rel = "noopener noreferrer";
        node = el;
        break;
      }
      case "textColor": {
        const el = wrapNode("span", node);
        (el as HTMLElement).dataset.textColor = mark.attrs.color;
        node = el;
        break;
      }
    }
  }
  return node;
}

function wrapNode(tagName: string, child: Node): HTMLElement {
  const el = document.createElement(tagName);
  el.appendChild(child);
  return el;
}

function resolveOverlayPmRange(
  overlay: PatchOverlayInput,
  blockRanges: readonly { index: number; from: number; to: number }[],
): { from: number; to: number } | null {
  if (!overlay.range) return null;
  const block = blockRanges.find((range) => range.index === overlay.blockIndex);
  if (!block) return null;
  return {
    from: block.from + overlay.range.start,
    to: block.from + overlay.range.end,
  };
}

function resolveBlockPatchRange(
  input: BlockPatchInput,
  blockRanges: readonly { index: number; blockId: string | null; from: number; to: number }[],
): { index: number; from: number; to: number; boundary: number } | null {
  const blockIdRange = input.anchorBlockId
    ? blockRanges.find((range) => range.blockId === input.anchorBlockId)
    : undefined;
  const indexRange = blockIdRange
    ? undefined
    : validBlockIndex(input.anchorIndex)
      ? blockRanges[input.anchorIndex]
      : undefined;
  const range = blockIdRange ?? indexRange;
  if (!range) {
    if (!input.anchorBlockId && !validBlockIndex(input.anchorIndex) && input.op === "insert") {
      const end = blockRanges[blockRanges.length - 1]?.to ?? 0;
      return { index: blockRanges.length, from: end, to: end, boundary: end };
    }
    return null;
  }
  const boundary = input.op === "insert" && input.gravity === "before" ? range.from : range.to;
  return { ...range, boundary };
}

function topLevelBlockRanges(doc: PmDoc): { index: number; blockId: string | null; from: number; to: number }[] {
  const ranges: { index: number; blockId: string | null; from: number; to: number }[] = [];
  let pos = 0;
  doc.content.forEach((block, index) => {
    const size = pmNodeSize(block);
    ranges.push({
      index,
      blockId: readBlockId(block),
      from: pos,
      to: pos + size,
    });
    pos += size;
  });
  return ranges;
}

function lazyTopLevelTextRanges(doc: PmDoc): { index: number; from: number; to: number }[] {
  const ranges: { index: number; from: number; to: number }[] = [];
  let pos = 0;
  doc.content.forEach((block, index) => {
    const content = "content" in block && Array.isArray(block.content) ? block.content : [];
    const contentSize = pmContentSize(content);
    ranges.push({ index, from: pos + 1, to: pos + 1 + contentSize });
    pos += pmNodeSize(block);
  });
  return ranges;
}

function readBlockId(node: PmNode): string | null {
  const attrs = "attrs" in node ? node.attrs : undefined;
  const blockId = attrs && typeof attrs === "object" ? (attrs as { blockId?: unknown }).blockId : undefined;
  return typeof blockId === "string" && blockId.length > 0 ? blockId : null;
}

function validBlockIndex(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function pmDocContentSize(doc: PmDoc): number {
  return pmContentSize(doc.content);
}

function pmContentSize(content: readonly PmNode[] | undefined): number {
  if (!content) return 0;
  return content.reduce((sum, node) => sum + pmNodeSize(node), 0);
}

function pmNodeSize(node: PmNode): number {
  if (node.type === "text") return node.text.length;
  const content = "content" in node ? node.content : undefined;
  if (Array.isArray(content)) return pmContentSize(content) + 2;
  return 1;
}
