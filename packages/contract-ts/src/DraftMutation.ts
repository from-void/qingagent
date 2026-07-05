export type DraftListItem = {
  runs?: unknown[];
  children?: unknown[];
  checked?: boolean;
};

export type DraftTableCell = {
  runs?: unknown[];
  header?: boolean;
  backgroundColor?: string;
};

export type DraftMutationOp =
  | { action: "replaceBlock"; ref: string; block: unknown }
  | { action: "insertBlock"; position: "after" | "before" | "start" | "end"; ref?: string; blocks: unknown[] }
  | { action: "deleteBlock"; ref: string }
  | { action: "replaceListItem"; ref: string; item: DraftListItem }
  | { action: "insertListItem"; parentRef: string; at: "before" | "after" | "start" | "end"; ref?: string; item: DraftListItem }
  | { action: "deleteListItem"; ref: string }
  | { action: "insertTableRow"; ref: string; at: "before" | "after" | "end"; rowIndex?: number; cells?: DraftTableCell[] }
  | { action: "insertTableColumn"; ref: string; at: "before" | "after" | "end"; columnIndex?: number; cells?: DraftTableCell[] }
  | { action: "deleteTableRow"; ref: string; rowIndex: number }
  | { action: "deleteTableColumn"; ref: string; columnIndex: number }
  | {
      action: "replaceText";
      find: string;
      replace: string;
      all?: boolean;
      isRegex?: boolean;
      withinRef?: string;
    }
  | {
      action: "markText";
      find: string;
      mark: unknown;
      op: "add" | "remove";
      all?: boolean;
      isRegex?: boolean;
      withinRef?: string;
    };

export type EditDraftInput = {
  ops: DraftMutationOp[];
};
