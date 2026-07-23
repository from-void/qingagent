import type { LegacySection } from "./LegacySection";
import type { PmDoc } from "./PmDoc";

export type UpdateDoc = {
  sessionId: string;
  expectedDocumentSnapshot: number;
  /** 保存基线 canonical PM 文档的内容哈希；旧客户端可暂不提供。 */
  baseContentHash?: string;
  legacySections?: Array<LegacySection>;
  doc?: PmDoc;
  clientMutationId: string;
};
