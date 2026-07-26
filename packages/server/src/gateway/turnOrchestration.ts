import type {
  BridgeFrame,
  ChatMessage,
  Command,
  DocState,
  MessagePart,
  ToolCallSpec,
} from "@qingagent/contract-ts";
import crypto from "node:crypto";
import { MASTRA_THREAD_ID_KEY, RequestContext } from "@mastra/core/request-context";
import {
  activeSuspensionOwnedBy,
  abortAndCleanupTurn,
  AGENT_MAX_STEPS,
  appendAskUserAnswerMessageIfMissing,
  askUserTool,
  beginSessionSnapshotTurn,
  beginTurnOwnership,
  bindTurnOwnershipToRequestContext,
  buildAgentTracingMetadata,
  buildCapabilityTools,
  buildTodoAwarenessContent,
  buildVisibleAskUserAnswerMessage,
  clearStaleSuspensionIfInactive,
  clearSuspension,
  createSessionScopedTools,
  deriveContentState,
  emitProjectedDocState,
  enrichAskUserResumeAnswersWithLabels,
  ensureWorkingMemorySnapshot,
  endTurnOwnership,
  finalizeLingeringRunningToolCalls,
  guardContext,
  guardReset,
  hasActiveSuspension,
  hasVisibleAskUserAnswerMessage,
  isDirectionReset,
  isOmSidecarEnabled,
  isPlanDraftTool,
  isQuestionnaireTool,
  normalizeAskUserAnswers,
  normalizeQuestionnaireSpecForRestore,
  normalizeTargetDocState,
  prepareOmContextForTurn,
  processAgentStream,
  QINGAGENT_OM_OBSERVATIONS_REQUEST_CONTEXT_KEY,
  QINGAGENT_RESOURCE_ID,
  QINGAGENT_WORKING_MEMORY_REQUEST_CONTEXT_KEY,
  qingagentAgent,
  redactSensitiveText,
  resolveModelParams,
  runAgentTurn,
  scheduleOmSidecarAfterTurn,
  schedulePersist,
  serializeReviewOutcome,
  terminalizeAskUserToolCall,
  TODO_AWARENESS_REQUEST_CONTEXT_KEY,
  transitionDocState,
  withPrefixCacheGuardContext,
  type SessionState,
} from "./bridgeCore";
import { bindClientTraceId, deriveSessionTraceId } from "./commandTracing";
import type { CommandExecutionContext } from "./commandTypes";
import { findSessionByStream, getOrRestoreSession } from "./sessionLifecycle";
import { bindToolsToAbortSignal } from "./abortableTools";

async function* handleCancelAskUser(
  session: SessionState,
  toolCallId: string,
): AsyncGenerator<BridgeFrame> {
  // 幂等：首个取消已经把该问卷持久化为相同 failed 终态时，重复请求直接成功。
  // 这覆盖浏览器重试、代理重放，以及“响应丢了但服务端已完成”的场景。
  for (const message of session.chatHistory) {
    const cancelled = message.parts.some(
      (part) =>
        part.kind === "toolCall" &&
        part.data.id === toolCallId &&
        isQuestionnaireTool(part.data.name) &&
        part.data.status.kind === "failed" &&
        part.data.status.data.reason === "用户已放弃本轮问卷",
    );
    if (cancelled) {
      await schedulePersist(session, "cancelAskUser");
      return;
    }
  }
  const hasSuspension = hasActiveSuspension(session);
  const hasMatchingSuspension = hasSuspension && session.toolCallId === toolCallId;
  if (hasSuspension && !hasMatchingSuspension) {
    throw new Error("没有待放弃的问卷");
  }
  if (!hasMatchingSuspension && !canAbortRunningAskUser(session, toolCallId)) {
    throw new Error("没有待放弃的问卷");
  }

  const terminalized = terminalizeAskUserToolCall(
    session,
    toolCallId,
    "用户已放弃本轮问卷",
  );
  if (!terminalized) {
    throw new Error(`No pending askUser toolCall: ${toolCallId}`);
  }

  yield {
    kind: "toolCallUpdated",
    data: {
      messageId: terminalized.messageId,
      toolCallId: terminalized.toolCallId,
      spec: terminalized.spec,
    },
  };

  if (!hasMatchingSuspension) {
    // running(尚未挂起)态点放弃:abort 与 Mastra 的 askUser 挂起会抢跑,挂起常在 abort
    // 之后才落地、被错投影成"新问卷"。标记该 toolCallId,让挂起处理处命中即丢弃,回 idle。
    (session._abandonedAskUserToolCallIds ??= new Set()).add(toolCallId);
    yield* abortAndCleanupTurn(session, { emitStreamEnd: false });
  } else {
    clearSuspension(session);
    transitionDocState(
      session,
      normalizeTargetDocState(
        session,
        session.previousDocState ?? deriveContentState(session),
        "ask_user_abandoned",
      ),
      "ask_user_abandoned",
      { mode: "normalize" },
    );
    yield* emitProjectedDocState(session, "ask_user_abandoned");
  }

  // 取消终态必须可恢复。schedulePersist 自身会保留 dirty 并做有界重试；
  // 重试耗尽后继续向 actor 抛出，让其广播/返回 draftingFailed，不能只打日志
  // 却把前台命令伪装成成功。
  try {
    await schedulePersist(session, "cancelAskUser");
  } catch (err) {
    console.error(
      "[cancelAskUser] Persist after cancel failed:",
      err instanceof Error ? err.message : String(err),
    );
    throw err;
  }
}

