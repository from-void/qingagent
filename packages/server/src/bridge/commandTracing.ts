import type { Command, BridgeFrame } from "@qingagent/contract-ts";
import { SpanType } from "@mastra/core/observability";
import type { Span } from "@mastra/core/observability";
import {
  mastra,
  getObservability,
  sessionIdToTraceId,
  type SessionState,
  type ModelOverrides,
} from "./bridgeCore";
import {
  findSessionByPatch,
  findSessionByReviewBatchId,
  findSessionByStream,
} from "./sessionRegistry";

export function deriveSessionTraceId(sessionId: string): string | undefined {
  const derive = sessionIdToTraceId as unknown;
  return typeof derive === "function" ? derive(sessionId) : undefined;
}

export function resolveCommandSessionId(command: Command): string | undefined {
  switch (command.kind) {
    case "acceptPatch":
    case "rejectPatch":
      return (
        (command.data.id ? findSessionByPatch(command.data.id)?.sessionId : undefined) ??
        (command.data.reviewBatchId
          ? findSessionByReviewBatchId(command.data.reviewBatchId)?.sessionId
          : undefined)
      );
    case "commitPatches":
      return (
        (command.data.ids[0] ? findSessionByPatch(command.data.ids[0])?.sessionId : undefined) ??
        (command.data.reviewBatchIds?.[0]
          ? findSessionByReviewBatchId(command.data.reviewBatchIds[0])?.sessionId
          : undefined)
      );
    case "cancelStream":
      return findSessionByStream(command.data.streamId)?.sessionId;
    default: {
      const data = command.data as Record<string, unknown> | undefined;
      const sid = data?.sessionId;
      return typeof sid === "string" && sid.length > 0 ? sid : undefined;
    }
  }
}

/**
 * 归一化 clientTraceId（阶段4a）：
 * - 传入恰好 32hex（清洗去 dash/大小写后）→ 前端透传的合法 clientTraceId，直接用。
 * - 传入缺失或非 32hex（畸形）→ 用 sessionIdToTraceId(sessionId) 兜底（与会话级
 *   traceId 同源）。要求严格 32hex 而非「任意非空 hex」，避免畸形头（如 "abc"）
 *   产生短 id 污染关联（修 Codex review blocking #3）。
 * - 实在派生不出 → undefined。
 */
export function normalizeClientTraceId(
  raw: string | undefined,
  sessionId: string | undefined,
): string | undefined {
  if (raw) {
    const cleaned = raw.replace(/-/g, "").toLowerCase();
    if (/^[0-9a-f]{32}$/.test(cleaned)) return cleaned;
  }
  return sessionId ? deriveSessionTraceId(sessionId) : undefined;
}

/**
 * 0603 — 触发来源三态(日志可观测)。读 `x-origin` header:manual=真人前端 /
 * agent=AI 经 agent-browser 等触发 / e2e=自动化。非法/缺省 → manual。纯函数,便于单测。
 */
export type Origin = "manual" | "agent" | "e2e" | "external";
export function parseOrigin(raw: string | undefined): Origin {
  const v = (raw ?? "").trim().toLowerCase();
  return v === "agent" || v === "e2e" || v === "external" ? v : "manual";
}

/**
 * 把本次动作的 clientTraceId + origin 绑到 SessionState，供 db_write / 模型 / state_change
 * span 关联与来源标注。每条命令进来刷新一次(同会话不同动作可有不同 clientTraceId/origin)。
 */
export function bindClientTraceId(
  session: SessionState | undefined,
  clientTraceId: string | undefined,
  origin?: Origin,
  modelOverrides?: ModelOverrides,
): void {
  if (!session) return;
  if (clientTraceId) session.clientTraceId = clientTraceId;
  if (origin) session.origin = origin;
  if (modelOverrides) session.modelOverrides = modelOverrides;
}

/**
 * 提取命令关键参数摘要，作为 command span 的 input。
 * 只取小字段 / 计数 / id / 截断文本，绝不塞大对象（文档正文、完整 answers 等）。
 */
