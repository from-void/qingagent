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

export const QINGAGENT_WORKING_MEMORY_SECTIONS = [
  "稳定偏好",
  "长期任务与背景",
  "其他可复用事实",
] as const;

export type WorkingMemorySection = typeof QINGAGENT_WORKING_MEMORY_SECTIONS[number];

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

const workingMemorySectionSchema = z.enum(QINGAGENT_WORKING_MEMORY_SECTIONS);
const workingMemoryEntrySchema = z
  .string()
  .trim()
  .min(1)
  .max(1_000)
  .refine((value) => !/[\r\n]/.test(value), "记忆条目必须写在一行内");

export const workingMemoryOperationSchema = z.object({
  action: z.enum(["upsert", "remove"]),
  section: workingMemorySectionSchema,
  entry: workingMemoryEntrySchema.describe("一行记忆条目，不含 Markdown 列表符号。"),
  match: z
    .string()
    .trim()
    .min(1)
    .max(500)
    .optional()
    .describe("要替换或删除的旧条目匹配子串；upsert 不传时追加新条目。"),
}).strict();

export type WorkingMemoryOperation = z.infer<typeof workingMemoryOperationSchema>;

export type WorkingMemorySnapshotResult = {
  snapshot: string | null;
  loadedNow: boolean;
  persistable: boolean;
};

export class WorkingMemoryContentError extends Error {
  readonly code: "too_long" | "entry_not_found";

  constructor(code: "too_long" | "entry_not_found", message: string) {
    super(message);
    this.name = "WorkingMemoryContentError";
    this.code = code;
  }
}

export interface WorkingMemoryStorageTarget {
  resourceId: string;
  threadId?: string;
}

const workingMemoryWriteQueues = new Map<string, Promise<void>>();

export async function withWorkingMemoryWriteLock<T>(
  target: WorkingMemoryStorageTarget,
  task: () => Promise<T>,
): Promise<T> {
  const previous = workingMemoryWriteQueues.get(target.resourceId) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const queued = previous.then(() => gate);
  workingMemoryWriteQueues.set(target.resourceId, queued);
  await previous;
  try {
    return await task();
  } finally {
    release();
    if (workingMemoryWriteQueues.get(target.resourceId) === queued) {
      workingMemoryWriteQueues.delete(target.resourceId);
    }
  }
}

export function normalizeWorkingMemoryContent(
  value: string | null | undefined,
): string {
  if (typeof value !== "string") return "";
  return value.replace(/\r\n?/g, "\n").trim();
}

export async function readWorkingMemoryContent(
  target: WorkingMemoryStorageTarget,
): Promise<string> {
  const raw = await getMemory().getWorkingMemory({
    threadId: target.threadId ?? target.resourceId,
    resourceId: target.resourceId,
    memoryConfig: QINGAGENT_WORKING_MEMORY_CONFIG,
  });
  return normalizeWorkingMemoryContent(raw);
}

export async function writeWorkingMemoryContent(
  target: WorkingMemoryStorageTarget,
  content: string,
): Promise<string> {
  const normalized = normalizeWorkingMemoryContent(content);
  if (normalized.length > QINGAGENT_WORKING_MEMORY_MAX_CHARS) {
    throw new WorkingMemoryContentError(
      "too_long",
      `长期记忆不能超过 ${QINGAGENT_WORKING_MEMORY_MAX_CHARS} 字，请先删除旧条目后再保存。`,
    );
  }
  await getMemory().updateWorkingMemory({
    threadId: target.threadId ?? target.resourceId,
    resourceId: target.resourceId,
    workingMemory: normalized,
    memoryConfig: QINGAGENT_WORKING_MEMORY_CONFIG,
  });
  return normalized;
}

type WorkingMemoryEntries = Record<WorkingMemorySection, string[]>;

const templateEntries: WorkingMemoryEntries = {
  稳定偏好: ["称呼:", "写作风格:", "常用格式:", "明确禁忌:"],
  长期任务与背景: ["当前长期目标:", "重要项目:", "约束条件:"],
  其他可复用事实: [],
};

function emptyEntries(includeTemplateEntries: boolean): WorkingMemoryEntries {
  return {
    稳定偏好: includeTemplateEntries ? [...templateEntries.稳定偏好] : [],
    长期任务与背景: includeTemplateEntries ? [...templateEntries.长期任务与背景] : [],
    其他可复用事实: [],
  };
}