function canAbortRunningAskUser(session: SessionState, toolCallId: string): boolean {
  if (session.streamId === null) return false;
  for (const message of session.chatHistory) {
    for (const part of message.parts) {
      if (
        part.kind === "toolCall" &&
        part.data.id === toolCallId &&
        isQuestionnaireTool(part.data.name) &&
        (part.data.status.kind === "pending" || part.data.status.kind === "running")
      ) {
        return true;
      }
    }
  }
  return false;
}

function isSnapshotNotFoundError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.message.includes("AGENT_RESUME_NO_SNAPSHOT_FOUND") ||
      error.message.includes("could not find a suspended run"))
  );
}

function delayWithSignal(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function isAskUserQuestionSpec(spec: ToolCallSpec): boolean {
  return isQuestionnaireTool(spec.name) && spec.body?.kind === "askUser";
}

function findAskUserToolCallSpec(
  session: SessionState,
  toolCallId: string | null,
): ToolCallSpec | null {
  if (!toolCallId) return null;
  for (const message of session.chatHistory) {
    for (const part of message.parts) {
      if (
        part.kind === "toolCall" &&
        part.data.id === toolCallId &&
        isAskUserQuestionSpec(part.data)
      ) {
        const normalized = normalizeQuestionnaireSpecForRestore(part.data);
        part.data = normalized;
        return normalized;
      }
    }
  }
  return null;
}

function applySubmittedAskUserToolCallId(
  session: SessionState,
  submittedToolCallId: string | null | undefined,
): void {
  if (!submittedToolCallId || submittedToolCallId === session.toolCallId) return;
  const submittedSpec = findAskUserToolCallSpec(session, submittedToolCallId);
  if (!submittedSpec) {
    return;
  }
  if (!isQuestionnaireTool(submittedSpec.name)) return;
  session.toolCallId = submittedToolCallId;
  if (session._suspensionOwner && isQuestionnaireTool(session._suspensionOwner.toolName)) {
    session._suspensionOwner = {
      ...session._suspensionOwner,
      toolCallId: submittedToolCallId,
      toolName: submittedSpec.name,
    };
  }
}

function markAskUserToolCallAnsweredForResume(
  session: SessionState,
  toolCallId: string | null,
  answersRecord: ReturnType<typeof normalizeAskUserAnswers>,
): { messageId: string; toolCallId: string; spec: ToolCallSpec } | null {
  if (!toolCallId) return null;
  for (const message of session.chatHistory) {
    for (let index = 0; index < message.parts.length; index += 1) {
      const part = message.parts[index];
      if (
        part?.kind !== "toolCall" ||
        part.data.id !== toolCallId ||
        !isAskUserQuestionSpec(part.data)
      ) {
        continue;
      }
      if (part.data.status.kind === "done") return null;
      const spec: ToolCallSpec = {
        ...part.data,
        status: { kind: "done" },
        result:
          Object.keys(answersRecord).length > 0
            ? { kind: "askUserAnswers", data: answersRecord }
            : { kind: "genericText", data: "已提交" },
      };
      message.parts[index] = { kind: "toolCall", data: spec };
      return { messageId: message.id, toolCallId, spec };
    }
  }
  return null;
}

function formatChatHistoryForFreshResume(session: SessionState): string {
  const lines: string[] = [];
  for (const message of session.chatHistory) {
    const role = message.role.kind === "user" ? "用户" : "助手";
    const parts: string[] = [];
    for (const part of message.parts) {
      if (part.kind === "text" && part.data.body.trim().length > 0) {
        parts.push(part.data.body.trim());
      }
      if (part.kind === "toolCall") {
        parts.push(`[工具:${part.data.name} ${part.data.status.kind}]`);
      }
    }
    if (parts.length > 0) {
      lines.push(`${role}: ${parts.join(" ")}`);
    }
  }
  return lines.slice(-12).join("\n");
}

function formatAskUserQuestions(spec: ToolCallSpec): string {
  if (spec.body.kind !== "askUser") {
    return "[]";
  }
  return JSON.stringify(spec.body.data.questions, null, 2);
}

function buildFreshAskUserResumePrompt(
  session: SessionState,
  spec: ToolCallSpec,
  resumeData: Record<string, unknown>,
): string {
  const history = formatChatHistoryForFreshResume(session);
  const questions = formatAskUserQuestions(spec);
  const answers = JSON.stringify(resumeData, null, 2);

  return [
    "[系统：上一轮 askUser 挂起的持久快照缺失，下面用 fresh turn 延续同一任务。]",
    "请基于已有历史、原问卷和用户本次答案继续完成原任务；不要要求用户重复填写同一份问卷，除非答案仍明显不足。",
    "",
    "【已有历史】",
    history || "（无可用历史摘要）",
    "",
    "【原问卷 questions】",
    questions,
    "",
    "【用户本次 answers】",
    answers,
  ].join("\n");
}

/**
 * Shared resume handler for resumeAskUser.
 *
 * Key safety invariant: we do NOT clear session.runId / session.toolCallId
 * before calling resumeStream. processAgentStream already clears them on
 * natural stream completion. If an askUser snapshot is missing, the handler
 * first consumes and clears the stale suspension, persists idle state, then
 * starts a fresh turn with the original questions and submitted answers.
 */
async function* handleResume(
  session: SessionState,
  resumeData: Record<string, unknown>,
  errorFallbackDocState: DocState,
): AsyncGenerator<BridgeFrame> {
  const { runId, toolCallId } = session;
  const streamId = crypto.randomUUID();
  const abortController = new AbortController();
  const turnOwnership = beginTurnOwnership(session, `${streamId}:resume`);
  let resolveActiveTurn!: () => void;
  const activeTurnPromise = new Promise<void>((resolve) => {
    resolveActiveTurn = resolve;
  });
  session.streamId = streamId;
  session._abortController = abortController;
  session._activeTurnPromise = activeTurnPromise;
  const omSidecarEnabled = isOmSidecarEnabled();
  // resume 只把 askUser 答案补回被挂起回合；不推进新的 OM turn。
  // 不传 currentTurn 锚点时，OM fallback 会把 [askUserAnswers:*] 辅助 user
  // 并回上一轮，避免后续普通 turn 重新映射旧消息 ID。
  const omResumeTurnIndex: number | null = null;
  const omResumeStartMessageIndex: number | null = null;
  // 在进入 resumeStream 重试循环前快照本次动作的 clientTraceId（已由 resume 类
  // 命令分发时 bindClientTraceId 设置）。若在重试退避期间有并发命令改写了
  // session.clientTraceId，本轮 resume 的框架 span 仍归属本动作而非后续动作。
  const resumeClientTraceId = session.clientTraceId ?? null;
  let freshTurnPrompt: string | null = null;
  let freshTurnAfterIdleTimeout = false;
  let resumeRequestContext: RequestContext | undefined;

  yield { kind: "stream", data: { kind: "start", data: { streamId } } };

  const askUserSpecForResume = findAskUserToolCallSpec(session, toolCallId);
  let visibleAnswerMessageAdded = false;
  if (!hasVisibleAskUserAnswerMessage(session, toolCallId)) {
    // 先把用户已提交的可见答卷卡落进 chatHistory,再尝试 resumeStream。
    // 若后续缺 Mastra snapshot 走 fresh-turn 兜底,模型上下文会通过同一份答案 message 消费答案；
    // 可见卡只承担 UI 复原职责,幂等 id 保证不会重复插入。
    const visibleAnswerMessage = buildVisibleAskUserAnswerMessage(
      toolCallId,
      resumeData,
      askUserSpecForResume,
    );
    if (visibleAnswerMessage) {
      session.chatHistory.push(visibleAnswerMessage);
      visibleAnswerMessageAdded = true;
      yield {
        kind: "chatMessageAdded",
        data: { message: visibleAnswerMessage },
      };
    }
  }

  const agentMessageId = crypto.randomUUID();
  const agentMessage: ChatMessage = {
    id: agentMessageId,
    role: { kind: "agent" },
    ts: new Date().toISOString(),
    parts: [],
    chips: null,
  };
  yield {
    kind: "chatMessageAdded",
    data: { message: agentMessage },
  };
  session.chatHistory.push(agentMessage);

  try {
    const sessionTools = createSessionScopedTools(session);
    const capabilityTools = await buildCapabilityTools();
    // Retry resumeStream with back-off when the Mastra workflow snapshot
    // hasn't been persisted yet. This handles the race where
    // tool-call-suspended was processed (runId is set) but the underlying
    // suspend() call that persists the snapshot hasn't finished the I/O.
    const MAX_RESUME_RETRIES = 5;
    const RETRY_DELAY_MS = 500;
    let result: Awaited<ReturnType<typeof qingagentAgent.resumeStream>>;
    const resumeAnswers = normalizeAskUserAnswers(resumeData);
    const hasResumeAnswers = Object.keys(resumeAnswers).length > 0;
    const resumeToolName = askUserSpecForResume?.name ?? session._suspensionOwner?.toolName;
    const resumeWasDirectionReset = isDirectionReset(session);
    if (hasResumeAnswers && isPlanDraftTool(resumeToolName)) {
      session._askUserCompleted = true;
      if (resumeWasDirectionReset) {
        session._directionChangeAskedSinceLastWrite = true;
      }
    }
    let answerContextMessageAdded = false;
    if (
      appendAskUserAnswerMessageIfMissing(
        session,
        toolCallId,
        resumeData,
        askUserSpecForResume,
      )
    ) {
      answerContextMessageAdded = true;
    }
    if (visibleAnswerMessageAdded || answerContextMessageAdded) {
      await schedulePersist(session, "resumeAskUser:answer_message");
    }
    const frozenWorkingMemorySnapshot = await ensureWorkingMemorySnapshot(session);
    const omContextForResume = await prepareOmContextForTurn(session, undefined, {
      allowCompressionActivation: false,
    });
    const resumeMessagesForModel = omContextForResume.messagesForModel;
    const resumeMessagesForToolContext = omContextForResume.tailObservationPrompt
      ? [
          ...resumeMessagesForModel,
          {
            role: "user" as const,
            content: omContextForResume.tailObservationPrompt,
          },
        ]
      : resumeMessagesForModel;
    // resumeStream 恢复的是 Mastra 挂起时保存的 MessageList,API 不接受替换后的
    // messages 数组;但工具内层 LLM 读取 requestContext.messages,压缩态必须同步
    // 使用投影上下文,避免 writeDraft 等工具绕过 OM 压缩。
    const requestContext: RequestContext = new RequestContext([
      ["materials", session.materials],
      ["messages", resumeMessagesForToolContext],
      [MASTRA_THREAD_ID_KEY, session.threadId ?? session.sessionId],
      [TODO_AWARENESS_REQUEST_CONTEXT_KEY, () => buildTodoAwarenessContent(session.todos)],
      [QINGAGENT_WORKING_MEMORY_REQUEST_CONTEXT_KEY, frozenWorkingMemorySnapshot],
      [QINGAGENT_OM_OBSERVATIONS_REQUEST_CONTEXT_KEY, omContextForResume.tailObservationPrompt],
      ["sessionId", session.sessionId],
      ["streamId", streamId],
      ["abortSignal", abortController.signal],
      ["runId", runId],
      ["clientTraceId", session.clientTraceId ?? null],
      ["origin", session.origin ?? "manual"],
      ["docVersion", session.docVersion],
      ["doc", session.doc],
      ["legacySections", session.legacySections],
      ["patchValidationResults", session.patchValidationResults],
      ["modelOverrides", session.modelOverrides],
      ["askUserAlreadyCompleted", session._askUserCompleted === true],
      ["isDirectionReset", resumeWasDirectionReset],
      ["directionChangeAskedSinceLastWrite", session._directionChangeAskedSinceLastWrite === true],
    ]);
    bindTurnOwnershipToRequestContext(requestContext, turnOwnership);
    resumeRequestContext = requestContext;
    beginSessionSnapshotTurn(requestContext);
    // e2e-loop-0704 R13:resume 时模型只看得到 raw 答案(chosen 里是 "v2" 这类选项
    // value),题面/选项文案只发给过前端 → 模型读不懂答卷,收到答案后 5s 内再弹一份
    // 同类问卷。把题面/选中项 label 回填进 resumeData,模型在它实际走的上下文
    // (resume 后的 tool-result)里直接读懂答案;可见卡/答案 message 路径仍用原始答案。
    const resumeDataForModel = enrichAskUserResumeAnswersWithLabels(
      resumeData,
      askUserSpecForResume,
    );
    const prefixGuardContext = {
      sessionId: session.sessionId,
      lineage: "resume" as const,
      scopeId: streamId,
    };
    let activePrefixGuardContext = prefixGuardContext;
    abortController.signal.throwIfAborted();
    for (let attempt = 0; ; attempt++) {
      abortController.signal.throwIfAborted();
      try {
        const sessionTraceId = deriveSessionTraceId(session.sessionId);
        activePrefixGuardContext = {
          ...prefixGuardContext,
          scopeId: attempt === 0 ? streamId : `${streamId}:retry:${attempt}`,
        };
        result = await guardContext.run(
          activePrefixGuardContext,
          () => qingagentAgent.resumeStream(
            resumeDataForModel,
            {
              runId: runId!,
              toolCallId: toolCallId ?? undefined,
              maxSteps: AGENT_MAX_STEPS,
              // 对齐普通 runAgentTurn：代理偶发抖动时给模型调用更多重试余量。
              // F1:同样合并设置页采样参数覆盖。
              modelSettings: { maxRetries: 4, ...resolveModelParams(requestContext) },
              ...(omSidecarEnabled
                ? {}
                : {
                    memory: {
                      thread: session.threadId ?? session.sessionId,
                      resource: session.resourceId || QINGAGENT_RESOURCE_ID,
                    },
                  }),
              toolsets: {
                sessionScoped: bindToolsToAbortSignal(
                  {
                    readMaterial: sessionTools.readMaterial,
                    summarizeMaterial: sessionTools.summarizeMaterial,
                    readDraft: sessionTools.readDraftAiIr,
                    editDraft: sessionTools.editDraft,
                    readDiff: sessionTools.readDiff,
                    ...(sessionTools.writeDraft ? { writeDraft: sessionTools.writeDraft } : {}),
                    ...(sessionTools.updateWorkingMemory
                      ? { updateWorkingMemory: sessionTools.updateWorkingMemory }
                      : {}),
                  },
                  abortController.signal,
                ),
                capabilityTools: bindToolsToAbortSignal(
                  capabilityTools,
                  abortController.signal,
                ),
                // askUser 仅为老会话快照恢复注入；老会话数据迁移或过期后删除。
                ...(askUserSpecForResume?.name === "askUser"
                  ? {
                      legacyQuestionnaire: bindToolsToAbortSignal(
                        { askUser: askUserTool },
                        abortController.signal,
                      ),
                    }
                  : {}),
              },
              // Keep resumed-run spans on the same session trace as the initial
              // turn and carry the raw ids in span metadata for cross-layer joins.
              // clientTraceId 必须随 resume 透传：缺它会让 askUser resume / 续轮
	              // （含 writeDraft 那轮）的框架 span（agent_run/model_generation/
              // tool_call/processor_run/model_inference）clientTraceId 全为 null，
              // 按 clientTraceId 追链时这些轮的因果链断裂。对齐首轮 runAgentTurn 的
              // tracingOptions.metadata（runAgentTurn.ts）。session.
	              // clientTraceId 已在 resumeAskUser 分发
              // 时由 bindClientTraceId(normalizeClientTraceId(...)) 设置。
              tracingOptions: {
                ...(sessionTraceId ? { traceId: sessionTraceId } : {}),
                metadata: buildAgentTracingMetadata(
                  { ...session, clientTraceId: resumeClientTraceId ?? undefined },
                  streamId,
                  runId,
                ),
              },
              requestContext,
              abortSignal: abortController.signal,
            },
          ),
        );
        break; // success — exit retry loop
      } catch (resumeErr) {
        // Retry only on snapshot-not-found errors (the workflow snapshot
        // from suspend() may not have been persisted yet).
        if (isSnapshotNotFoundError(resumeErr) && attempt < MAX_RESUME_RETRIES) {
          console.warn(
            `[handleResume] Snapshot not found (attempt ${attempt + 1}/${MAX_RESUME_RETRIES}), retrying in ${RETRY_DELAY_MS}ms...`,
          );
          await delayWithSignal(RETRY_DELAY_MS, abortController.signal);
          abortController.signal.throwIfAborted();
          continue;
        }
        throw resumeErr; // non-retryable or exhausted retries
      }
    }

    const answeredAskUserUpdate = markAskUserToolCallAnsweredForResume(
      session,
      toolCallId,
      resumeAnswers,
    );
    if (answeredAskUserUpdate) {
      yield {
        kind: "toolCallUpdated",
        data: answeredAskUserUpdate,
      };
    }
    yield* emitProjectedDocState(session, "resume_ask_user_answered");

    // processAgentStream clears session.runId / session.toolCallId on
    // natural completion.
    const resumeOutcome = yield* withPrefixCacheGuardContext(activePrefixGuardContext, () =>
      processAgentStream(result.fullStream, {
        state: session,
        agentMessageId,
        streamId,
        runId: result.runId,
        requestContext,
        abortController,
        deferRetryableIdleTimeout: true,
      }),
    );
    // 诊断 p04:问卷确认后的首次生成最易撞上 DeepSeek 流式瞬断(ECONNRESET)。
    // 普通 sendMessage 有零产出瞬断自动重试,resume 路径此前没有——用户刚填完
    // 问卷就看到"生成失败,请手动重试"。这里对"瞬断 + 无可见产出 + 无真副作用
    // 工具调用"的安全场景,用既有的 fresh-turn 兜底机制自动续跑(runAgentTurn
    // 自带瞬断重试)。
    const retryableIdleTimeout =
      resumeOutcome.retryableIdleTimeoutChunk !== undefined;
    if (
      (resumeOutcome.transientErrorChunk !== undefined || retryableIdleTimeout) &&
      !resumeOutcome.producedVisibleFrame &&
      !resumeOutcome.sawSideEffectToolCall
    ) {
      const askUserSpecForRetry = findAskUserToolCallSpec(session, toolCallId);
      if (askUserSpecForRetry) {
        console.warn("[handleResume] zero-output stream error after resume; auto-retrying as fresh turn", {
          sessionId: session.sessionId,
          streamId,
          category: retryableIdleTimeout ? "idle_timeout" : "transient",
        });
        freshTurnAfterIdleTimeout = retryableIdleTimeout;
        freshTurnPrompt = buildFreshAskUserResumePrompt(
          session,
          askUserSpecForRetry,
          resumeData,
        );
        const terminalized = terminalizeAskUserToolCall(
          session,
          askUserSpecForRetry.id,
          retryableIdleTimeout
            ? "生成刚才长时间无响应，已用你的答案自动重试。"
            : "网络刚才中断，已用你的答案自动重试。",
        );
        if (terminalized) {
          yield {
            kind: "toolCallUpdated",
            data: {
              messageId: terminalized.messageId,
              toolCallId: terminalized.toolCallId,
              spec: terminalized.spec,
            },
          };
        }
      } else {
        // 找不到原问卷 spec 时退回可见失败,绝不静默吞错。
        yield {
          kind: "stream",
          data: {
            kind: "draftingFailed",
            data: {
              streamId,
              reason: "模型服务连接失败(网络或上游异常),请重试。",
              retriable: true,
            },
          },
        };
      }
    }
  } catch (err) {
    const askUserSpec = findAskUserToolCallSpec(session, toolCallId);
    if (abortController.signal.aborted) {
      // 用户取消或流看门狗已经终止本轮时，不再把中止当成恢复失败展示。
    } else if (isSnapshotNotFoundError(err) && askUserSpec) {
      guardReset(session.sessionId, "snapshot_lost");
      freshTurnPrompt = buildFreshAskUserResumePrompt(
        session,
        askUserSpec,
        resumeData,
      );

      const terminalized = terminalizeAskUserToolCall(
        session,
        askUserSpec.id,
        "原问卷快照缺失，已用本次答案转入新一轮继续处理。",
      );
      if (terminalized) {
        yield {
          kind: "toolCallUpdated",
          data: {
            messageId: terminalized.messageId,
            toolCallId: terminalized.toolCallId,
            spec: terminalized.spec,
          },
        };
      }

      clearSuspension(session);
      if (session.streamId === streamId) {
        session.streamId = null;
      }
      transitionDocState(
        session,
        normalizeTargetDocState(session, deriveContentState(session), "resume_failed"),
        "resume_failed",
        { mode: "normalize" },
      );
      yield* emitProjectedDocState(session, "resume_failed");
      await schedulePersist(session, "resume_failed:fresh_turn_fallback");
    } else {
      const internalDetail = err instanceof Error ? err.stack ?? err.message : String(err);
      const redactedReason = redactSensitiveText(internalDetail)
        .replace(/\bsk-[A-Za-z0-9][A-Za-z0-9_-]{5,}\b/g, "sk-[REDACTED]")
        .slice(0, 1_000);
      console.error("[handleResume] resume failed", {
        code: "TURN_RESUME_FAILED",
        detail: redactedReason,
      });
      yield {
        kind: "stream",
        data: {
          kind: "draftingFailed",
          data: {
            streamId,
            reason: "恢复生成失败，请重试（错误码：TURN_RESUME_FAILED）",
            retriable: true,
          },
        },
      };

      // Resume failed; the consumed Mastra snapshot is no longer restorable.
      clearSuspension(session);
      transitionDocState(
        session,
        normalizeTargetDocState(session, errorFallbackDocState, "resume_failed"),
        "resume_failed",
        { mode: "normalize" },
      );
      yield* emitProjectedDocState(session, "resume_failed");
    }
  } finally {
    const reSuspendedThisStream = activeSuspensionOwnedBy(session, streamId);
    const stillHoldingConsumedRun =
      session.runId === runId && session.toolCallId === toolCallId;
    if (
      !reSuspendedThisStream &&
      (!hasActiveSuspension(session) || stillHoldingConsumedRun)
    ) {
      clearSuspension(session);
    }

    if (session.streamId === streamId) {
      session.streamId = null;
    }
    // 残留 running 工具调用落终态,避免 resume 轮"调用完仍 loading"。
    for (const u of finalizeLingeringRunningToolCalls(session)) {
      yield { kind: "toolCallUpdated", data: { messageId: u.messageId, toolCallId: u.toolCallId, spec: u.spec } };
    }
    transitionDocState(session, deriveContentState(session), "agent_turn_finally_idle", {
      mode: "normalize",
    });
    yield* emitProjectedDocState(session, "agent_turn_finally_idle");
    yield { kind: "stream", data: { kind: "end", data: { streamId, reason: { kind: "done" } } } };

    // Safety-net persist: ensures the resumed agent response is captured
    // even if the fire-and-forget persist inside processAgentStream failed.
    await schedulePersist(session, "handleResume:finally").catch((err) => {
      console.error("[handleResume] Persist after finally failed:", err instanceof Error ? err.message : String(err));
    });
    if (omSidecarEnabled) {
      scheduleOmSidecarAfterTurn(session, resumeRequestContext, {
        turnIndex: omResumeTurnIndex,
        turnStartMessageIndex: omResumeStartMessageIndex,
      });
    }
    resolveActiveTurn();
    endTurnOwnership(session, turnOwnership);
    if (session._abortController === abortController) {
      session._abortController = null;
    }
    if (session._activeTurnPromise === activeTurnPromise) {
      session._activeTurnPromise = null;
    }
  }

  if (
    freshTurnPrompt !== null &&
    (!abortController.signal.aborted || freshTurnAfterIdleTimeout)
  ) {
    yield* runAgentTurn(
      session,
      freshTurnPrompt,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      freshTurnAfterIdleTimeout ? { idleTimeoutRetryLimit: 0 } : {},
    );
  }
}

type TurnCommand = Extract<Command, {
  kind: "sendMessage" | "submitReviewOutcome" | "resumeAskUser" | "cancelAskUser" | "cancelStream";
}>;

export async function* handleTurnCommand(
  command: TurnCommand,
  context: CommandExecutionContext,
): AsyncGenerator<BridgeFrame> {
  const { resolvedClientTraceId, origin, modelOverrides } = context;
  switch (command.kind) {
    case "sendMessage": {
      const session = await getOrRestoreSession(command.data.sessionId);
      if (!session) {
        throw new Error(
          `Session not found: ${command.data.sessionId}`,
        );
      }
      bindClientTraceId(session, resolvedClientTraceId, origin, modelOverrides);
      const preemptedByNewMessage =
        context.preemptionReason === "preemptedByNewMessage";
      if (preemptedByNewMessage) {
        // Actor 已直接对同一会话的旧 controller 发出 abort。这里按队列顺序、
        // 用已解析出的 session 对象完成同一条清理链，不再依赖旧 streamId 反查。
        yield* abortAndCleanupTurn(session, {
          emitStreamEnd: false,
          reason: "preemptedByNewMessage",
        });
      }

      if (session.pendingConfirms.size > 0) {
        yield {
          kind: "stream",
          data: {
            kind: "draftingFailed",
            data: {
              streamId: session.streamId ?? "blocked",
              reason: "请先处理当前确认",
              retriable: false,
            },
          },
        };
        return;
      }

      if (clearStaleSuspensionIfInactive(session)) {
        yield* emitProjectedDocState(session, "stale_suspension_cleared");
        schedulePersist(session, "sendMessage:clear_stale_suspension").catch((err) => {
          console.error(
            "[sendMessage] Persist after clearing stale suspension failed:",
            err instanceof Error ? err.message : String(err),
          );
        });
      }

      if (hasActiveSuspension(session)) {
        yield {
          kind: "stream",
          data: {
            kind: "draftingFailed",
            data: {
              streamId: session.streamId ?? "blocked",
              reason: "请先完成问卷",
              retriable: false,
            },
          },
        };
        return;
      }

      if (!preemptedByNewMessage && session.streamId !== null) {
        yield* abortAndCleanupTurn(session);
      }

      const fileIds = command.data.fileIds ?? [];
      const chips = command.data.chips ?? [];
      const skills = command.data.skills ?? [];
      yield* runAgentTurn(
        session,
        command.data.text,
        fileIds,
        chips,
        skills,
        command.data.displayCard
          ? [{ kind: "actionCard", data: command.data.displayCard }]
          : null,
        command.data.clientMessageId,
        command.data.richText,
        command.data.reviewContext,
        {
          preemptedByNewMessage,
          ...(command.data.turnContext
            ? { turnContext: command.data.turnContext }
            : {}),
        },
      );
      return;
    }

    case "submitReviewOutcome": {
      // 用户审完一轮 diff（局部采纳 / 全部拒绝）后以用户名义回流结果，驱动模型追问。
      // 同一 outcome 双投影：序列化全文喂模型（state.messages），缩略卡 part 进 chatHistory。
      const session = await getOrRestoreSession(command.data.sessionId);
      if (!session) {
        throw new Error(`Session not found: ${command.data.sessionId}`);
      }
      bindClientTraceId(session, resolvedClientTraceId, origin, modelOverrides);

      if (session.pendingConfirms.size > 0) {
        yield {
          kind: "stream",
          data: {
            kind: "draftingFailed",
            data: {
              streamId: session.streamId ?? "blocked",
              reason: "请先处理当前确认",
              retriable: false,
            },
          },
        };
        return;
      }

      if (clearStaleSuspensionIfInactive(session)) {
        yield* emitProjectedDocState(session, "stale_suspension_cleared");
        schedulePersist(session, "submitReviewOutcome:clear_stale_suspension").catch((err) => {
          console.error(
            "[submitReviewOutcome] Persist after clearing stale suspension failed:",
            err instanceof Error ? err.message : String(err),
          );
        });
      }

      if (hasActiveSuspension(session)) {
        yield {
          kind: "stream",
          data: {
            kind: "draftingFailed",
            data: {
              streamId: session.streamId ?? "blocked",
              reason: "请先完成问卷",
              retriable: false,
            },
          },
        };
        return;
      }

      if (session.streamId !== null) {
        yield* abortAndCleanupTurn(session);
      }

      const outcome = command.data.outcome;
      const reviewUserText = serializeReviewOutcome(outcome);
      const displayParts: MessagePart[] = [
        { kind: "reviewOutcome", data: outcome },
      ];
      yield* runAgentTurn(session, reviewUserText, [], [], [], displayParts);
      return;
    }

    case "resumeAskUser": {
      // 冷加载兜底:loadSessionFromThread 能恢复 askUser 的 runId/toolCallId/_suspensionOwner,
      // 重启/部署后用户仍停在问卷直接提交时,内存 miss 也能恢复后继续(下方 !runId 门控不变)。
      // WM 不在冷 resume 补读:D8 后会话已在 start/run 冻结进 messages;
      // D8 前遗留挂起保持 no-WM 语义,避免恢复时改变旧会话前缀。
      const session = await getOrRestoreSession(command.data.sessionId, {
        preferredAskUserToolCallId: command.data.toolCallId,
      });
      if (!session) {
        throw new Error("没有待恢复的操作");
      }
      bindClientTraceId(session, resolvedClientTraceId, origin, modelOverrides);

      // If runId is not yet set but an active stream is running (the
      // tool-call-suspended event hasn't been processed yet), wait briefly
      // for the suspend to complete. This handles the race condition where
      // the user submits the questionnaire before the askUser tool's
      // suspend() finishes persisting its workflow snapshot.
      if (!session.runId && session.streamId) {
        const MAX_WAIT_MS = 10_000;
        const POLL_MS = 100;
        const deadline = Date.now() + MAX_WAIT_MS;
        while (!session.runId && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, POLL_MS));
        }
      }

      applySubmittedAskUserToolCallId(session, command.data.toolCallId);

      if (!session.runId) {
        throw new Error("没有待恢复的操作");
      }

      yield* handleResume(
        session,
        command.data.answers,
        session.previousDocState ?? { kind: "editing" },
      );
      return;
    }

    case "cancelAskUser": {
      const session = await getOrRestoreSession(command.data.sessionId);
      if (!session) {
        throw new Error(`Session not found: ${command.data.sessionId}`);
      }
      bindClientTraceId(session, resolvedClientTraceId, origin, modelOverrides);
      yield* handleCancelAskUser(session, command.data.toolCallId);
      return;
    }
    case "cancelStream": {
      const session =
        context.preemptionReason === "globalStop" && context.sessionId
          ? await getOrRestoreSession(context.sessionId)
          : command.data.sessionId
            ? await getOrRestoreSession(command.data.sessionId)
            : command.data.streamId
              ? findSessionByStream(command.data.streamId)
              : undefined;
      if (session) {
        if (
          context.preemptionReason !== "globalStop" &&
          command.data.streamId &&
          session.streamId !== command.data.streamId
        ) {
          return;
        }
        bindClientTraceId(session, resolvedClientTraceId, origin, modelOverrides);
        yield* abortAndCleanupTurn(session, {
          reason: context.preemptionReason === "globalStop"
            ? "globalStop"
            : "userAbort",
        });
      }
      return;
    }
  }
}
