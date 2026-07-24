import type { MemoryConfigInternal } from "@mastra/core/memory";
import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { getMemory, mastra } from "../mastra.js";
import type { SessionState } from "./sessionState.js";
import {
  assertTurnWriteAllowed,
  captureTurnWriteGuard,
} from "./turnOwnership.js";

const logger = mastra.getLogger();

export const QINGAGENT_WORKING_MEMORY_MAX_CHARS = 6_000;

export const QINGAGENT_WORKING_MEMORY_TEMPLATE = `# 用户长期记忆

## 稳定偏好
- 称呼:
- 写作风格:
- 常用格式:
- 明确禁忌:

## 长期任务与背景
- 当前长期目标:
- 重要项目:
- 约束条件:

## 其他可复用事实
- `;

export const QINGAGENT_WORKING_MEMORY_CONFIG: MemoryConfigInternal = {
  workingMemory: {
    enabled: true,
    scope: "resource",
    template: QINGAGENT_WORKING_MEMORY_TEMPLATE,
    agentManaged: false,
  },
};

export type WorkingMemorySnapshotResult = {
  snapshot: string | null;
  loadedNow: boolean;
  persistable: boolean;
};

export async function ensureWorkingMemorySnapshot(
  state: SessionState,
): Promise<string | null> {
  const result = await ensureWorkingMemorySnapshotWithStatus(state);
  return result.snapshot;
}

export async function ensureWorkingMemorySnapshotWithStatus(
  state: SessionState,
): Promise<WorkingMemorySnapshotResult> {
  if (state._workingMemorySnapshotLoaded === true) {
    return {
      snapshot: state._workingMemorySnapshot ?? null,
      loadedNow: false,
      persistable: state._workingMemorySnapshotPersistable === true,
    };
  }

  try {
    const raw = await getMemory().getWorkingMemory({
      threadId: state.threadId ?? state.sessionId,
      resourceId: state.resourceId,
      memoryConfig: QINGAGENT_WORKING_MEMORY_CONFIG,
    });
    state._workingMemorySnapshot = normalizeWorkingMemory(raw);
    state._workingMemorySnapshotPersistable = true;
  } catch (error) {
    logger.warn("[workingMemory] failed to load frozen snapshot", {
      sessionId: state.sessionId,
      resourceId: state.resourceId,
      error: String(error),
    });
    state._workingMemorySnapshot = null;
    state._workingMemorySnapshotPersistable = false;
  }

  state._workingMemorySnapshotLoaded = true;
  return {
    snapshot: state._workingMemorySnapshot ?? null,
    loadedNow: true,
    persistable: state._workingMemorySnapshotPersistable === true,
  };
}

export function createUpdateWorkingMemoryTool(state: SessionState) {
  return createTool({
    id: "updateWorkingMemory",
    description:
      "更新用户长期记忆。仅在用户明确要求记住，或提供稳定偏好/长期背景/跨会话复用事实时调用。" +
      "传入完整的 Markdown 记忆内容；本会话内上下文快照不会改变，更新只在下一个会话生效。",
    inputSchema: z.object({
      memory: z
        .string()
        .max(QINGAGENT_WORKING_MEMORY_MAX_CHARS)
        .describe("完整的 Markdown 长期记忆内容。空字符串表示清空长期记忆。"),
      reason: z.string().optional().describe("更新原因，便于调试；不会展示给用户。"),
    }),
    outputSchema: z.object({
      ok: z.boolean(),
      effective: z.literal("next_session").optional(),
      error: z.string().optional(),
    }),
    execute: async (input, context) => {
      const writeGuard = captureTurnWriteGuard(state, context);
      try {
        const nextMemory = normalizeWorkingMemory(input.memory) ?? "";
        // Mastra 1.22.1 的 updateWorkingMemory 不接 AbortSignal/CAS。这里紧贴
        // 不可取消的外部写边界做 owner/generation CAS；一旦调用已获准进入，
        // 后续 stop 不能再把已经落库的结果写后判成失败，也不做危险回滚。
        assertTurnWriteAllowed(state, writeGuard);
        await getMemory().updateWorkingMemory({
          threadId: state.threadId ?? state.sessionId,
          resourceId: state.resourceId,
          workingMemory: nextMemory,
          memoryConfig: QINGAGENT_WORKING_MEMORY_CONFIG,
        });
        state._workingMemoryUpdatedThisSession = true;
        logger.info("[workingMemory] updated", {
          sessionId: state.sessionId,
          resourceId: state.resourceId,
          chars: nextMemory.length,
          reason: input.reason ?? null,
        });
        return { ok: true, effective: "next_session" as const };
      } catch (error) {
        logger.warn("[workingMemory] update failed", {
          sessionId: state.sessionId,
          resourceId: state.resourceId,
          error: String(error),
        });
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
  });
}

function normalizeWorkingMemory(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.replace(/\r\n/g, "\n").trim();
  if (!normalized) return null;
  return normalized.slice(0, QINGAGENT_WORKING_MEMORY_MAX_CHARS);
}
