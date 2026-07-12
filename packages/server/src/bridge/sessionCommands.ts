import type { BridgeFrame, Command } from "@qingagent/contract-ts";
import crypto from "node:crypto";
import {
  createSession,
  createSessionThread,
  ensureWorkingMemorySnapshotWithStatus,
  loadSessionFromThread,
  schedulePersist,
  type SessionState,
} from "./bridgeCore";
import { bindClientTraceId, normalizeClientTraceId } from "./commandTracing";
import type { CommandExecutionContext } from "./commandTypes";
import {
  getSession,
  sessionManager,
  sessions,
} from "./sessionLifecycle";
import { emitRestoreFrames, reconcileCachedSessionDocFromDb } from "./restoreFrames";

/**
 * startSession(existing) 重进会话的还原:必须先发 restoreReset 让前端清空 session 级状态,
 * 再发 sessionMeta + emitRestoreFrames 从 chatHistory 干净重建。
 *
 * 为什么必须先 reset:直播 sendMessage 只把 agent 消息作为帧写进 FrameLog(用户消息只进
 * chatHistory、不发帧)。重进(startSession existing)会把 emitRestoreFrames 追加到同一条
 * FrameLog 尾部,前端 after=0 重放时会先应用"直播残留的 agent 帧"、再应用还原帧,导致
 * ① 用户消息(只在还原里出现)排到 AI 回复之后 ② AI 消息重复(直播帧 + 还原帧)。
 * 前置 restoreReset 让前端在应用还原帧前清空,状态从 chatHistory 干净重建,顺序正确、无重复。
 * 与 /events 的 appendRestoreSnapshot 干净还原路径对齐(那条已先发 restoreReset)。
 */
function* emitExistingSessionRestore(session: SessionState): Generator<BridgeFrame> {
  const sessionId = session.sessionId;
  yield {
    kind: "restoreReset",
    data: {
      epoch: sessionManager.frameLog.getEpoch(sessionId),
      snapshotSeq: sessionManager.frameLog.readFrom(sessionId, Number.MAX_SAFE_INTEGER)
        .nextSeq,
    },
  };
  yield { kind: "sessionMeta", data: { sessionId, title: session.title } };
  yield* emitRestoreFrames(session);
}

type StartSessionCommand = Extract<Command, { kind: "startSession" }>;

export async function* handleSessionCommand(
  command: StartSessionCommand,
  context: CommandExecutionContext,
): AsyncGenerator<BridgeFrame> {
  const { clientTraceId, resolvedClientTraceId, origin, modelOverrides } = context;
  switch (command.kind) {
    case "startSession": {
      const mode = command.data.mode;

      if (mode.kind === "existing") {
        // Restore existing session from thread
        const sessionId = mode.data.id;

        // Check if already loaded in memory
        const cached = sessions.get(sessionId);
        if (cached) {
          // Session already active — just re-emit restore frames
          bindClientTraceId(cached, resolvedClientTraceId, origin, modelOverrides);
          // 重连前对齐 DB 权威版本,修复"内存陈旧 docVersion 导致刷新后必现文档冲突"。
          const cachedReconciledFromDb = await reconcileCachedSessionDocFromDb(cached);
          const wmSnapshot = await ensureWorkingMemorySnapshotWithStatus(cached);
          if (cachedReconciledFromDb || (wmSnapshot.loadedNow && wmSnapshot.persistable)) {
            await schedulePersist(
              cached,
              cachedReconciledFromDb
                ? "restore:cached_documents_metadata_reconcile"
                : "restore:working_memory_snapshot",
            );
          }
          yield* emitExistingSessionRestore(cached);
          return;
        }

        // Load from thread storage
        const restored = await loadSessionFromThread(sessionId);
        if (!restored) {
          throw new Error(`Session not found: ${sessionId}`);
        }
        bindClientTraceId(restored, resolvedClientTraceId, origin, modelOverrides);
        sessions.set(sessionId, restored);
        const wmSnapshot = await ensureWorkingMemorySnapshotWithStatus(restored);
        if (wmSnapshot.loadedNow && wmSnapshot.persistable) {
          await schedulePersist(restored, "restore:working_memory_snapshot");
        }
        yield* emitExistingSessionRestore(restored);
        return;
      }

      // mode.kind === "new"
      const sessionId = mode.data.sessionId ?? crypto.randomUUID();
      // 覆写防护第二道(0702 review):路由层 409 预检后仍可能有并发窗口(两条同 id 的 new
      // 同时过检、先后入队)。执行时内存已存在同 id 会话则拒绝,绝不允许空会话顶掉活会话。
      if (sessions.has(sessionId)) {
        throw new Error(`Session already exists: ${sessionId}`);
      }
      const createdAt = new Date().toISOString();
      const session = createSession(sessionId, createdAt);
      session.threadId = sessionId;
      // 阶段4a：新会话入口拿不到 sessionId（刚生成），这里按真实 sessionId 重新
      // 归一化 clientTraceId（兜底将用本会话的 traceId），再绑定。
      bindClientTraceId(session, normalizeClientTraceId(clientTraceId, sessionId), origin, modelOverrides);
      const wmSnapshot = await ensureWorkingMemorySnapshotWithStatus(session);
      sessions.set(session.sessionId, session);

      // Persist thread to storage (fire-and-forget — don't block SSE)
      const threadCreatePromise = createSessionThread(sessionId, undefined, {
        createdAt,
        workingMemorySnapshot: session._workingMemorySnapshot ?? null,
        workingMemorySnapshotLoaded: wmSnapshot.persistable,
      });
      session.threadCreatePromise = threadCreatePromise;
      threadCreatePromise.catch((err) => {
        const errMsg = err instanceof Error ? err.message : String(err);
        console.error("[persistence] Failed to create session thread:", errMsg);
      });
      void threadCreatePromise
        .finally(() => {
          if (session.threadCreatePromise === threadCreatePromise) {
            session.threadCreatePromise = undefined;
          }
        })
        .catch(() => undefined);

      const meta: BridgeFrame = {
        kind: "sessionMeta",
        data: { sessionId: session.sessionId, title: session.title },
      };
      yield meta;
      return;
    }
  }
}
