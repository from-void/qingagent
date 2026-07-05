import type { PmBlockNode } from "./PmNode";

export type PmDoc = {
  type: "doc";
  attrs: {
    schemaVersion: 1;
  };
  content: Array<PmBlockNode>;
};
