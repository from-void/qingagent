import { Extension } from "@tiptap/core";
import type { Editor } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type { NativeConcurrentStep } from "./nativeDiffAnimation";
import { laneFromAgentLabel, laneName } from "./humanCursorLanes";
import { splitGraphemes } from "./presentationSpans";

export interface NativeEditorOperationRuntime {
  offsets: Map<number, number>;
  operationOffsets: Map<string, number>;
  // 本帧新插入字符的范围,用于挂"字符入场"淡入动画(丝滑打字,每帧清空)。
  charEnters: { from: number; to: number }[];
}

export interface NativeCursorMarker {
  pos: number;
  tone: "blue" | "red";
  label: string;
  color?: string;
  dotOnly?: boolean;
}

export interface NativeTextBlockRange {
  from: number;
  to: number;
  text: string;
}

type NativePresentationDecorationMeta =
  | { kind: "set"; decorations: Decoration[] }
  | { kind: "clear" };

type GraphemeFrameCache = Map<string, string[]>;

export const nativePresentationDecorationKey = new PluginKey<DecorationSet>(
  "nativePresentationDecorations",
);

export const NativePresentationDecorations = Extension.create({
  name: "nativePresentationDecorations",
  addProseMirrorPlugins() {
    return [
      new Plugin<DecorationSet>({
        key: nativePresentationDecorationKey,
        state: {
          init: () => DecorationSet.empty,
          apply(tr, value) {
            const meta = tr.getMeta(nativePresentationDecorationKey) as
              | NativePresentationDecorationMeta
              | undefined;
            if (meta?.kind === "set") {
              return DecorationSet.create(tr.doc, meta.decorations);
            }
            if (meta?.kind === "clear") return DecorationSet.empty;
            return value.map(tr.mapping, tr.doc);
          },
        },
        props: {
          decorations(state) {
            return nativePresentationDecorationKey.getState(state);
          },
        },
      }),
    ];
  },
});

export function applyNativeConcurrentFrame(
  editor: Editor,
  steps: readonly NativeConcurrentStep[],
  runtime: NativeEditorOperationRuntime,
): NativeCursorMarker[] {
  const markers: NativeCursorMarker[] = [];
  if (editor.isDestroyed) return markers;

  const graphemeCache: GraphemeFrameCache = new Map();
  let chain = editor.chain();
  for (const step of steps) {
    chain = chain.command(({ tr, commands }) => {
      if (editor.isDestroyed) return false;
      const marker = applyNativeConcurrentStepInChain(
        tr.doc,
        commands,
        step,
        runtime,
        graphemeCache,
      );
      if (marker) markers.push(marker);
      return true;
    });
  }

  chain = chain.command(({ tr }) => {
    const decorations = buildNativePresentationDecorations(
      tr.doc,
      markers,
      runtime.charEnters,
    );
    tr.setMeta(nativePresentationDecorationKey, {
      kind: decorations.length > 0 ? "set" : "clear",
      decorations,
    } satisfies NativePresentationDecorationMeta);
    return true;
  });

  chain.run();
  return markers;
}

export function applyNativeConcurrentSteps(
  editor: Editor,
  steps: readonly NativeConcurrentStep[],
  runtime: NativeEditorOperationRuntime,
): NativeCursorMarker[] {
  const markers: NativeCursorMarker[] = [];
  for (const step of steps) {
    if (editor.isDestroyed) return markers;
    const marker = applyNativeConcurrentStep(editor, step, runtime);
    if (marker) markers.push(marker);
  }
  return markers;
}

