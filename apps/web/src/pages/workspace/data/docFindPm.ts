import { Extension } from "@tiptap/core";
import type { Editor } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type { FindMatch, FindSegment } from "./docFindModel";

type DocFindDecorationMeta =
  | { kind: "set"; decorations: Decoration[] }
  | { kind: "clear" };

export const docFindDecorationKey = new PluginKey<DecorationSet>(
  "docFindDecorations",
);

export const DocFindDecorations = Extension.create({
  name: "docFindDecorations",
  addProseMirrorPlugins() {
    return [
      new Plugin<DecorationSet>({
        key: docFindDecorationKey,
        state: {
          init: () => DecorationSet.empty,
          apply(tr, value) {
            const meta = tr.getMeta(docFindDecorationKey) as
              | DocFindDecorationMeta
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
            return docFindDecorationKey.getState(state);
          },
        },
      }),
    ];
  },
});

export function collectDocFindSegments(doc: ProseMirrorNode): FindSegment[] {
  const segments: FindSegment[] = [];
  doc.descendants((node, pos) => {
    if (node.isText && node.text) {
      segments.push({ text: node.text, pos });
    }
  });
  return segments;
}

export function buildFindDecorations(
  matches: readonly FindMatch[],
  currentIndex: number,
): Decoration[] {
  return matches.map((match, index) =>
    Decoration.inline(match.from, match.to, {
      class: `ws-find-hit${index === currentIndex ? " is-current" : ""}`,
    }),
  );
}

export function setFindDecorations(
  editor: Editor | null,
  matches: readonly FindMatch[],
  currentIndex: number,
): void {
  if (!editor || editor.isDestroyed) return;
  const decorations = buildFindDecorations(matches, currentIndex);
  const tr = editor.state.tr.setMeta(docFindDecorationKey, {
    kind: decorations.length > 0 ? "set" : "clear",
    decorations,
  } satisfies DocFindDecorationMeta);
  editor.view.dispatch(tr);
}

export function clearFindDecorations(editor: Editor | null): void {
  if (!editor || editor.isDestroyed) return;
  const tr = editor.state.tr.setMeta(docFindDecorationKey, {
    kind: "clear",
  } satisfies DocFindDecorationMeta);
  editor.view.dispatch(tr);
}

export function scrollFindMatchIntoView(
  editor: Editor | null,
  from: number,
  container: HTMLElement | null,
): void {
  if (!editor || editor.isDestroyed || !container) return;
  try {
    const coords = editor.view.coordsAtPos(from);
    const containerRect = container.getBoundingClientRect();
    const targetTop = coords.top - containerRect.top + container.scrollTop;
    const nextTop = Math.max(
      0,
      targetTop - container.clientHeight * 0.45,
    );
    container.scrollTo({ top: nextTop, behavior: "smooth" });
  } catch {
    /* ignore */
  }
}
