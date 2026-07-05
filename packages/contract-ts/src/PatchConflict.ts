export type PatchConflict = {
  kind:
    | "target_text_changed"
    | "block_removed"
    | "ambiguous_match"
    | "schema_invalid"
    | "version_conflict";
  message: string;
  suggestionId?: string;
  blockId?: string;
  currentVersion?: number;
};
