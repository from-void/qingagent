import type { DocSuggestion } from "./DocSuggestion";
import type { PmDoc } from "./PmDoc";

export type DocDiffReady = {
  baseVersion: number;
  suggestions: Array<DocSuggestion>;
  /** 审阅基线 = 候选生成时刻的真实旧文档(overlay 叠在它上面)。 */
  previewDoc?: PmDoc;
  /** 候选编辑后的完整新文档(干净版,含块级/表格改动)。整篇审「新版」直接用它,
   * 不必前端再 materialize(materializeDoc 清不了块级 patch)。 */
  editedDoc?: PmDoc;
};
