import type { MessagePart } from "./MessagePart";
import type { Role } from "./Role";

/**
 * Stage A.5 legacy. Keep around so old code compiles, but new code
 * should use `ChatMessage`.
 */
export type AgentMessage = { messageId: string, role: Role, parts: Array<MessagePart>, };
