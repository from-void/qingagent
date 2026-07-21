import type { BridgeFrame, ToolCallSpec } from "@qingagent/contract-ts";
import type { ConfirmGrant } from "@qingagent/db";
import type { ToolsInput } from "@mastra/core/agent";
import { MASTRA_THREAD_ID_KEY, RequestContext } from "@mastra/core/request-context";
import { WORKSPACE_TOOLS } from "@mastra/core/workspace";
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
  resumeConfirmDecision,
  schedulePersist,
  type ApprovalAgent,
  type ConfirmService,
  type PendingConfirm,
  type SafeSubmitConfirmDecision,
  type SessionState,
} from "./bridgeCore";

export interface ConfirmRuntimeDependencies {
  agent?: ApprovalAgent;
  service?: ConfirmService;
  getSession?: (sessionId: string) => Promise<SessionState | undefined>;
  persistSession?: (session: SessionState, reason: string) => Promise<void>;
  expiryTimeoutMs?: number;
  resumeTimeoutMs?: number;
  persistTimeoutMs?: number;
  /** 决策完成上下文校验后执行；失败只放弃记忆，不能吞掉用户本次决策。 */
  onAccepted?: (pending: PendingConfirm) => Promise<ConfirmGrant | null>;
  declineTimeoutMs?: number;
}

const CONFIRM_EXPIRY_WALL_TIMEOUT_MS = 5_000;
const CONFIRM_RESUME_WALL_TIMEOUT_MS = 120_000;
const CONFIRM_PERSIST_TIMEOUT_MS = 5_000;
export const CONFIRM_DECLINE_CLEANUP_TIMEOUT_MS = 1_500;

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

