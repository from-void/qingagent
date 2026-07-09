import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type { DocSuggestion } from "./protocol";
import type { AppliedPatch, PatchOverlayInput } from "./protocol";
import type { PmDoc, PmMark, PmNode } from "@qingagent/pm-schema";

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
  applied: readonly AppliedPatch[];
  baselineDoc: PmDoc;
  acceptedIds?: ReadonlySet<string> | readonly string[];
  rejectedIds?: ReadonlySet<string> | readonly string[];
  activePatchId?: string | null;
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
              return DecorationSet.create(tr.doc, meta.decorations);
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

  for (const source of collectSources(args)) {
    const applied = appliedById.get(source.id);
    const before = applied?.before ?? source.before;
    const after = applied?.after ?? source.after;
    const kind = resolvePatchDecorationKind(applied?.kind ?? source.kind, before, after);
    if (!kind) continue;

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
      decorations.push(
        Decoration.inline(
          from!,
          to!,
          {
            class: `wf-patch-mark ${kind === "markAdd" ? "add" : "remove"}${currentClass}${statusClass}`,
            "data-patch-id": source.id,
            "data-patch-index": String(index),
            ...markDecorationStyle(kind, args.activePatchId === source.id),
          },
          spec,
        ),
      );
      continue;
    }

    if (kind === "delete" || kind === "replace") {
      decorations.push(
        Decoration.inline(
          from!,
          to!,
          {
            class: `wf-patch-del${currentClass}${statusClass}`,
            "data-patch-id": source.id,
            "data-patch-index": String(index),
          },
          spec,
        ),
      );
    }

    if (kind === "insert" || kind === "replace") {
      const insertedText = after;
      if (insertedText.length === 0) continue;
      decorations.push(
        Decoration.widget(
          from!,
          () => {
            const dom = renderInsertDOM(insertedText, applied?.marks ?? source.marks);
            dom.className = `${dom.className}${currentClass}${statusClass}`;
            dom.dataset.patchId = source.id;
            dom.dataset.patchIndex = String(index);
            dom.dataset.patchState = kind === "replace" ? "replace" : "insert";
            return dom;
          },
          {
            ...spec,
            side: 1,
            ignoreSelection: true,
          },
        ),
      );
    }
  }

  return { decorations, dropped };
}

export function renderInsertDOM(text: string, marks?: readonly PmMark[]): HTMLElement {
  const outer = document.createElement("span");
  outer.className = "wf-patch-ins";
  outer.appendChild(renderMarkedTextDom(text, marks));
  return outer;
}

function collectSources(args: BuildPatchDecorationsArgs): PatchDecorationSource[] {
  const sources: PatchDecorationSource[] = [];
  const seen = new Set<string>();
  for (const suggestion of args.suggestions ?? []) {
    if (seen.has(suggestion.id)) continue;
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
    if (seen.has(overlay.id)) continue;
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
): { style: string } {
  if (kind === "markAdd") {
    return {
      style: [
        `background:linear-gradient(to bottom, transparent 46%, rgba(232, 145, 58, ${isActive ? "0.42" : "0.28"}) 46%)`,
        "box-shadow:inset 0 -1px rgba(232, 145, 58, 0.34)",
      ].join(";"),
    };
  }
  return {
    style: [
      "background:linear-gradient(to bottom, transparent 46%, rgba(87, 121, 155, 0.22) 46%)",
      "box-shadow:inset 0 -1px rgba(87, 121, 155, 0.34)",
      "text-decoration:line-through",
      "text-decoration-color:rgba(87, 121, 155, 0.65)",
    ].join(";"),
  };
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
