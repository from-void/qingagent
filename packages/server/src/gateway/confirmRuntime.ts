import type { BridgeFrame, ToolCallSpec } from "@qingagent/contract-ts";
import { MASTRA_THREAD_ID_KEY, RequestContext } from "@mastra/core/request-context";
import { WORKSPACE_TOOLS } from "@mastra/core/workspace";
import type { ToolsInput } from "@mastra/core/agent";
import crypto from "node:crypto";
import {
  AGENT_MAX_STEPS,
  ConfirmDecisionError,
  buildCapabilityTools,
  beginTurnOwnership,
  bindTurnOwnershipToRequestContext,
  confirmService,
  createSessionScopedTools,
  emitProjectedDocState,
  endTurnOwnership,
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
  persistSession?: (session: SessionState, reason: string) => Promise<void>;
  expiryTimeoutMs?: number;
}

const CONFIRM_EXPIRY_WALL_TIMEOUT_MS = 5_000;

type ConfirmSessionResolver = (sessionId: string) => Promise<SessionState | undefined>;

// sessionLifecycle 负责 timer/recovery 且已静态依赖本模块;反向不 import(连动态 import 也构成
// 依赖环),由它在模块装配时注册解析器。未注册时按会话不存在处理(fail-closed)。
let registeredSessionResolver: ConfirmSessionResolver | null = null;

export function registerConfirmSessionResolver(resolver: ConfirmSessionResolver): void {
  registeredSessionResolver = resolver;
}

