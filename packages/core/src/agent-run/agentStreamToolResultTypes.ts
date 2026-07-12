import type { AgentStreamTurnContext } from "./agentStreamTurnContext.js";

export interface ToolResultContext {
  turn: AgentStreamTurnContext;
  toolName: string;
  toolCallId: string;
  args: Record<string, unknown>;
  rawArgs: Record<string, unknown>;
  rawToolResult: unknown;
  toolResult: Record<string, unknown>;
  toolResultOk: boolean;
}

export type ToolResultHandlerResult = "unhandled" | "handled" | "short-circuit";
