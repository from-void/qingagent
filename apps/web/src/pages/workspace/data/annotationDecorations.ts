import type { Editor } from "@tiptap/react";
import type { AnnotationGroup, SuggestionAnchor } from "@qingagent/contract-ts";
import { APPLYING_REMOTE_META } from "@qingagent/pm-schema/tiptap";
import { Plugin, PluginKey, type Transaction } from "@tiptap/pm/state";
import type { StepMap } from "@tiptap/pm/transform";
import { Decoration, DecorationSet } from "@tiptap/pm/view";

const key = new PluginKey("annotation-group-highlight");

function stepMapTouchesRange(map: StepMap, from: number, to: number): boolean {
  let touched = false;
  map.forEach((oldStart, oldEnd) => {
    if (touched) return;
    touched = oldStart === oldEnd
      ? from < oldStart && oldStart < to
      : oldStart < to && oldEnd > from;
  });
  return touched;
}

function normalizeAnnotationQuote(value: string): string {
  return value
    .normalize("NFKC")
    .trim()
    .replace(/\s+/gu, " ")
    .replace(/[「」『』“”]/gu, '"')
    .replace(/[‘’]/gu, "'");
}

/**
 * 以事务前坐标逐 step 前推锚点。边界处编辑按锚外处理；只有严格进入锚内的文本变更
 * 才触发 quote 校验。精确校验失败后仅接受空白/引号归一化等价；失效锚点独立退场，
 * 同组仍有存活锚点时继续保留，不重搜、不猜测新位置。
 */
export function mapAnnotationGroupsThroughTransaction(
  groups: readonly AnnotationGroup[],
  transaction: Transaction,
): AnnotationGroup[] {
  if (!transaction.docChanged || transaction.getMeta(APPLYING_REMOTE_META) === true) {
    return groups as AnnotationGroup[];
  }

  let changed = false;
  const nextGroups: AnnotationGroup[] = [];
  for (const group of groups) {
    const anchors = group.anchors.flatMap((anchor) => {
      let from = anchor.pmFrom;
      let to = anchor.pmTo;
      let touched = false;

      for (const step of transaction.steps) {
        const map = step.getMap();
        touched ||= stepMapTouchesRange(map, from, to);
        const mappedFrom = map.map(from, 1);
        const mappedTo = map.map(to, -1);
        from = mappedFrom;
        to = mappedTo;
      }

      const mappedQuote = touched ? transaction.doc.textBetween(from, to, "") : anchor.quote;
      if (
        from >= to
        || (mappedQuote !== anchor.quote
          && normalizeAnnotationQuote(mappedQuote) !== normalizeAnnotationQuote(anchor.quote))
      ) {
        changed = true;
        return [];
      }
      if (from === anchor.pmFrom && to === anchor.pmTo) return [anchor];
      changed = true;
      return [{ ...anchor, pmFrom: from, pmTo: to }];
    });

    if (anchors.length === 0) continue;
    nextGroups.push(anchors.length === group.anchors.length
      && anchors.every((anchor, index) => anchor === group.anchors[index])
      ? group
      : { ...group, anchors });
  }
  return changed ? nextGroups : groups as AnnotationGroup[];
}

type AnnotationPluginState = {
  groups: readonly AnnotationGroup[];
  revision: number;
  unlocatedGroupCount: number;
};

export interface AnnotationPreviewDecorationGroup {
  previewId: string;
  summary: string;
  anchors: SuggestionAnchor[];
}

type RenderAnnotationGroup =
  | AnnotationGroup
  | {
      id: string;
      status: "previewing";
      anchors: SuggestionAnchor[];
    };

export function installAnnotationGroupDecorations(
  editor: Editor,
  groups: readonly AnnotationGroup[],
  onGroupsChange?: (groups: AnnotationGroup[], unlocatedGroupCount: number) => void,
  previewGroups: readonly AnnotationPreviewDecorationGroup[] = [],
): () => void {
  editor.unregisterPlugin(key);
  let disposed = false;
  editor.registerPlugin(new Plugin({
    key,
    state: {
      init: (): AnnotationPluginState => ({ groups, revision: 0, unlocatedGroupCount: 0 }),
      apply(transaction, value): AnnotationPluginState {
        const nextGroups = mapAnnotationGroupsThroughTransaction(value.groups, transaction);
        return nextGroups === value.groups
          ? value
          : {
              groups: nextGroups,
              revision: value.revision + 1,
              unlocatedGroupCount: Math.max(0, value.groups.length - nextGroups.length),
            };
      },
    },
    props: {
      decorations(state) {
        const pluginState = key.getState(state) as AnnotationPluginState | undefined;
        const renderGroups: RenderAnnotationGroup[] = [
          ...(pluginState?.groups ?? groups),
          ...previewGroups.map((group) => ({
            id: group.previewId,
            status: "previewing" as const,
            anchors: group.anchors,
          })),
        ];
        const entries = renderGroups.flatMap((group) => group.status === "ignored"
          ? []
          : group.anchors.flatMap((anchor) =>
            anchor.pmFrom >= 0 && anchor.pmTo > anchor.pmFrom && anchor.pmTo <= state.doc.content.size
              ? [{ group, anchor }]
              : [],
          ));
        return DecorationSet.create(state.doc, entries.flatMap(({ group, anchor }) => {
          const boundaries = new Set([anchor.pmFrom, anchor.pmTo]);
          for (const other of entries) {
            const from = Math.max(anchor.pmFrom, other.anchor.pmFrom);
            const to = Math.min(anchor.pmTo, other.anchor.pmTo);
            if (from < to) {
              boundaries.add(from);
              boundaries.add(to);
            }
          }
          const positions = [...boundaries].sort((a, b) => a - b);
          const reducedMotion = typeof window !== "undefined"
            && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
          const className = group.status === "previewing"
            ? `annotation-anchor-preview${reducedMotion ? " is-reduced-motion" : ""}`
            : group.status === "accepted"
              ? "annotation-anchor-accepted"
              : "annotation-anchor-active";
          return positions.slice(0, -1).flatMap((from, index) => {
            const to = positions[index + 1]!;
            if (from >= to) return [];
            const hitGroupIds = [...new Set(entries
              .filter((entry) => entry.group.status === "reviewing" && entry.anchor.pmFrom < to && entry.anchor.pmTo > from)
              .map((entry) => entry.group.id))];
            return [Decoration.inline(from, to, {
              class: className,
              "data-annotation-group": group.id,
              "data-annotation-groups": hitGroupIds.join(","),
              "data-annotation-severity": "severity" in group ? group.severity ?? "warn" : "warn",
              ...(group.status === "previewing" ? { "data-annotation-preview": "true" } : {}),
              ...(hitGroupIds.length > 1 ? { "data-annotation-overlap": "true" } : {}),
            })];
          });
        }));
      },
    },
    view() {
      let notifiedRevision = 0;
      return {
        update(view) {
          const pluginState = key.getState(view.state) as AnnotationPluginState | undefined;
          if (!pluginState || pluginState.revision === notifiedRevision) return;
          notifiedRevision = pluginState.revision;
          const nextGroups = pluginState.groups as AnnotationGroup[];
          queueMicrotask(() => {
            if (!disposed) onGroupsChange?.(nextGroups, pluginState.unlocatedGroupCount);
          });
        },
      };
    },
  }));
  return () => {
    disposed = true;
    if (!editor.isDestroyed) editor.unregisterPlugin(key);
  };
}
