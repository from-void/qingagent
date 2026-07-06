export type DraftMutationOp =
  | { action: "replaceBlock"; ref: string; block: string }
  | { action: "insertBlock"; position: "after" | "before" | "start" | "end"; ref?: string; blocks: string }
  | { action: "deleteBlock"; ref: string }
  | { action: "replaceListItem"; ref: string; item: string }
  | { action: "insertListItem"; parentRef: string; at: "before" | "after" | "start" | "end"; ref?: string; item: string }
  | { action: "deleteListItem"; ref: string }
  | { action: "insertTableRow"; ref: string; at: "before" | "after" | "end"; rowIndex?: number; cells: string }
  | { action: "insertTableColumn"; ref: string; at: "before" | "after" | "end"; columnIndex?: number; cells: string }
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
