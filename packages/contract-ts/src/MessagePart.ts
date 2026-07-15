import type { AskUserAnswerCardPart } from "./AskUserAnswerCardPart";
import type { ActionCardData } from "./ActionCard";
import type { Citation } from "./Citation";
import type { ImagePart } from "./ImagePart";
import type { ReviewOutcome } from "./ReviewOutcome";
import type { ThinkingPart } from "./ThinkingPart";
import type { ToolCallSpec } from "./ToolCallSpec";

export type MessagePart = { "kind": "text", "data": { body: string, } } | { "kind": "code", "data": { lang: string, body: string, } } | { "kind": "toolCall", "data": ToolCallSpec } | { "kind": "thinking", "data": ThinkingPart } | { "kind": "citation", "data": Citation } | { "kind": "image", "data": ImagePart } | { "kind": "patchSummary", "data": { count: number, hunkIds: Array<string>, } } | { "kind": "reviewOutcome", "data": ReviewOutcome } | { "kind": "askUserAnswerCard", "data": AskUserAnswerCardPart } | { "kind": "actionCard", "data": ActionCardData };