export function applyNativeConcurrentStep(
  editor: Editor,
  step: NativeConcurrentStep,
  runtime: NativeEditorOperationRuntime,
): NativeCursorMarker | null {
  if (step.kind === "cursor") {
    const at = step.at + (runtime.offsets.get(step.blockIndex) ?? 0);
    const range = resolveTextBlockRange(editor, step.blockIndex, at, at);
    if (!range) throw new Error("native presentation cursor range unavailable");
    editor.commands.setTextSelection(range.from);
    return {
      pos: range.from,
      tone: step.tone,
      label: step.label,
      color: step.color,
    };
  }

  if (step.kind === "redDot") {
    const at = step.at + (runtime.offsets.get(step.blockIndex) ?? 0);
    const range = resolveTextBlockRange(editor, step.blockIndex, at, at);
    if (!range) throw new Error("native presentation red dot range unavailable");
    return {
      pos: range.from,
      tone: "red",
      label: "",
      color: step.color,
      dotOnly: true,
    };
  }

  const baseOffset = nativeEditorOperationBaseOffset(step, runtime);
  if (step.kind === "deleteText") {
    const range = resolveTextBlockRange(
      editor,
      step.blockIndex,
      step.chunkFrom + baseOffset,
      step.chunkTo + baseOffset,
    );
    if (!range) throw new Error("native presentation delete range unavailable");
    editor.commands.setTextSelection(range.to);
    editor.commands.deleteRange({ from: range.from, to: range.to });
    if (step.operationComplete) {
      runtime.offsets.set(step.blockIndex, baseOffset - step.operationLength);
      runtime.operationOffsets.delete(step.operationKey);
    }
    return {
      pos: range.from,
      tone: "red",
      label: step.label,
      color: step.color,
    };
  }

  const range = resolveTextBlockRange(
    editor,
    step.blockIndex,
    step.at + step.chunkFrom + baseOffset,
    step.at + step.chunkFrom + baseOffset,
  );
  if (!range) throw new Error("native presentation insert range unavailable");
  editor.commands.setTextSelection(range.from);
  editor.commands.insertContentAt(range.from, step.text);
  runtime.charEnters.push({ from: range.from, to: range.from + step.text.length });
  if (step.operationComplete) {
    runtime.offsets.set(step.blockIndex, baseOffset + step.operationLength);
    runtime.operationOffsets.delete(step.operationKey);
  }
  return {
    pos: range.from + step.text.length,
    tone: "blue",
    label: step.label,
    color: step.color,
  };
}

export function setNativePresentationDecorations(
  editor: Editor,
  markers: ReadonlyArray<NativeCursorMarker>,
  charEnters: ReadonlyArray<{ from: number; to: number }> = [],
): void {
  if (editor.isDestroyed) return;
  const decorations = buildNativePresentationDecorations(
    editor.state.doc,
    markers,
    charEnters,
  );
  const tr = editor.state.tr.setMeta(nativePresentationDecorationKey, {
    kind: decorations.length > 0 ? "set" : "clear",
    decorations,
  } satisfies NativePresentationDecorationMeta);
  editor.view.dispatch(tr);
}

export function buildNativePresentationDecorations(
  doc: ProseMirrorNode,
  markers: ReadonlyArray<NativeCursorMarker>,
  charEnters: ReadonlyArray<{ from: number; to: number }> = [],
): Decoration[] {
  const size = doc.content.size;
  const decorations = markers.map((marker) =>
    Decoration.widget(
      clamp(marker.pos, 0, size),
      () => createNativeCursorWidget(marker),
      {
        side: 1,
        ignoreSelection: true,
      },
    ),
  );
  // 给本帧新插入字符挂淡入动画 class(柔和浮现,缓解步进跳跃感)。
  for (const range of charEnters) {
    const from = clamp(range.from, 0, size);
    const to = clamp(range.to, 0, size);
    if (to > from) {
      decorations.push(Decoration.inline(from, to, { class: "native-char-enter" }));
    }
  }
  return decorations;
}

export function createNativeCursorWidget(marker: {
  tone: "blue" | "red";
  label: string;
  color?: string;
  dotOnly?: boolean;
}): HTMLElement {
  const el = document.createElement("span");
  el.className = [
    "ai-cursor",
    "native-presentation-cursor",
    marker.tone === "red" ? "red" : "",
    marker.dotOnly ? "native-presentation-red-dot" : "",
  ]
    .filter(Boolean)
    .join(" ");
  if (marker.color && marker.tone !== "red") {
    el.style.setProperty("--native-cursor-color", marker.color);
  }
  el.setAttribute("aria-hidden", "true");
  // 名字标识改由拟人鼠标 overlay 承载:不再渲染竖条头顶的 Agent·N 文字,
  // 改为打上 data-hc-* 作为鼠标的定位锚点 + 同色同名来源(全文生成场景)。
  if (marker.label && !marker.dotOnly) {
    const lane = laneFromAgentLabel(marker.label);
    if (lane != null) {
      el.setAttribute("data-hc-lane", String(lane));
      // 名字统一走 lane→百家姓映射(小赵/小钱/小孙/小李…),
      // 不能直出原始 label(agent1/agent2),否则会盖掉 overlay 的百家姓名。
      el.setAttribute("data-hc-name", laneName(lane));
      if (marker.color) el.setAttribute("data-hc-color", marker.color);
    }
  }
  return el;
}

export function resolveTextBlockRange(
  editor: Editor,
  blockIndex: number,
  fromGrapheme: number,
  toGrapheme: number,
): NativeTextBlockRange | null {
  return resolveTextBlockRangeInDoc(
    editor.state.doc,
    blockIndex,
    fromGrapheme,
    toGrapheme,
  );
}

