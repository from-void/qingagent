import type { LegacySection } from "./LegacySection";
import type { PmDoc } from "./PmDoc";

export type DocumentSnapshot = {
  version: number,
  ts: string,
  /** PM 文档(权威载荷)。发射侧恒填,消费侧以此为准。 */
  doc: PmDoc,
  /**
   * @deprecated 旧 sections 视图。仅作为前端旧缓存的兼容窗口保留,
   * 消费侧在 doc 存在时整段忽略;过渡期结束后移除。
   */
  sections?: Array<LegacySection>,
};
