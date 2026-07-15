
export type ContentDocState =
  | { "kind": "empty" }
  | { "kind": "editing" }
  | { "kind": "pendingReview" };

/**
 * Content state is the only durable/wire-authoritative document state.
 * Legacy 8-state words remain available only at compatibility boundaries.
 */
export type DocState = ContentDocState;

export type WireActiveOverlay = "askUser" | "confirm" | "imageProgress" | null;

export type LegacyDocStateKind =
  | "init"
  | "plan"
  | "drafting"
  | "draft"
  | "locked"
  | "review"
  | "committed"
  | "history";

export type LegacyDocState = { "kind": LegacyDocStateKind };

export type WireDocState = ContentDocState | LegacyDocState;

export type IncomingDocState = ContentDocState | LegacyDocState;
