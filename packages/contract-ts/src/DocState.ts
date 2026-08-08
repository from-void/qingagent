
export type ContentDocState =
  | { "kind": "empty" }
  | { "kind": "editing" }
  | { "kind": "pendingReview" };

/** Content state is the only durable and wire-authoritative document state. */
export type DocState = ContentDocState;

export type WireActiveOverlay = "askUser" | "confirm" | "imageProgress" | null;
