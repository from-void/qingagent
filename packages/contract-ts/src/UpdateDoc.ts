import type { PmDoc } from "./PmDoc";

export type UpdateDoc = {
  sessionId: string;
  expectedDocumentSnapshot: number;
  /** 保存基线 canonical PM 文档的内容哈希。 */
  baseContentHash: string;
  doc: PmDoc;
  clientMutationId: string;
};
