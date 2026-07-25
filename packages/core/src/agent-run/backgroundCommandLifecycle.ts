import { WORKSPACE_TOOLS } from "@mastra/core/workspace";
import type { AgentStreamEvent } from "./agentStreamEvents.js";
import type { AgentStreamTurnContext } from "./agentStreamTurnContext.js";
import type { BackgroundCommandTerminal } from "./backgroundCommandSettlement.js";

export interface NormalizedBackgroundCommandLifecycle {
  pid: string;
  eventPid: string | null;
  argumentPid: string | null;
  sourceToolCallId: string | null;
  sourceToolName: string | null;
  terminal: BackgroundCommandTerminal;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringId(value: unknown): string | null {
  return typeof value === "string" || typeof value === "number"
    ? String(value)
    : null;
}

function sourceToolName(
  turn: AgentStreamTurnContext,
  toolCallId: string | null,
  payloadToolName: unknown,
  dataToolName: unknown,
): string | null {
  if (toolCallId) {
    const mapped = turn.toolCallNameById.get(toolCallId);
    if (mapped) return mapped;
  }
  if (typeof dataToolName === "string" && dataToolName) return dataToolName;
  return typeof payloadToolName === "string" && payloadToolName
    ? payloadToolName
    : null;
}

export function rememberWorkspaceToolMetadata(
  turn: AgentStreamTurnContext,
  output: Record<string, unknown>,
): boolean {
  if (output.type !== "data-workspace-metadata" || !isRecord(output.data)) {
    return false;
  }
  const toolCallId = stringId(output.data.toolCallId);
  const toolName =
    typeof output.data.toolName === "string" && output.data.toolName
      ? output.data.toolName
      : null;
  if (toolCallId && toolName) turn.toolCallNameById.set(toolCallId, toolName);
  return true;
}

export function normalizeSandboxExitEvent(
  turn: AgentStreamTurnContext,
  chunk: AgentStreamEvent,
): NormalizedBackgroundCommandLifecycle | null {
  if (chunk.type !== "tool-output") return null;
  const output = chunk.payload.output;
  if (output?.type !== "data-sandbox-exit" || !isRecord(output.data)) return null;

  const sourceToolCallId =
    stringId(output.data.toolCallId) ?? stringId(chunk.payload.toolCallId);
  const args = sourceToolCallId
    ? turn.toolCallArgsById.get(sourceToolCallId)
    : undefined;
  const resolvedToolName = sourceToolName(
    turn,
    sourceToolCallId,
    chunk.payload.toolName,
    output.data.toolName,
  );
  const eventPid = stringId(output.data.pid);
  const argumentPid = stringId(args?.pid);
  // toolCallId 反查出的工具入参是本会话实际读取/终止的目标；原生生命周期帧只作兜底。
  const pid = argumentPid ?? eventPid;
  if (!pid) return null;

  if (resolvedToolName === WORKSPACE_TOOLS.SANDBOX.KILL_PROCESS) {
    if (output.data.killed !== true) return null;
    const signalValue = output.data.signal ?? args?.signal;
    const signal =
      typeof signalValue === "string" && signalValue.trim()
        ? signalValue.trim()
        : "SIGTERM";
    return {
      pid,
      eventPid,
      argumentPid,
      sourceToolCallId,
      sourceToolName: resolvedToolName,
      terminal: { kind: "killed", signal },
    };
  }

  const rawExitCode = output.data.exitCode;
  const exitCode = typeof rawExitCode === "number" && Number.isFinite(rawExitCode)
    ? rawExitCode
    : output.data.success === true
      ? 0
      : -1;
  const terminal: BackgroundCommandTerminal = output.data.timedOut === true
    ? { kind: "timedOut", exitCode }
    : output.data.success === true && exitCode === 0
      ? { kind: "succeeded", exitCode: 0 }
      : { kind: "failed", exitCode };
  return {
    pid,
    eventPid,
    argumentPid,
    sourceToolCallId,
    sourceToolName: resolvedToolName,
    terminal,
  };
}

const KILLED_RESULT_RE = /^Process\s+(\S+)\s+has been killed\.(?:\n|$)/;

export function normalizeKillProcessResult(input: {
  turn: AgentStreamTurnContext;
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
  rawToolResult: unknown;
}): NormalizedBackgroundCommandLifecycle | null {
  if (input.toolName !== WORKSPACE_TOOLS.SANDBOX.KILL_PROCESS) return null;
  input.turn.toolCallNameById.set(input.toolCallId, input.toolName);
  const structured = isRecord(input.rawToolResult) ? input.rawToolResult : null;
  const textMatch = typeof input.rawToolResult === "string"
    ? input.rawToolResult.match(KILLED_RESULT_RE)
    : null;
  const success =
    structured?.success === true ||
    structured?.killed === true ||
    textMatch !== null;
  if (!success) return null;

  const pid =
    stringId(input.args.pid) ??
    stringId(structured?.pid) ??
    stringId(textMatch?.[1]);
  if (!pid) return null;
  const eventPid = stringId(structured?.pid) ?? stringId(textMatch?.[1]);
  const argumentPid = stringId(input.args.pid);
  const signalValue = structured?.signal ?? input.args.signal;
  const signal =
    typeof signalValue === "string" && signalValue.trim()
      ? signalValue.trim()
      : "SIGTERM";
  return {
    pid,
    eventPid,
    argumentPid,
    sourceToolCallId: input.toolCallId,
    sourceToolName: input.toolName,
    terminal: { kind: "killed", signal },
  };
}
