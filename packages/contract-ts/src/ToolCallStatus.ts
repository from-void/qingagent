
export type ToolCallStatus = { "kind": "pending" } | { "kind": "running", "data": { progressPct: number | null, etaSec: number | null, } } | { "kind": "done" } | { "kind": "failed", "data": { retriable: boolean, reason: string, } } | { "kind": "aborted" } | { "kind": "reviewing" } | { "kind": "accepted" } | { "kind": "rejected" } | { "kind": "committed" };
