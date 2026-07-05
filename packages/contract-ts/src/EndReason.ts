
export type EndReason = { "kind": "done" } | { "kind": "cancelled" } | { "kind": "error", "data": string };
