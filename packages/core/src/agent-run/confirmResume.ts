import type { BridgeFrame, ChatMessage, ToolCallSpec } from "@qingagent/contract-ts";
import type { ToolsInput } from "@mastra/core/agent";
import { MASTRA_THREAD_ID_KEY, RequestContext } from "@mastra/core/request-context";
import { WORKSPACE_TOOLS } from "@mastra/core/workspace";
import crypto from "node:crypto";
import { qingagentAgent } from "../agents/qingagent.js";
import type { ConfirmService } from "../confirm/confirmService.js";
import { emitProjectedDocState } from "../doc-engine/docStateMachine.js";
import type { PendingConfirm, SessionState } from "../session/sessionState.js";
import { buildCapabilityTools, createSessionScopedTools } from "../session/sessionTools.js";
import { schedulePersist } from "../session/threadPersistence.js";
import { AGENT_MAX_STEPS } from "./agentLimits.js";
import { processAgentStream } from "./processAgentStream.js";
import { finalizeLingeringRunningToolCalls } from "./turnCleanup.js";
import {
  alignCommandCardWithStatus,
  confirmedCommandCardSpec,
} from "./toolCards.js";
import { chatMessageAdded } from "./frames.js";

export type ApprovalAgent = Pick<
  typeof qingagentAgent,
  "approveToolCall" | "declineToolCall"
>;

class ConfirmedCommandCancelledError extends Error {
  constructor(readonly toolCallId: string) {
    super("confirmed command cancelled by user");
    this.name = "ConfirmedCommandCancelledError";
  }
}

/** 仅当 toolCallId 正是当前确认恢复执行者时才 abort，绝不误停同会话其他命令。 */
export function cancelConfirmedCommand(
  session: SessionState,
  toolCallId: string,
): boolean {
  const controller = session._abortController;
  if (
    session._activeConfirmedToolCallId !== toolCallId ||
    !controller ||
    controller.signal.aborted
  ) {
    return false;
  }
  controller.abort(new ConfirmedCommandCancelledError(toolCallId));
  return true;
}

export function failConfirmedToolCall(
  session: SessionState,
  toolCallId: string,
  reason: string,
  options: { retriable?: boolean } = {},
): { messageId: string; spec: ToolCallSpec } | null {
  for (const message of session.chatHistory) {
    const index = message.parts.findIndex(
      (part) => part.kind === "toolCall" && part.data.id === toolCallId,
    );
    const part = message.parts[index];
    if (index < 0 || part?.kind !== "toolCall") continue;
    const spec = alignCommandCardWithStatus({
      ...part.data,
      status: { kind: "failed", data: { retriable: options.retriable ?? false, reason } },
      result: part.data.result ?? { kind: "genericText", data: reason },
    });
    message.parts[index] = { kind: "toolCall", data: spec };
    return { messageId: message.id, spec };
  }
  return null;
}

function findToolCallMessageId(session: SessionState, toolCallId: string): string | null {
  return session.chatHistory.find((message) => message.parts.some(
    (part) => part.kind === "toolCall" && part.data.id === toolCallId,
  ))?.id ?? null;
}

function appendMissingFailedToolCall(
  session: SessionState,
  pending: PendingConfirm,
  reason: string,
): ChatMessage {
  const spec: ToolCallSpec = {
    id: pending.toolCallId,
    name: pending.toolName,
    render: { kind: "chatInline" },
    status: { kind: "failed", data: { retriable: false, reason } },
    body: pending.toolName === WORKSPACE_TOOLS.SANDBOX.EXECUTE_COMMAND
      ? {
          kind: "commandCard",
          data: {
            title: pending.spec.title,
            icon: pending.spec.kind === "install" ? "📦" : "⚙️",
            command: pending.spec.commandPreview ?? "",
            exitCode: -1,
            outputTail: reason,
            phase: "failed",
          },
        }
      : { kind: "generic", data: { argsJson: "" } },
    result: { kind: "genericText", data: reason },
  };
  const message: ChatMessage = {
    id: crypto.randomUUID(),
    role: { kind: "agent" },
    ts: new Date().toISOString(),
    parts: [{ kind: "toolCall", data: spec }],
    chips: null,
  };
  session.chatHistory.push(message);
  return message;
}