export function summarizeCommandInput(command: Command): Record<string, unknown> {
  switch (command.kind) {
    case "startSession":
      return { mode: command.data.mode?.kind };
    case "sendMessage":
      return {
        textPreview: command.data.text?.slice(0, 100) ?? "",
        textLength: command.data.text?.length ?? 0,
        mentionCount: command.data.mentions?.length ?? 0,
        skillCount: command.data.skills?.length ?? 0,
        chipCount: command.data.chips?.length ?? 0,
        fileCount: command.data.fileIds?.length ?? 0,
      };
    case "resumeAskUser":
      return {
        toolCallId: command.data.toolCallId ?? null,
        answerCount: Object.keys(command.data.answers ?? {}).length,
      };
    case "cancelAskUser":
      return {
        sessionId: command.data.sessionId,
        toolCallId: command.data.toolCallId,
      };
    case "acceptPatch":
    case "rejectPatch":
      return { patchId: command.data.id, reviewBatchId: command.data.reviewBatchId };
    case "commitPatches":
      return {
        patchIds: command.data.ids,
        patchCount: command.data.ids.length,
        reviewBatchIds: command.data.reviewBatchIds,
      };
    case "updateDoc":
      return {
        sectionsCount: command.data.legacySections?.length ?? null,
        hasPmDoc: Boolean(command.data.doc),
        expectedDocumentSnapshot: command.data.expectedDocumentSnapshot,
      };
    case "externalPropose":
      return {
        sessionId: command.data.sessionId,
        expectedDocVersion: command.data.expectedDocVersion,
        opCount: command.data.ops.length,
        opKinds: command.data.ops.map((op) => op.kind),
      };
    case "updateMaterialSummary":
      return {
        sessionId: command.data.sessionId,
        materialId: command.data.materialId,
        summaryLength: command.data.summary.length,
        summaryPreview: command.data.summary.slice(0, 100),
      };
    case "removeMaterial":
      return {
        sessionId: command.data.sessionId,
        materialId: command.data.materialId,
      };
    case "reparseMaterial":
      return {
        sessionId: command.data.sessionId,
        fileId: command.data.fileId,
      };
    case "attachFolder":
      return {
        sessionId: command.data.sessionId,
        provider: command.data.source.provider,
      };
    case "detachFolder":
      return {
        sessionId: command.data.sessionId,
        folderId: command.data.folderId,
      };
    case "cancelStream":
      return { streamId: command.data.streamId };
    default:
      return {};
  }
}

/**
 * Layer ②（阶段4b）：在命令统一分发点记一条 `SpanType.GENERIC`（name=`command`）
 * span。metadata 带 kind / sessionId / clientTraceId；input 是关键参数摘要。
 * 整段 try/catch：记 span 失败绝不影响命令处理（命令处理是主链路）。
 */
export interface CommandSpanHandle {
  endOk(output?: Record<string, unknown>): void;
  endError(reason: unknown, metadata?: Record<string, unknown>): void;
}

function noopCommandSpanHandle(): CommandSpanHandle {
  return {
    endOk: () => {},
    endError: () => {},
  };
}

export function getFailureFromFrame(frame: BridgeFrame): { reason: string; failureKind: string } | null {
  if (frame.kind === "stream" && frame.data.kind === "draftingFailed") {
    return { reason: frame.data.data.reason, failureKind: "draftingFailed" };
  }
  if (frame.kind === "folderSourceOperationResult" && frame.data.ok === false) {
    return {
      reason: frame.data.reason,
      failureKind: `folderSource.${frame.data.op}`,
    };
  }
  return null;
}

/**
 * Layer ②（阶段4b）：在命令统一分发点记一条 `SpanType.GENERIC`（name=`command`）
 * span。metadata 带 kind / sessionId / clientTraceId；input 是关键参数摘要。
 * 返回未结束 handle，由真实执行外层统一根据 throw / draftingFailed / 完成状态 end。
 * 整段 try/catch：记 span 失败绝不影响命令处理（命令处理是主链路）。
 */
export function recordCommandSpan(
  command: Command,
  sessionId: string | undefined,
  clientTraceId: string | undefined,
  origin: Origin = "manual",
): CommandSpanHandle {
  try {
    const instance = getObservability()?.getDefaultInstance();
    if (!instance) return noopCommandSpanHandle();

    const traceId = sessionId ? deriveSessionTraceId(sessionId) : undefined;
    const baseMetadata = {
      eventKind: "command",
      kind: command.kind,
      sessionId,
      clientTraceId,
      origin,
    };
    const span = instance.startSpan({
      type: SpanType.GENERIC,
      name: "command",
      ...(traceId ? { traceId } : {}),
      metadata: baseMetadata,
      input: summarizeCommandInput(command),
    }) as Span<SpanType.GENERIC>;

    let ended = false;
    return {
      endOk(output = { accepted: true }) {
        if (ended) return;
        ended = true;
        span.end({
          metadata: { ...baseMetadata, outcome: "ok" },
          output,
        });
      },
      endError(reason: unknown, metadata: Record<string, unknown> = {}) {
        if (ended) return;
        ended = true;
        const error = reason instanceof Error ? reason : new Error(String(reason));
        const failureReason = error.message || String(reason);
        const finalMetadata = {
          ...baseMetadata,
          ...metadata,
          outcome: "error",
          failureReason,
        };
        span.error({
          error,
          metadata: finalMetadata,
          endSpan: false,
        });
        span.end({
          metadata: finalMetadata,
          output: { accepted: false, failureReason },
        });
      },
    };
  } catch (err) {
    mastra.getLogger().warn("recordCommandSpan failed (non-fatal)", {
      sessionId,
      kind: (command as { kind?: string }).kind,
      error: err instanceof Error ? err.message : String(err),
    });
    return noopCommandSpanHandle();
  }
}
