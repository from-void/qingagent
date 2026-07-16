export const DRAFT_MARK_COLORS = [
  "ink", "gray", "slate", "brown", "red", "orange", "amber", "yellow",
  "lime", "green", "sage", "mint", "teal", "cyan", "sky", "blue",
  "indigo", "violet", "purple", "magenta", "pink", "rose", "sand", "lavender",
] as const;

export type DraftMarkColor = (typeof DRAFT_MARK_COLORS)[number];

/** editDraft markText 实际支持的 AI-IR mark；strikeThrough 为历史兼容别名。 */
export type DraftTextMark =
  | { type: "bold" }
  | { type: "italic" }
  | { type: "underline" }
  | { type: "strike" }
  | { type: "strikeThrough" }
  | { type: "code" }
  | { type: "link"; href: string; title?: string | null | undefined }
  | { type: "textColor" | "highlight"; color: DraftMarkColor };

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
      mark: DraftTextMark;
      op: "add" | "remove";
      all?: boolean;
      isRegex?: boolean;
      withinRef?: string;
    };

export type EditDraftInput = {
  ops: DraftMutationOp[];
};