function buildResumeTools(session: SessionState): Promise<{
  sessionScoped: ToolsInput;
  capabilityTools: ToolsInput;
}> {
  const sessionTools = createSessionScopedTools(session);
  const sessionScoped: ToolsInput = {
    readMaterial: sessionTools.readMaterial,
    summarizeMaterial: sessionTools.summarizeMaterial,
    readDraft: sessionTools.readDraftAiIr,
    editDraft: sessionTools.editDraft,
    readDiff: sessionTools.readDiff,
  };
  if (sessionTools.executeCommand) {
    sessionScoped[WORKSPACE_TOOLS.SANDBOX.EXECUTE_COMMAND] = sessionTools.executeCommand;
  }
  if (sessionTools.writeDraft) sessionScoped.writeDraft = sessionTools.writeDraft;
  if (sessionTools.updateWorkingMemory) {
    sessionScoped.updateWorkingMemory = sessionTools.updateWorkingMemory;
  }
  return buildCapabilityTools().then((capabilityTools) => ({
    sessionScoped,
    capabilityTools,
  }));
}

function safeResumeRequestContext(
  session: SessionState,
  pending: PendingConfirm,
  streamId: string,
  signal: AbortSignal,
): RequestContext {
  // 决策对象、ConfirmSpec、确认文案、option/secret/nonce 均不进入模型或工具上下文。
  return new RequestContext([
    ["materials", session.materials],
    ["messages", session.messages],
    [MASTRA_THREAD_ID_KEY, session.threadId ?? session.sessionId],
    ["sessionId", session.sessionId],
    ["streamId", streamId],
    ["runId", pending.runId],
    ["abortSignal", signal],
    ["clientTraceId", session.clientTraceId ?? null],
    ["origin", session.origin ?? "manual"],
    ["docVersion", session.docVersion],
    ["doc", session.doc],
    ["legacySections", session.legacySections],
    ["patchValidationResults", session.patchValidationResults],
    ["modelOverrides", session.modelOverrides],
  ]);
}

