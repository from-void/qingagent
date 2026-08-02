import type { DiffHunk } from "./DiffHunk";
import type { ReviewGroupMode } from "./DiffHunk";
import type { PatchConflict } from "./PatchConflict";
import type { PmStep } from "./PmStep";

export type SuggestionStatus =
  | "reviewing"
  | "accepted"
  | "rejected"
  | "committed"
  | "conflict"
  | "ignored";

export type SuggestionKind = "revision" | "annotation";

export type AnnotationSeverity = "error" | "warn" | "info";

export type AnnotationGroupMeta = {
  summary: string;
  suggestion?: string;
  hitCount: number;
  severity?: AnnotationSeverity;
};

export type SuggestionAnchor = {
  blockId: string;
  pmFrom: number;
  pmTo: number;
  quote: string;
  prefix?: string;
  suffix?: string;
  textHash: string;
};

export type DocSuggestion = {
  id: string;
  /** 数据库审阅批次标识；同一 hunk 在 rebase 前后必须属于不同批次。 */
  batchId?: string;
  reviewBatchId?: string;
  groupMode?: ReviewGroupMode;
  docId: string;
  baseVersion: number;
  baseSchemaVersion: number;
  status: SuggestionStatus;
  anchor: SuggestionAnchor;
  patch: {
    kind: "prosemirror_steps";
    steps: Array<PmStep>;
  };
  preview: {
    deleteText: string;
    insertText: string;
  };
  diffHunk?: DiffHunk;
  summary: string;
  conflict?: PatchConflict;
  /** revision 是可提交补丁；annotation 只描述问题锚点，不参与 pendingReview。 */
  kind?: SuggestionKind;
  note?: string;
  origin?: string;
  groupId?: string;
  groupMeta?: AnnotationGroupMeta;
  severity?: AnnotationSeverity;
};

export type AnnotationGroup = {
  id: string;
  summary: string;
  note: string;
  origin: string;
  suggestion?: string;
  /** 缺省时按 warn 的现有样式渲染，但不展示分级统计。 */
  severity?: AnnotationSeverity;
  status: "reviewing" | "accepted" | "ignored";
  anchors: SuggestionAnchor[];
};

/**
 * 批注原因不是可执行修改；空值或复读原因的 suggestion 统一视为未提供。
 */
export function normalizeAnnotationSuggestion(
  note: string,
  suggestion: string | null | undefined,
): string | undefined {
  const normalized = suggestion?.trim();
  if (!normalized || normalized === note.trim()) return undefined;
  return normalized;
}
