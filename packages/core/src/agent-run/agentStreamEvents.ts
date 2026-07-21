/**
 * Mastra 1.49 对 AI SDK v4 fullStream 的桥接事件。
 *
 * AI SDK v4 原始 part 会先由 Mastra 转成 `{ type, payload, runId, from }`；
 * 本联合只描述 processAgentStream 实际消费的事件，避免把上游的 `any` 继续扩散。
 * envelope 字段保持可选，以兼容 idle-timeout 合成事件和历史测试 fixture。
 */
interface StreamEvent<TType extends string, TPayload> {
  type: TType;
  payload: TPayload;
  runId?: string;
  from?: string;
  metadata?: Record<string, unknown>;
}

export type AgentStreamErrorEvent = StreamEvent<
  "error",
  {
    error?: unknown;
    idleTimeout?: boolean;
    statusCode?: unknown;
    [key: string]: unknown;
  }
>;

export type AgentStreamTripwireEvent = StreamEvent<
  "tripwire",
  {
    reason?: string;
    retry?: boolean;
    metadata?: unknown;
    processorId?: string;
    [key: string]: unknown;
  }
>;

export type AgentStreamStepStartEvent = StreamEvent<
  "step-start",
  {
    request?: { body?: string; [key: string]: unknown };
    inputMessages?: unknown;
    warnings?: unknown[];
    [key: string]: unknown;
  }
>;

export type AgentStreamStepFinishEvent = StreamEvent<
  "step-finish",
  {
    stepResult?: {
      reason?: unknown;
      providerMetadata?: unknown;
      [key: string]: unknown;
    };
    output?: {
      usage?: unknown;
      providerMetadata?: unknown;
      [key: string]: unknown;
    };
    finishReason?: unknown;
    reason?: unknown;
    providerMetadata?: unknown;
    [key: string]: unknown;
  }
>;

export type AgentStreamToolOutputEvent = StreamEvent<
  "tool-output",
  {
    toolCallId?: unknown;
    toolName?: unknown;
    output?: Record<string, unknown>;
    [key: string]: unknown;
  }
>;

export type AgentStreamTextEvent = StreamEvent<
  "text-delta",
  { id?: string; text?: unknown; providerMetadata?: unknown }
>;

export type AgentStreamReasoningEvent =
  | StreamEvent<"reasoning-start", { id?: string; providerMetadata?: unknown }>
  | StreamEvent<"reasoning-delta", { id?: string; text?: string; providerMetadata?: unknown }>
  | StreamEvent<"reasoning-end", { id?: string; providerMetadata?: unknown }>;

export type AgentStreamToolSuspendedEvent = StreamEvent<
  "tool-call-suspended",
  {
    toolCallId: string;
    toolName: string;
    suspendPayload: unknown;
    args: Record<string, unknown>;
    resumeSchema?: string;
  }
>;

export type AgentStreamToolApprovalEvent = StreamEvent<
  "tool-call-approval",
  {
    toolCallId?: unknown;
    toolName?: unknown;
    args?: unknown;
    resumeSchema?: unknown;
    [key: string]: unknown;
  }
>;

export type AgentStreamToolInputEvent =
  | StreamEvent<
      "tool-call-input-streaming-start",
      { toolCallId?: unknown; toolName?: unknown; [key: string]: unknown }
    >
  | StreamEvent<
      "tool-call-delta",
      {
        toolCallId?: string;
        toolName?: string;
        argsTextDelta?: string;
        [key: string]: unknown;
      }
    >
  | StreamEvent<
      "tool-call-input-streaming-end",
      { toolCallId?: string; [key: string]: unknown }
    >;

export type AgentStreamToolCallEvent = StreamEvent<
  "tool-call",
  {
    toolCallId: string;
    toolName: string;
    args?: unknown;
    [key: string]: unknown;
  }
>;

export type AgentStreamToolErrorEvent = StreamEvent<
  "tool-error",
  {
    toolCallId?: unknown;
    toolName?: unknown;
    args?: unknown;
    error?: unknown;
    [key: string]: unknown;
  }
>;

export type AgentStreamToolResultEvent = StreamEvent<
  "tool-result",
  {
    toolCallId: string;
    toolName: string;
    args?: unknown;
    result?: unknown;
    output?: unknown;
    [key: string]: unknown;
  }
>;

type IgnoredPayloadEvent = StreamEvent<
  | "response-metadata"
  | "text-start"
  | "text-end"
  | "reasoning-signature"
  | "redacted-reasoning"
  | "source"
  | "file"
  | "finish"
  | "raw"
  | "start"
  | "abort"
  | "step-output"
  | "watch"
  | "is-task-complete"
  | "goal",
  Record<string, unknown>
>;

type IgnoredObjectEvent =
  | { type: "object"; object: unknown; runId?: string; from?: string }
  | { type: "object-result"; object: unknown; runId?: string; from?: string };

export type AgentStreamEvent =
  | AgentStreamErrorEvent
  | AgentStreamTripwireEvent
  | AgentStreamStepStartEvent
  | AgentStreamStepFinishEvent
  | AgentStreamToolOutputEvent
  | AgentStreamTextEvent
  | AgentStreamReasoningEvent
  | AgentStreamToolSuspendedEvent
  | AgentStreamToolApprovalEvent
  | AgentStreamToolInputEvent
  | AgentStreamToolCallEvent
  | AgentStreamToolErrorEvent
  | AgentStreamToolResultEvent
  | IgnoredPayloadEvent
  | IgnoredObjectEvent;
