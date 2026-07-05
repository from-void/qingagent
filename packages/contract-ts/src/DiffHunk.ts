import type { PmMark } from "./PmMark";
import type { PmNode } from "./PmNode";

export type DiffHunkOp = "insert" | "delete" | "replace" | "markAdd" | "markRemove";
export type ReviewGroupMode = "atomic" | "independent";

export type DiffHunkAnchor = {
  blockId?: string;
  quoteBefore?: string;
  quoteAfter?: string;
  pmFrom?: number;
  pmTo?: number;
  anchorKind?: "range" | "position";
  gravity?: "before" | "after";
};

export type DiffHunk = {
  hunkId: string;
  reviewBatchId: string;
  groupMode: ReviewGroupMode;
  op: DiffHunkOp;
  blockPath: Array<number>;
  anchor: DiffHunkAnchor;
  before: Array<PmNode> | null;
  after: Array<PmNode> | null;
  marks?: Array<PmMark>;
  summary: string;
  beforeText?: string;
  afterText?: string;
  beforeBlock?: PmNode;
  afterBlock?: PmNode;
  overlapRatio?: number;
};
