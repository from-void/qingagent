import type { PmBlockNode, PmMark } from "@qingagent/pm-schema";

export type PatchMetaChange =
  | { kind: "content"; before: string; after: string }
  | {
      kind: "mark";
      op: "markAdd" | "markRemove";
      marks?: PmMark[];
      label?: string;
    };

export interface PatchMeta {
  before: string;
  after: string;
  kind?: "text" | "markAdd" | "markRemove" | "insert" | "delete" | "replace";
  marks?: PmMark[];
  label?: string;
  /** 原始 before PM node:hover 卡片"原文"据此用 PmBlockView 渲成真内容(表格/图表/公式/嵌套列表全保真)。 */
  beforePmNodes?: readonly PmBlockNode[];
  changes?: PatchMetaChange[];
  index: number;
}
