import type { PmDoc } from "./PmDoc";

export type HistorySnapshot = {
  version_id: string;
  doc: PmDoc;
  docVersion: number;
};
