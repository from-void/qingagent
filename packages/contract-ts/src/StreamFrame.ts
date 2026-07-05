import type { EndReason } from "./EndReason";

export type StreamErrorCategory = "auth" | "quota" | "rate_limit" | "timeout" | "upstream" | "network" | "unknown";

export type StreamErrorAction = "retry" | "check_model_settings" | "check_balance" | "reload" | "none";

export type StreamFrame = { "kind": "start", "data": { streamId: string, } } | { "kind": "end", "data": { streamId: string, reason: EndReason, } } | { "kind": "draftingFailed", "data": { streamId: string, reason: string, retriable: boolean, statusCode?: number, category?: StreamErrorCategory, userMessage?: string, action?: StreamErrorAction, } };
