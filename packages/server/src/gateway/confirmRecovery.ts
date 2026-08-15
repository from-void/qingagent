import type { BridgeFrame, ToolCallSpec } from "@qingagent/contract-ts";
import {
  clearSuspension,
  confirmService,
  deriveContentState,
  finalizeLingeringRunningToolCalls,
  getActiveSuspensionOwner,
  interruptQuestionnaireSpecForRestore,
  qingagentAgent,
  schedulePersist,
  type ConfirmService,
  type PendingConfirm,
  type SessionState,
} from "./bridgeCore";

const recoveryFrames = new WeakMap<SessionState, BridgeFrame[]>();

/**
 * 冷恢复只允许保留 Mastra 持久层中仍能精确发现的 suspension。
 *
 * 普通 agent stream 不能跨进程续跑；同进程内的活跃流始终由 sessions/actor
 * 持有，不会进入冷恢复。能跨重启延续的只有 Mastra suspended run，因此
 * runId/toolCallId/toolName 三元组是恢复活跃性的权威判据。
 */
export async function reconcileRestoredAgentSuspension(
  session: SessionState,
  dependencies: {
    agent?: Pick<typeof qingagentAgent, "listSuspendedRuns">;
  } = {},
): Promise<boolean> {
  const owner = getActiveSuspensionOwner(session);
  const hasColdRuntimeStream =
    session.streamId !== null &&
    session._abortController === null &&
    session._activeTurnPromise === null;
  if (!owner) {
    if (!hasColdRuntimeStream) return false;
    session.streamId = null;
    finalizeLingeringRunningToolCalls(session);
    session.docState = deriveContentState(session);
    session._lastEmittedWireKind = null;
    await schedulePersist(session, "restore:stale_agent_stream");
    console.warn("[session-restore] cleared stale agent stream", {
      sessionId: session.sessionId,
    });
    return true;
  }

  const agent = dependencies.agent ?? qingagentAgent;
  let runs: Awaited<ReturnType<typeof agent.listSuspendedRuns>>["runs"];
  try {
    runs = (await agent.listSuspendedRuns({
      threadId: session.threadId ?? session.sessionId,
      resourceId: session.resourceId,
    })).runs;
  } catch (error) {
    // 存储读取失败时无法证明 run 已失效；保留 suspension，避免误杀真实可恢复问卷。
    console.warn("[session-restore] suspended run liveness check failed", {
      sessionId: session.sessionId,
      runId: owner.runId,
      toolCallId: owner.toolCallId,
      error: error instanceof Error ? error.message : String(error),
    });
    if (!hasColdRuntimeStream) return false;
    session.streamId = null;
    await schedulePersist(session, "restore:stale_agent_stream");
    return true;
  }

  const durableMatch = runs.some(
    (run) =>
      run.runId === owner.runId &&
      run.toolCalls.some(
        (toolCall) =>
          toolCall.toolCallId === owner.toolCallId &&
          toolCall.toolName === owner.toolName &&
          toolCall.requiresApproval !== true,
      ),
  );
  if (durableMatch) {
    // durable suspension 由 run/tool owner 延续；旧快照若还带普通 stream 锁，
    // 它没有当前进程的 controller/promise，不能继续参与 agentBusy 派生。
    if (!hasColdRuntimeStream) return false;
    session.streamId = null;
    await schedulePersist(session, "restore:stale_agent_stream");
    return true;
  }

  for (const message of session.chatHistory) {
    for (let index = 0; index < message.parts.length; index += 1) {
      const part = message.parts[index];
      if (
        part?.kind !== "toolCall" ||
        part.data.id !== owner.toolCallId ||
        part.data.name !== owner.toolName
      ) {
        continue;
      }
      message.parts[index] = {
        kind: "toolCall",
        data: interruptQuestionnaireSpecForRestore(part.data),
      };
      break;
    }
  }

  clearSuspension(session);
  // loadSessionFromThread 当前会把 streamId 初始化为 null；这里仍显式清理，兼容
  // 旧持久快照/测试载体，也防止未来恢复字段扩展再次把无 owner 的锁带回内存。
  session.streamId = null;
  session.previousDocState = null;
  session.docState = deriveContentState(session);
  session._lastEmittedWireKind = null;

  await schedulePersist(session, "restore:stale_agent_suspension");
  console.warn("[session-restore] cleared stale agent suspension", {
    sessionId: session.sessionId,
    runId: owner.runId,
    toolCallId: owner.toolCallId,
    toolName: owner.toolName,
  });
  return true;
}