function failToolCall(
  session: SessionState,
  toolCallId: string,
  reason: string,
  options: { retriable?: boolean } = {},
): {
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
      status: { kind: "failed", data: { retriable: options.retriable ?? false, reason } },
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

async function* forwardWithWallClockTimeout<T, TReturn>(
  iterable: { [Symbol.asyncIterator](): AsyncIterator<T, TReturn> },
  controller: AbortController,
  timeoutMs: number,
  label: string,
): AsyncGenerator<T, TReturn> {
  const iterator = iterable[Symbol.asyncIterator]();
  const deadline = Date.now() + timeoutMs;
  try {
    for (;;) {
      const remainingMs = Math.max(0, deadline - Date.now());
      const next = await withWallClockTimeout(
        iterator.next(),
        controller,
        remainingMs,
        label,
      );
      if (next.done) return next.value;
      yield next.value;
    }
  } catch (error) {
    void Promise.resolve()
      .then(() => iterator.return?.())
      .catch(() => undefined);
    throw error;
  }
}

async function withNonAbortableTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  return await new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    timer.unref?.();
    operation.then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

const backgroundPersistenceRetries = new WeakMap<
  SessionState,
  Map<string, Promise<void>>
>();

function clearPersistenceDirtyReason(
  session: SessionState,
  key: string,
): void {
  session._confirmPersistenceDirtyReasons.delete(key);
}

function scheduleBackgroundPersistenceRetry(
  session: SessionState,
  key: string,
  operation: () => Promise<void>,
): void {
  let retries = backgroundPersistenceRetries.get(session);
  if (!retries) {
    retries = new Map();
    backgroundPersistenceRetries.set(session, retries);
  }
  if (retries.has(key)) return;

  const task = Promise.resolve()
    .then(operation)
    .then(() => {
      clearPersistenceDirtyReason(session, key);
    })
    .catch(() => undefined);
  retries.set(key, task);
  void task.then(() => {
    const current = backgroundPersistenceRetries.get(session);
    if (current?.get(key) !== task) return;
    current.delete(key);
    if (current.size === 0) backgroundPersistenceRetries.delete(session);
  });
}

async function persistWithDeadline(
  session: SessionState,
  key: string,
  operation: () => Promise<void>,
  timeoutMs: number,
): Promise<void> {
  const attempt = Promise.resolve().then(operation);
  // 超时后原 promise 仍可能晚到；显式消费并在成功时清 dirty，避免 unhandled rejection。
  void attempt.then(
    () => clearPersistenceDirtyReason(session, key),
    () => undefined,
  );
  try {
    await withNonAbortableTimeout(attempt, timeoutMs, key);
    clearPersistenceDirtyReason(session, key);
  } catch {
    session._confirmPersistenceDirtyReasons.add(key);
    scheduleBackgroundPersistenceRetry(session, key, operation);
  }
}

async function settleOnceWithDeadline(
  operation: () => Promise<void>,
  timeoutMs: number,
  label: string,
): Promise<void> {
  try {
    await withNonAbortableTimeout(
      Promise.resolve().then(operation),
      timeoutMs,
      label,
    );
  } catch {
    // 审计写入本身已记录错误；超时后原 promise 仍继续，只是不阻塞 SessionActor。
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
  const resumeTimeoutMs = dependencies.resumeTimeoutMs ??
    CONFIRM_RESUME_WALL_TIMEOUT_MS;
  const persistTimeoutMs = dependencies.persistTimeoutMs ??
    CONFIRM_PERSIST_TIMEOUT_MS;
  const session = await (dependencies.getSession ?? defaultGetSession)(submission.sessionId);
  if (!session) throw new ConfirmDecisionError("not_found", "没有可处理的确认请求");

  const begun = await service.beginDecision(session, submission);
  if (begun.idempotent) return;
  const { pending, resolution } = begun;
  if (resolution !== "accepted" && resolution !== "rejected") {
    throw new ConfirmDecisionError("invalid", "确认决策结果无效");
  }
  if (submission.decision.accepted && dependencies.onAccepted) {
    try {
      const grant = await dependencies.onAccepted(pending);
      if (grant) service.attachRememberedGrant(pending, grant);
    } catch (error) {
      console.error("[confirm] remember grant persistence failed; decision continues", {
        sessionId: session.sessionId,
        confirmId: pending.confirmId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const streamId = crypto.randomUUID();
  const abortController = new AbortController();
  const previousStreamId = session.streamId;
  const previousAbortController = session._abortController;
  const previousActiveTurnPromise = session._activeTurnPromise;
  const completion = createCompletion();
  const agentMessageId = findToolCallMessageId(session, pending.toolCallId);
  if (!agentMessageId) {
    service.failDecisionInMemory(session, pending);
    await Promise.all([
      persistWithDeadline(
        session,
        "confirm:failed:missing_tool_card",
        () => service.persistDecisionState(session, "confirm:failed"),
        persistTimeoutMs,
      ),
      settleOnceWithDeadline(
        () => service.recordDecisionFailed(session, pending),
        persistTimeoutMs,
        "confirm:audit:failed:missing_tool_card",
      ),
    ]);
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
  let storedGrantApprovals: Array<{
    pending: PendingConfirm;
    decisionId: string;
  }> = [];
  let terminalPersistence:
    | { key: string; operation: () => Promise<void> }
    | null = null;
  let terminalAudit:
    | { key: string; operation: () => Promise<void> }
    | null = null;

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
    const result = await withWallClockTimeout(
      submission.decision.accepted
        ? agent.approveToolCall(commonOptions)
        : agent.declineToolCall(commonOptions),
      abortController,
      resumeTimeoutMs,
      submission.decision.accepted
        ? "confirm resume approveToolCall"
        : "confirm resume declineToolCall",
    );

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
    const outcome = yield* forwardWithWallClockTimeout(
      processAgentStream(result.fullStream, {
        state: session,
        agentMessageId,
        streamId,
        runId: result.runId,
        requestContext,
        abortController,
        confirmService: service,
      }),
      abortController,
      resumeTimeoutMs,
      "confirm resume fullStream",
    );
    storedGrantApprovals = outcome.storedGrantApprovals;
    // 执行已结束后 proof 必已消费/清除；终态持久化失败也不能重放命令。
    service.finishDecisionInMemory(
      session,
      pending,
      submission.decisionId,
      resolution,
    );
    terminalPersistence = {
      key: `confirm:${resolution}`,
      operation: () => service.persistDecisionState(
        session,
        `confirm:${resolution}`,
      ),
    };
    terminalAudit = {
      key: `confirm:audit:${resolution}`,
      operation: () => service.recordDecisionFinished(session, pending, resolution),
    };
  } catch {
    // snapshot/恢复/工具链任一错误都只关闭卡并拒绝；绝不走 askUser 的 fresh-turn。
    service.failDecisionInMemory(session, pending);
    terminalPersistence = {
      key: "confirm:failed",
      operation: () => service.persistDecisionState(session, "confirm:failed"),
    };
    terminalAudit = {
      key: "confirm:audit:failed",
      operation: () => service.recordDecisionFailed(session, pending),
    };
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
    endTurnOwnership(session, turnOwnership);
    completion.resolve();
    if (session._activeTurnPromise === completion.promise) {
      session._activeTurnPromise = previousActiveTurnPromise;
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
    await Promise.all([
      ...(terminalPersistence
        ? [persistWithDeadline(
            session,
            terminalPersistence.key,
            terminalPersistence.operation,
            persistTimeoutMs,
          )]
        : []),
      ...(terminalAudit
        ? [settleOnceWithDeadline(
            terminalAudit.operation,
            persistTimeoutMs,
            terminalAudit.key,
          )]
        : []),
      persistWithDeadline(
        session,
        "confirm:runtime_finally",
        () => persistSession(session, "confirm:runtime_finally"),
        persistTimeoutMs,
      ),
    ]);
  }

  for (const stored of storedGrantApprovals) {
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
    dependencies.declineTimeoutMs ??
    CONFIRM_EXPIRY_WALL_TIMEOUT_MS;
  const persistTimeoutMs = dependencies.persistTimeoutMs ??
    CONFIRM_PERSIST_TIMEOUT_MS;
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
  let expiryTerminalized = false;
  let cleanupIncomplete = false;

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
      cleanupIncomplete = true;
    }

    const reason = cleanupIncomplete
      ? "确认已过期，命令未执行；确认状态清理未完成，可重试"
      : "确认已过期，命令未执行";
    service.expireDecisionInMemory(session, pending);
    expiryTerminalized = true;
    const failed = failToolCall(session, pending.toolCallId, reason, {
      retriable: cleanupIncomplete,
    });
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
    if (expiryTerminalized) {
      await Promise.all([
        persistWithDeadline(
          session,
          "confirm:expired",
          () => service.persistDecisionState(session, "confirm:expired"),
          persistTimeoutMs,
        ),
        settleOnceWithDeadline(
          () => service.recordDecisionExpired(session, pending),
          persistTimeoutMs,
          "confirm:audit:expired",
        ),
      ]);
    }
  }
}