/** 用户点击与 stored grant 共用的唯一 Mastra approval 恢复执行体。 */
export async function* resumeConfirmDecision(input: {
  session: SessionState;
  pending: PendingConfirm;
  decisionId: string;
  accepted: boolean;
  resolution: "accepted" | "rejected";
  service: ConfirmService;
  agent?: ApprovalAgent;
  emitResolvedFrame?: boolean;
}): AsyncGenerator<BridgeFrame> {
  const { session, pending, service } = input;
  const agent = input.agent ?? qingagentAgent;
  const streamId = crypto.randomUUID();
  const abortController = new AbortController();
  const previousStreamId = session.streamId;
  const previousAbortController = session._abortController;
  const previousActiveConfirmedToolCallId = session._activeConfirmedToolCallId;
  const agentMessageId = findToolCallMessageId(session, pending.toolCallId);
  if (!agentMessageId) {
    const reason = "确认没有完成，命令没有执行。请重新确认后再试。";
    const failedMessage = appendMissingFailedToolCall(session, pending, reason);
    await service.failDecision(session, pending).catch(() => undefined);
    yield chatMessageAdded(failedMessage);
    if (input.emitResolvedFrame !== false) {
      yield service.resolvedFrame(pending, "failed", reason);
    }
    yield* emitProjectedDocState(session, "confirm_resume_missing_message");
    await schedulePersist(session, "confirm:missing_message_failed").catch(() => undefined);
    return;
  }

  session.streamId = streamId;
  session._abortController = abortController;
  session._activeConfirmedToolCallId = pending.toolCallId;
  let resolvedEmitted = false;
  yield { kind: "stream", data: { kind: "start", data: { streamId } } };

  try {
    if (
      input.accepted &&
      pending.toolName === WORKSPACE_TOOLS.SANDBOX.EXECUTE_COMMAND
    ) {
      // 进入这一条 FIFO 槽位就立刻从“已确认，排队执行”切成“处理中”，
      // 不再等待 buildResumeTools / Mastra approveToolCall 返回。
      yield {
        kind: "toolCallUpdated",
        data: {
          messageId: agentMessageId,
          toolCallId: pending.toolCallId,
          spec: confirmedCommandCardSpec(pending, "running"),
        },
      };
    }
    const toolsets = await buildResumeTools(session);
    const requestContext = safeResumeRequestContext(
      session,
      pending,
      streamId,
      abortController.signal,
    );
    const commonOptions = {
      runId: pending.runId,
      toolCallId: pending.toolCallId,
      maxSteps: AGENT_MAX_STEPS,
      requestContext,
      abortSignal: abortController.signal,
      toolsets,
    };
    const result = input.accepted
      ? await agent.approveToolCall(commonOptions)
      : await agent.declineToolCall(commonOptions);

    if (input.emitResolvedFrame !== false) {
      yield service.resolvedFrame(pending, input.resolution);
      resolvedEmitted = true;
      yield* emitProjectedDocState(session, "confirm_resolved");
    }
    const outcome = yield* processAgentStream(result.fullStream, {
      state: session,
      agentMessageId,
      streamId,
      runId: result.runId,
      requestContext,
      abortController,
      confirmService: service,
    });
    if (abortController.signal.reason instanceof ConfirmedCommandCancelledError) {
      throw abortController.signal.reason;
    }
    await service.finishDecision(session, pending, input.decisionId, input.resolution)
      .catch(() => undefined);

    for (const stored of outcome.storedGrantApprovals) {
      yield* resumeConfirmDecision({
        session,
        pending: stored.pending,
        decisionId: stored.decisionId,
        accepted: true,
        resolution: "accepted",
        service,
        agent,
        emitResolvedFrame: false,
      });
    }
  } catch (error) {
    await service.failDecision(session, pending).catch(() => undefined);
    const targetedCancellation =
      error instanceof ConfirmedCommandCancelledError ||
      abortController.signal.reason instanceof ConfirmedCommandCancelledError;
    const reason = targetedCancellation
      ? "已中止，结果可能未知"
      : resolvedEmitted
        ? "确认已提交，但还没有收到命令结果。为避免重复操作，系统没有自动重试；请先查看命令输出，再决定是否重新执行。"
        : "确认没有完成，命令没有执行。请重新确认后再试。";
    const failed = failConfirmedToolCall(session, pending.toolCallId, reason);
    if (failed) {
      yield {
        kind: "toolCallUpdated",
        data: {
          messageId: failed.messageId,
          toolCallId: pending.toolCallId,
          spec: failed.spec,
        },
      };
    }
    if (!resolvedEmitted && input.emitResolvedFrame !== false) {
      yield service.resolvedFrame(
        pending,
        targetedCancellation ? "aborted" : "failed",
        reason,
      );
    }
  } finally {
    if (session.streamId === streamId) session.streamId = previousStreamId;
    if (session._abortController === abortController) {
      session._abortController = previousAbortController;
    }
    if (session._activeConfirmedToolCallId === pending.toolCallId) {
      session._activeConfirmedToolCallId = previousActiveConfirmedToolCallId;
    }
    for (const update of finalizeLingeringRunningToolCalls(session)) {
      yield {
        kind: "toolCallUpdated",
        data: {
          messageId: update.messageId,
          toolCallId: update.toolCallId,
          spec: update.spec,
        },
      };
    }
    yield* emitProjectedDocState(session, "confirm_resume_finished");
    yield { kind: "stream", data: { kind: "end", data: { streamId, reason: { kind: "done" } } } };
    await schedulePersist(session, "confirm:runtime_finally").catch(() => undefined);
  }
}
