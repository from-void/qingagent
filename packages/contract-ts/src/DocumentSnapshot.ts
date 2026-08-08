import type { PmDoc } from "./PmDoc";

export type DocumentSnapshot = {
  version: number,
  ts: string,
  /** PM 文档权威载荷。 */
  doc: PmDoc,
};
