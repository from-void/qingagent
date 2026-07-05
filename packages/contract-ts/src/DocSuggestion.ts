import type { DiffHunk } from "./DiffHunk";
import type { ReviewGroupMode } from "./DiffHunk";
import type { PatchConflict } from "./PatchConflict";
import type { PmStep } from "./PmStep";

export type SuggestionStatus =
  | "reviewing"
  | "accepted"
  | "rejected"
  | "committed"
  | "conflict";

export type SuggestionAnchor = {
  blockId: string;
  pmFrom: number;
  pmTo: number;
  quote: string;
  prefix?: string;
  suffix?: string;
  textHash: string;
};

export type DocSuggestion = {
  id: string;
  reviewBatchId?: string;
  groupMode?: ReviewGroupMode;
  docId: string;
  baseVersion: number;
  baseSchemaVersion: number;
  status: SuggestionStatus;
  anchor: SuggestionAnchor;
  patch: {
    kind: "prosemirror_steps";
    steps: Array<PmStep>;
  };
  preview: {
    deleteText: string;
    insertText: string;
  };
  diffHunk?: DiffHunk;
  summary: string;
  conflict?: PatchConflict;
};
