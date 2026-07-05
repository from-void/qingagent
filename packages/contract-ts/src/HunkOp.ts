
export type HunkOp = { "kind": "keep", "data": string } | { "kind": "insert", "data": string } | { "kind": "delete", "data": string };
