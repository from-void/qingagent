import type { ChatChip } from "./ChatChip";
import type { ChatRole } from "./ChatRole";
import type { MessagePart } from "./MessagePart";

export type ChatMessage = { id: string, role: ChatRole, ts: string, parts: Array<MessagePart>, chips: Array<ChatChip> | null, };