async function defaultGetSession(sessionId: string): Promise<SessionState | undefined> {
  return registeredSessionResolver?.(sessionId);
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

function createCompletion(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function abortError(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason;
  const error = new Error(
    typeof signal.reason === "string" ? signal.reason : "Operation aborted",
  );
  error.name = "AbortError";
  return error;
}

async function withWallClockTimeout<T>(
  operation: Promise<T>,
  controller: AbortController,
  timeoutMs: number,
  label: string,
): Promise<T> {
  return await new Promise<T>((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout>;
    const cleanup = () => {
      clearTimeout(timer);
      controller.signal.removeEventListener("abort", onAbort);
    };
    const settleResolved = (value: T) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };
    const settleRejected = (error: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const onAbort = () => settleRejected(abortError(controller.signal));
    timer = setTimeout(() => {
      const error = new Error(`${label} timed out after ${timeoutMs}ms`);
      settleRejected(error);
      controller.abort(error);
    }, timeoutMs);
    timer.unref?.();
    controller.signal.addEventListener("abort", onAbort, { once: true });
    operation.then(settleResolved, settleRejected);
    if (controller.signal.aborted) onAbort();
  });
}

async function consumeFullStreamWithTimeout(
  fullStream: AsyncIterable<unknown>,
  controller: AbortController,
  timeoutMs: number,
): Promise<void> {
  const iterator = fullStream[Symbol.asyncIterator]();
  const consume = (async () => {
    for (;;) {
      const next = await iterator.next();
      if (next.done) return;
    }
  })();
  try {
    await withWallClockTimeout(
      consume,
      controller,
      timeoutMs,
      "confirm expiry fullStream",
    );
  } catch (error) {
    void Promise.resolve()
      .then(() => iterator.return?.())
      .catch(() => undefined);
    throw error;
  }
}

/** 同一 SessionActor 内运行；绝不 fresh-turn，也不把决策拼成 prompt/resumeData。 */
export async function* handleConfirmDecision(
  submission: SafeSubmitConfirmDecision,
  dependencies: ConfirmRuntimeDependencies = {},
): AsyncGenerator<BridgeFrame> {
  const service = dependencies.service ?? confirmService;
  const agent = dependencies.agent ?? qingagentAgent;
  const persistSession = dependencies.persistSession ?? schedulePersist;
  const session = await (dependencies.getSession ?? defaultGetSession)(submission.sessionId);
  if (!session) throw new ConfirmDecisionError("not_found", "没有可处理的确认请求");

  const begun = await service.beginDecision(session, submission);
  if (begun.idempotent) return;
  const { pending, resolution } = begun;
  const streamId = crypto.randomUUID();
  const abortController = new AbortController();
  const previousStreamId = session.streamId;
  const previousAbortController = session._abortController;
  const previousActiveTurnPromise = session._activeTurnPromise;
  const completion = createCompletion();
  const agentMessageId = findToolCallMessageId(session, pending.toolCallId);
  if (!agentMessageId) {
    await service.failDecision(session, pending);
    yield service.resolvedFrame(pending, "failed", "确认恢复失败，命令未执行");
    return;
  }

  const turnOwnership = beginTurnOwnership(
    session,
    `${streamId}:confirm:${pending.toolCallId}`,
  );
  session.streamId = streamId;
  session._abortController = abortController;
  session._activeTurnPromise = completion.promise;
  let resolvedEmitted = false;

  try {
    yield { kind: "stream", data: { kind: "start", data: { streamId } } };
    const toolsets = await buildResumeTools(session);
    const requestContext = safeResumeRequestContext(
      session,
      pending,
      streamId,
      abortController.signal,
    );
    bindTurnOwnershipToRequestContext(requestContext, turnOwnership);
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
    // 批准命令进入执行期:把工具卡从空占位(u-prep"正在准备")换成运行中的 commandCard,
    // 展示已脱敏的命令预览。慢命令(如 npx/git clone)期间不再误显"正在准备"像卡死。
    // 安全:只用 pending.spec.commandPreview(ConfirmService 已脱敏截断),绝不放原始 args。
    if (
      submission.decision.accepted &&
      pending.toolName === WORKSPACE_TOOLS.SANDBOX.EXECUTE_COMMAND
    ) {
      const runningCard: ToolCallSpec = {
        id: pending.toolCallId,
        name: pending.toolName,
        render: { kind: "chatInline" },
        status: { kind: "running", data: { progressPct: null, etaSec: null } },
        body: {
          kind: "commandCard",
          data: {
            title: pending.spec.title,
            icon:
              pending.spec.kind === "install"
                ? "📦"
                : pending.spec.kind === "send"
                  ? "📤"
                  : "⚙️",
            command: pending.spec.commandPreview ?? "",
            exitCode: 0,
            outputTail: "",
            phase: "running",
          },
        },
        result: null,
      };
      yield {
        kind: "toolCallUpdated",
        data: {
          messageId: agentMessageId,
          toolCallId: pending.toolCallId,
          spec: runningCard,
        },
      };
    }
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
    await persistSession(session, "confirm:runtime_finally").catch(() => undefined);
    endTurnOwnership(session, turnOwnership);
    completion.resolve();
    if (session._activeTurnPromise === completion.promise) {
      session._activeTurnPromise = previousActiveTurnPromise;
    }
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

  const timeoutMs = dependencies.expiryTimeoutMs ??
    CONFIRM_EXPIRY_WALL_TIMEOUT_MS;
  const abortController = new AbortController();
  const previousAbortController = session._abortController;
  const previousActiveTurnPromise = session._activeTurnPromise;
  const completion = createCompletion();
  const turnOwnership = beginTurnOwnership(
    session,
    `confirm-expiry:${pending.toolCallId}`,
  );
  session._abortController = abortController;
  session._activeTurnPromise = completion.promise;

  try {
    try {
      const result = await withWallClockTimeout(
        agent.declineToolCall({
          runId: pending.runId,
          toolCallId: pending.toolCallId,
          maxSteps: 1,
          abortSignal: abortController.signal,
        }),
        abortController,
        timeoutMs,
        "confirm expiry declineToolCall",
      );
      await consumeFullStreamWithTimeout(
        result.fullStream,
        abortController,
        timeoutMs,
      );
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
  } finally {
    endTurnOwnership(session, turnOwnership);
    completion.resolve();
    if (session._abortController === abortController) {
      session._abortController = previousAbortController;
    }
    if (session._activeTurnPromise === completion.promise) {
      session._activeTurnPromise = previousActiveTurnPromise;
    }
  }
}