export function resolveTextBlockRangeInDoc(
  doc: ProseMirrorNode,
  blockIndex: number,
  fromGrapheme: number,
  toGrapheme: number,
  graphemeCache?: GraphemeFrameCache,
): NativeTextBlockRange | null {
  let targetStart = -1;
  let targetText = "";

  doc.forEach((node, offset, index) => {
    if (index !== blockIndex || !node.isTextblock) return;
    targetStart = offset + 1;
    targetText = node.textContent;
  });

  if (targetStart < 0) return null;
  const fromOffset = graphemeIndexToCodeUnitOffset(
    targetText,
    fromGrapheme,
    graphemeCache,
  );
  const toOffset = graphemeIndexToCodeUnitOffset(
    targetText,
    toGrapheme,
    graphemeCache,
  );
  const from = clamp(targetStart + fromOffset, targetStart, targetStart + targetText.length);
  const to = clamp(targetStart + toOffset, from, targetStart + targetText.length);
  return { from, to, text: targetText };
}

function applyNativeConcurrentStepInChain(
  doc: ProseMirrorNode,
  commands: {
    setTextSelection: (position: number | { from: number; to: number }) => boolean;
    insertContentAt: (position: number | { from: number; to: number }, value: string) => boolean;
    deleteRange: (range: { from: number; to: number }) => boolean;
  },
  step: NativeConcurrentStep,
  runtime: NativeEditorOperationRuntime,
  graphemeCache: GraphemeFrameCache,
): NativeCursorMarker | null {
  if (step.kind === "cursor") {
    const at = step.at + (runtime.offsets.get(step.blockIndex) ?? 0);
    const range = resolveTextBlockRangeInDoc(
      doc,
      step.blockIndex,
      at,
      at,
      graphemeCache,
    );
    if (!range) throw new Error("native presentation cursor range unavailable");
    commands.setTextSelection(range.from);
    return {
      pos: range.from,
      tone: step.tone,
      label: step.label,
      color: step.color,
    };
  }

  if (step.kind === "redDot") {
    const at = step.at + (runtime.offsets.get(step.blockIndex) ?? 0);
    const range = resolveTextBlockRangeInDoc(
      doc,
      step.blockIndex,
      at,
      at,
      graphemeCache,
    );
    if (!range) throw new Error("native presentation red dot range unavailable");
    return {
      pos: range.from,
      tone: "red",
      label: "",
      color: step.color,
      dotOnly: true,
    };
  }

  const baseOffset = nativeEditorOperationBaseOffset(step, runtime);
  if (step.kind === "deleteText") {
    const range = resolveTextBlockRangeInDoc(
      doc,
      step.blockIndex,
      step.chunkFrom + baseOffset,
      step.chunkTo + baseOffset,
      graphemeCache,
    );
    if (!range) throw new Error("native presentation delete range unavailable");
    commands.setTextSelection(range.to);
    commands.deleteRange({ from: range.from, to: range.to });
    if (step.operationComplete) {
      runtime.offsets.set(step.blockIndex, baseOffset - step.operationLength);
      runtime.operationOffsets.delete(step.operationKey);
    }
    return {
      pos: range.from,
      tone: "red",
      label: step.label,
      color: step.color,
    };
  }

  const range = resolveTextBlockRangeInDoc(
    doc,
    step.blockIndex,
    step.at + step.chunkFrom + baseOffset,
    step.at + step.chunkFrom + baseOffset,
    graphemeCache,
  );
  if (!range) throw new Error("native presentation insert range unavailable");
  commands.setTextSelection(range.from);
  commands.insertContentAt(range.from, step.text);
  runtime.charEnters.push({ from: range.from, to: range.from + step.text.length });
  if (step.operationComplete) {
    runtime.offsets.set(step.blockIndex, baseOffset + step.operationLength);
    runtime.operationOffsets.delete(step.operationKey);
  }
  return {
    pos: range.from + step.text.length,
    tone: "blue",
    label: step.label,
    color: step.color,
  };
}

function nativeEditorOperationBaseOffset(
  step: NativeConcurrentStep,
  runtime: NativeEditorOperationRuntime,
): number {
  const existing = runtime.operationOffsets.get(step.operationKey);
  if (existing != null) return existing;
  const offset = runtime.offsets.get(step.blockIndex) ?? 0;
  runtime.operationOffsets.set(step.operationKey, offset);
  return offset;
}

function graphemeIndexToCodeUnitOffset(
  text: string,
  index: number,
  graphemeCache?: GraphemeFrameCache,
): number {
  if (index <= 0) return 0;
  const graphemes = graphemesForText(text, graphemeCache);
  return graphemes.slice(0, Math.min(index, graphemes.length)).join("").length;
}

function graphemesForText(text: string, graphemeCache?: GraphemeFrameCache): string[] {
  if (!graphemeCache) return splitGraphemes(text);
  const cached = graphemeCache.get(text);
  if (cached) return cached;
  const graphemes = splitGraphemes(text);
  graphemeCache.set(text, graphemes);
  return graphemes;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