function terminalizePendingTool(
  session: SessionState,
  pending: PendingConfirm,
  reason: string,
): void {
  for (const message of session.chatHistory) {
    for (let index = 0; index < message.parts.length; index += 1) {
      const part = message.parts[index];
      if (part?.kind !== "toolCall" || part.data.id !== pending.toolCallId) continue;
      const spec: ToolCallSpec = {
        ...part.data,
        status: { kind: "failed", data: { retriable: false, reason } },
        result: part.data.result ?? { kind: "genericText", data: reason },
      };
      message.parts[index] = { kind: "toolCall", data: spec };
      return;
    }
  }
}

async function declineQuietly(
  agent: Pick<typeof qingagentAgent, "declineToolCall">,
  runId: string,
  toolCallId: string,
): Promise<void> {
  try {
    const result = await agent.declineToolCall({ runId, toolCallId, maxSteps: 1 });
    for await (const _chunk of result.fullStream) {
      // 只为让 Mastra 完成 snapshot 清理；恢复文本不进入 qingagent 会话/模型上下文。
    }
  } catch {
    // proof 不可恢复，decline 失败也不会让 gate 放行。
  }
}

/** 冷恢复时双向核对 qing metadata 与 Mastra snapshot；任一不匹配即关闭。 */
export async function reconcileRestoredConfirms(
  session: SessionState,
  dependencies: {
    agent?: Pick<typeof qingagentAgent, "listSuspendedRuns" | "declineToolCall">;
    service?: ConfirmService;
    now?: () => number;
  } = {},
): Promise<void> {
  if (session.pendingConfirms.size === 0) return;
  const agent = dependencies.agent ?? qingagentAgent;
  const service = dependencies.service ?? confirmService;
  const now = dependencies.now?.() ?? Date.now();
  let runs: Awaited<ReturnType<typeof agent.listSuspendedRuns>>["runs"] = [];
  let snapshotReadFailed = false;
  try {
    runs = (await agent.listSuspendedRuns({
      threadId: session.threadId ?? session.sessionId,
      resourceId: session.resourceId,
    })).runs;
  } catch {
    snapshotReadFailed = true;
  }

  const validKeys = new Set<string>();
  for (const run of runs) {
    for (const toolCall of run.toolCalls) {
      if (toolCall.requiresApproval && toolCall.toolCallId) {
        validKeys.add(`${run.runId}\0${toolCall.toolCallId}\0${toolCall.toolName ?? ""}`);
      }
    }
  }

  const frames: BridgeFrame[] = [];
  for (const pending of [...session.pendingConfirms.values()]) {
    const expired = Date.parse(pending.expiresAt) <= now;
    const snapshotMatches = !snapshotReadFailed && validKeys.has(
      `${pending.runId}\0${pending.toolCallId}\0${pending.toolName}`,
    );
    if (pending.status === "pending" && !expired && snapshotMatches) continue;

    if (snapshotMatches) {
      await declineQuietly(agent, pending.runId, pending.toolCallId);
    }
    const resolution = expired ? "expired" as const : "failed" as const;
    const reason = pending.status === "resuming"
      ? "上次确认后没有收到完整结果。为避免重复操作，系统没有自动重试；请查看命令输出后再决定是否重新执行。"
      : expired
        ? "这张确认卡已过期，命令没有执行。请重新确认。"
        : "确认状态已失效，命令没有执行。请重新确认后再试。";
    terminalizePendingTool(session, pending, reason);
    if (expired) await service.expireDecision(session, pending).catch(() => undefined);
    else await service.failDecision(session, pending).catch(() => undefined);
    frames.push(service.resolvedFrame(pending, resolution, reason));
  }
  if (frames.length > 0) recoveryFrames.set(session, frames);
}

export function takeConfirmRecoveryFrames(session: SessionState): BridgeFrame[] {
  const frames = recoveryFrames.get(session) ?? [];
  recoveryFrames.delete(session);
  return frames;
}
