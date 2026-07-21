
export type SessionStatus =
  | { "kind": "Active" }
  | { "kind": "Archived" }
  | { "kind": "Deleting" }
  | { "kind": "Deleted" };
