import type { BridgeFrame, ToolCallSpec } from "@qingagent/contract-ts";
import { MASTRA_THREAD_ID_KEY, RequestContext } from "@mastra/core/request-context";
import { WORKSPACE_TOOLS } from "@mastra/core/workspace";
import type { ToolsInput } from "@mastra/core/agent";
import crypto from "node:crypto";
import {
  AGENT_MAX_STEPS,
  ConfirmDecisionError,
  buildCapabilityTools,
  confirmService,
  createSessionScopedTools,
  emitProjectedDocState,
  finalizeLingeringRunningToolCalls,
  processAgentStream,
  qingagentAgent,
  schedulePersist,
  type ConfirmService,
  type PendingConfirm,
  type SafeSubmitConfirmDecision,
  type SessionState,
} from "./bridgeCore";

type ApprovalAgent = Pick<
  typeof qingagentAgent,
  "approveToolCall" | "declineToolCall"
>;

export interface ConfirmRuntimeDependencies {
  agent?: ApprovalAgent;
  service?: ConfirmService;
  getSession?: (sessionId: string) => Promise<SessionState | undefined>;
}

async function defaultGetSession(sessionId: string): Promise<SessionState | undefined> {
  // sessionLifecycle 负责 timer/recovery，动态取用避免它与 confirmRuntime 形成静态 ESM 环。
  const { getOrRestoreSession } = await import("./sessionLifecycle");
  return getOrRestoreSession(sessionId);
}

function findToolCallMessageId(session: SessionState, toolCallId: string): string | null {
  return session.chatHistory.find((message) => message.parts.some(
    (part) => part.kind === "toolCall" && part.data.id === toolCallId,
  ))?.id ?? null;
}

function failToolCall(session: SessionState, toolCallId: string, reason: string): {
  messageId: string;
  spec: ToolCallSpec;
} | null {
  for (const message of session.chatHistory) {
    const index = message.parts.findIndex(
      (part) => part.kind === "toolCall" && part.data.id === toolCallId,
    );
    const part = message.parts[index];
    if (index < 0 || part?.kind !== "toolCall") continue;
    const spec: ToolCallSpec = {
      ...part.data,
      status: { kind: "failed", data: { retriable: false, reason } },
      result: part.data.result ?? { kind: "genericText", data: reason },
    };
    message.parts[index] = { kind: "toolCall", data: spec };
    return { messageId: message.id, spec };
  }
  return null;
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
  // 决策对象、ConfirmSpec、确认文案、option/secret 均不进入模型/工具上下文。
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

/** 同一 SessionActor 内运行；绝不 fresh-turn，也不把决策拼成 prompt/resumeData。 */
export async function* handleConfirmDecision(
  submission: SafeSubmitConfirmDecision,
  dependencies: ConfirmRuntimeDependencies = {},
): AsyncGenerator<BridgeFrame> {
  const service = dependencies.service ?? confirmService;
  const agent = dependencies.agent ?? qingagentAgent;
  const session = await (dependencies.getSession ?? defaultGetSession)(submission.sessionId);
  if (!session) throw new ConfirmDecisionError("not_found", "没有可处理的确认请求");

  const begun = await service.beginDecision(session, submission);
  if (begun.idempotent) return;
  const { pending, resolution } = begun;
  const streamId = crypto.randomUUID();
  const abortController = new AbortController();
  const previousStreamId = session.streamId;
  const previousAbortController = session._abortController;
  const agentMessageId = findToolCallMessageId(session, pending.toolCallId);
  if (!agentMessageId) {
    await service.failDecision(session, pending);
    yield service.resolvedFrame(pending, "failed", "确认恢复失败，命令未执行");
    return;
  }

  session.streamId = streamId;
  session._abortController = abortController;
  let resolvedEmitted = false;
  yield { kind: "stream", data: { kind: "start", data: { streamId } } };

  try {
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
    const result = submission.decision.accepted
      ? await agent.approveToolCall(commonOptions)
      : await agent.declineToolCall(commonOptions);

    yield service.resolvedFrame(pending, resolution);
    resolvedEmitted = true;
    yield* emitProjectedDocState(session, "confirm_resolved");
    yield* processAgentStream(result.fullStream, {
      state: session,
      agentMessageId,
      streamId,
      runId: result.runId,
      requestContext,
      abortController,
    });
    // 执行已结束后 proof 必已消费/清除；终态持久化失败也不能重放命令。
    await service.finishDecision(session, pending, submission.decisionId, resolution)
      .catch(() => undefined);
  } catch {
    // snapshot/恢复/工具链任一错误都只关闭卡并拒绝；绝不走 askUser 的 fresh-turn。
    await service.failDecision(session, pending).catch(() => undefined);
    const reason = resolvedEmitted
      ? "确认恢复异常，执行结果未知且未自动重试"
      : "确认恢复失败，命令未执行";
    const failed = failToolCall(session, pending.toolCallId, reason);
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
    if (!resolvedEmitted) yield service.resolvedFrame(pending, "failed", reason);
  } finally {
    if (session.streamId === streamId) session.streamId = previousStreamId;
    if (session._abortController === abortController) {
      session._abortController = previousAbortController;
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

export async function* handleConfirmExpiry(
  sessionId: string,
  toolCallId: string,
  dependencies: ConfirmRuntimeDependencies = {},
): AsyncGenerator<BridgeFrame> {
  const service = dependencies.service ?? confirmService;
  const agent = dependencies.agent ?? qingagentAgent;
  const session = await (dependencies.getSession ?? defaultGetSession)(sessionId);
  const pending = session?.pendingConfirms.get(toolCallId);
  if (!session || !pending || pending.status !== "pending") return;
  if (Date.parse(pending.expiresAt) > Date.now()) return;

  try {
    const result = await agent.declineToolCall({
      runId: pending.runId,
      toolCallId: pending.toolCallId,
      maxSteps: 1,
    });
    for await (const _chunk of result.fullStream) {
      // 消费流以完成 Mastra snapshot 清理；不把其输出写入 qingagent 会话。
    }
  } catch {
    // proof/secret 仍会在下方清理，snapshot 清理失败也绝不放行。
  }

  const reason = "确认已过期，命令未执行";
  await service.expireDecision(session, pending).catch(() => undefined);
  const failed = failToolCall(session, pending.toolCallId, reason);
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
  yield service.resolvedFrame(pending, "expired", reason);
  yield* emitProjectedDocState(session, "confirm_expired");
}
