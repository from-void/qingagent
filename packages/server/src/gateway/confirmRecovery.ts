import type { BridgeFrame, ToolCallSpec } from "@qingagent/contract-ts";
import {
  confirmService,
  qingagentAgent,
  type ConfirmService,
  type PendingConfirm,
  type SessionState,
} from "./bridgeCore";

const recoveryFrames = new WeakMap<SessionState, BridgeFrame[]>();

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
      ? "上次确认后的执行结果未知，未自动重试"
      : expired
        ? "确认已过期，命令未执行"
        : "确认快照已失效，命令未执行";
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
