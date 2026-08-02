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

const LEGACY_TOOL_TRANSCRIPT_RE = /^\[tool-result\]\r?\ntoolName: ([^\r\n]+)\r?\ntoolCallId: ([^\r\n]+)\r?\nargs: ([^\r\n]*)\r?\nresult: ([^\r\n]*)$/u;

function parseLegacyTranscriptValue(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    // 历史超长字段可能被截断成非 JSON；保留已脱敏的旧文本，不能因迁移丢上下文。
    return value;
  }
}

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

/**
 * 把旧版内部五行文本回放迁移为 provider 原生工具角色。
 *
 * 只认 appendToolTranscriptMessage 曾生成的完整固定形状，普通提及 `[tool-result]`
 * 的正文不改。转换不含时间戳、随机 ID 或轮次变量，同一历史的序列化字节恒定；老会话
 * 首次进入新版时会发生一次历史前缀失效，持久化后后续轮次仍保持 append-only 前缀。
 */
export function normalizeLegacyToolTranscriptMessages(
  messages: CoreMessage[],
): CoreMessage[] {
  let normalized: CoreMessage[] | null = null;
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]!;
    if (message.role !== "assistant" || typeof message.content !== "string") {
      if (normalized) normalized.push(message);
      continue;
    }
    const match = LEGACY_TOOL_TRANSCRIPT_RE.exec(message.content);
    if (!match) {
      if (normalized) normalized.push(message);
      continue;
    }
    if (!normalized) normalized = messages.slice(0, index);
    normalized.push(...structuredToolTranscript({
      toolName: match[1]!,
      toolCallId: match[2]!,
      args: parseLegacyTranscriptValue(match[3]!),
      result: parseLegacyTranscriptValue(match[4]!),
    }));
  }
  return normalized ?? messages;
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