function parseWorkingMemoryEntries(content: string): WorkingMemoryEntries {
  const normalized = normalizeWorkingMemoryContent(content);
  if (!normalized) return emptyEntries(true);

  const entries = emptyEntries(false);
  const seenSections = new Set<WorkingMemorySection>();
  let currentSection: WorkingMemorySection = "其他可复用事实";

  for (const rawLine of normalized.split("\n")) {
    const line = rawLine.trim();
    if (!line || line === "# 用户长期记忆") continue;
    const heading = line.match(/^##\s+(.+)$/)?.[1]?.trim();
    if (heading && QINGAGENT_WORKING_MEMORY_SECTIONS.includes(heading as WorkingMemorySection)) {
      currentSection = heading as WorkingMemorySection;
      seenSections.add(currentSection);
      continue;
    }
    if (/^#{1,6}\s+/.test(line)) continue;
    const entry = line.replace(/^[-*+]\s*/, "").trim();
    if (entry) {
      const legacySection = seenSections.size === 0
        ? QINGAGENT_WORKING_MEMORY_SECTIONS.find((section) =>
          templateEntries[section].some((placeholder) => entry.startsWith(placeholder)))
        : undefined;
      entries[legacySection ?? currentSection].push(entry);
    }
  }

  for (const section of QINGAGENT_WORKING_MEMORY_SECTIONS) {
    if (!seenSections.has(section) && entries[section].length === 0) {
      entries[section] = [...templateEntries[section]];
    }
  }
  return entries;
}

function serializeWorkingMemoryEntries(entries: WorkingMemoryEntries): string {
  const lines = ["# 用户长期记忆"];
  for (const section of QINGAGENT_WORKING_MEMORY_SECTIONS) {
    lines.push("", `## ${section}`);
    const sectionEntries = entries[section];
    if (sectionEntries.length === 0) lines.push("- ");
    else lines.push(...sectionEntries.map((entry) => `- ${entry}`));
  }
  return normalizeWorkingMemoryContent(lines.join("\n"));
}

export function mergeWorkingMemoryOperations(
  currentContent: string | null | undefined,
  operations: WorkingMemoryOperation[],
): string {
  const entries = parseWorkingMemoryEntries(currentContent ?? "");

  for (const operation of operations) {
    const sectionEntries = entries[operation.section];
    const needle = operation.match ?? operation.entry;
    const index = sectionEntries.findIndex((entry) => entry.includes(needle));
    if (operation.action === "remove") {
      if (index < 0) {
        throw new WorkingMemoryContentError(
          "entry_not_found",
          `未在「${operation.section}」找到包含“${needle}”的记忆条目。`,
        );
      }
      sectionEntries.splice(index, 1);
      continue;
    }
    if (operation.match === undefined) {
      if (!sectionEntries.includes(operation.entry)) {
        sectionEntries.push(operation.entry);
      }
    } else if (index >= 0) sectionEntries[index] = operation.entry;
    else {
      throw new WorkingMemoryContentError(
        "entry_not_found",
        `未在「${operation.section}」找到包含“${needle}”的记忆条目。`,
      );
    }
  }

  const merged = serializeWorkingMemoryEntries(entries);
  if (merged.length > QINGAGENT_WORKING_MEMORY_MAX_CHARS) {
    throw new WorkingMemoryContentError(
      "too_long",
      `合并后长期记忆超过 ${QINGAGENT_WORKING_MEMORY_MAX_CHARS} 字，请先 remove 旧条目再重试。`,
    );
  }
  return merged;
}

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
      "用条目级操作更新用户长期记忆。用户表达稳定的称呼、语气、写作风格、格式偏好或明确禁忌时应主动调用；" +
      "用户说“记住”或“以后都这样”时必须调用。不要写入一次性任务细节，也绝不要重抄全文。" +
      "本会话内上下文快照不会改变，更新只在下一个会话生效。",
    inputSchema: z.object({
      ops: z
        .array(workingMemoryOperationSchema)
        .min(1)
        .max(20)
        .describe("按顺序执行的条目级追加、替换或删除操作。"),
      reason: z.string().optional().describe("更新原因，便于调试；不会展示给用户。"),
    }).strict(),
    outputSchema: z.object({
      ok: z.boolean(),
      effective: z.literal("next_session").optional(),
      error: z.string().optional(),
    }),
    execute: async (input, context) => {
      const writeGuard = captureTurnWriteGuard(state, context);
      try {
        const target = {
          threadId: state.threadId ?? state.sessionId,
          resourceId: state.resourceId,
        };
        const nextMemory = await withWorkingMemoryWriteLock(target, async () => {
          const currentMemory = await readWorkingMemoryContent(target);
          const merged = mergeWorkingMemoryOperations(currentMemory, input.ops);
          // Mastra 1.22.1 的 updateWorkingMemory 不接 AbortSignal/CAS。这里紧贴
          // 不可取消的外部写边界做 owner/generation CAS；一旦调用已获准进入，
          // 后续 stop 不能再把已经落库的结果写后判成失败，也不做危险回滚。
          assertTurnWriteAllowed(state, writeGuard);
          await writeWorkingMemoryContent(target, merged);
          return merged;
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
  const normalized = normalizeWorkingMemoryContent(value);
  if (!normalized) return null;
  return normalized.slice(0, QINGAGENT_WORKING_MEMORY_MAX_CHARS);
}
