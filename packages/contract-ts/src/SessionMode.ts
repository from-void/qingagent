
export type SessionMode = { "kind": "existing", "data": { id: string, } } | { "kind": "new", "data": { template: string | null, sessionId?: string, } };
