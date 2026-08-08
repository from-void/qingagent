import type {
  BridgeFrame,
  ChatMessage,
  DocSuggestion,
  FinalDocumentReceipt,
  MessagePart,
  Resource,
  ToolCallSpec,
} from "@qingagent/contract-ts";
import type { PmDoc } from "@qingagent/pm-schema";
import type { CoreMessage } from "ai";
import type { SessionState } from "../session/sessionState.js";
import { LLM_IO_FIELD_LIMIT, summarizeToolValue } from "./redaction.js";
import crypto from "node:crypto";

function structuredToolTranscript(input: {
  toolName: string;
  toolCallId: string;
  args: unknown;
  result: unknown;
}): [CoreMessage, CoreMessage] {
  return [
    {
      role: "assistant",
      content: [{
        type: "tool-call",
        toolName: input.toolName,
        toolCallId: input.toolCallId,
        args: input.args,
      }],
    },
    {
      role: "tool",
      content: [{
        type: "tool-result",
        toolName: input.toolName,
        toolCallId: input.toolCallId,
        result: input.result,
      }],
    },
  ];
}

export function appendToolTranscriptMessage(
  state: SessionState,
  input: {
    toolName: string;
    toolCallId: string;
    args: unknown;
    result: unknown;
  },
): void {
  state.messages.push(...structuredToolTranscript({
    ...input,
    args: summarizeToolValue(input.args, LLM_IO_FIELD_LIMIT),
    result: summarizeToolValue(input.result, LLM_IO_FIELD_LIMIT),
  }));
}

export function newId(): string {
  return crypto.randomUUID();
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function ensureAgentChatHistoryMessage(
  state: SessionState,
  messageId: string,
): void {
  if (state.chatHistory.some((message) => message.id === messageId)) return;
  state.chatHistory.push({
    id: messageId,
    role: { kind: "agent" },
    ts: nowIso(),
    parts: [],
    chips: null,
  });
}

export function streamStart(streamId: string): BridgeFrame {
  return { kind: "stream", data: { kind: "start", data: { streamId } } };
}

export function streamEnd(
  streamId: string,
  reason: { kind: "done" } | { kind: "cancelled" } | { kind: "error"; data: string } = {
    kind: "done",
  },
  finalDocument?: FinalDocumentReceipt,
): BridgeFrame {
  return {
    kind: "stream",
    data: {
      kind: "end",
      data: {
        streamId,
        reason,
        ...(finalDocument ? { finalDocument } : {}),
      },
    },
  };
}

export function chatMessageAdded(message: ChatMessage): BridgeFrame {
  return { kind: "chatMessageAdded", data: { message } };
}

export function chatMessageAppended(
  messageId: string,
  seq: number,
  part: MessagePart,
): BridgeFrame {
  return { kind: "chatMessageAppended", data: { messageId, seq, part } };
}

export function docDiffReady(
  baseVersion: number,
  suggestions: DocSuggestion[] = [],
  previewDoc?: PmDoc,
  editedDoc?: PmDoc,
  wholeDocument = false,
): BridgeFrame {
  return {
    kind: "docDiffReady",
    data: {
      baseVersion,
      suggestions,
      ...(wholeDocument ? { wholeDocument: true } : {}),
      ...(previewDoc ? { previewDoc } : {}),
      ...(editedDoc ? { editedDoc } : {}),
    },
  };
}

export function resourceUpserted(resource: Resource): BridgeFrame {
  return { kind: "resourceUpserted", data: { resource } };
}

export function resourceUpdated(
  resourceId: string,
  summary: string | null,
  metadata: unknown | null,
): BridgeFrame {
  return {
    kind: "resourceUpdated",
    data: {
      resourceRef: { id: resourceId, domain: { kind: "file" } },
      summary,
      metadata,
    },
  };
}

export function toolCallUpdated(
  messageId: string,
  toolCallId: string,
  spec: ToolCallSpec,
): BridgeFrame {
  return { kind: "toolCallUpdated", data: { messageId, toolCallId, spec } };
}
