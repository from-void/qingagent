import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LegacySection } from "@qingagent/contract-ts";
import {
  getPmContentHash,
  pmToLegacySections,
  type PmBlockNode,
  type PmDoc,
  type PmInlineNode,
  type PmMark,
} from "@qingagent/pm-schema";
import { rehydratePendingDraft } from "../doc-engine/pendingDraftRehydrate.js";
import { buildDraftDiff } from "../doc-engine/proposalDiff.js";
import { createSession } from "../session/sessionState.js";
import { documentDraftRepo } from "@qingagent/db";
import { documentRepo } from "@qingagent/db";
import { getDocumentsClient } from "@qingagent/db";
import { findOpByDocumentVersion } from "@qingagent/db";
import { listVersions } from "@qingagent/db";
import {
  documentInput,
  prepareTempDocumentsDb,
  type TempDocumentsDb,
} from "@qingagent/db/testing";

const { memory, threads } = vi.hoisted(() => {
  const threads = new Map<string, Record<string, unknown>>();
  const memory = {
    getThreadById: vi.fn(async ({ threadId }: { threadId: string }) => threads.get(threadId) ?? null),
    recall: vi.fn(async () => ({ messages: [] })),
    listThreads: vi.fn(async () => ({ threads: [], total: 0, hasMore: false })),
    updateThread: vi.fn(async ({ id, title, metadata }: {
      id: string;
      title: string;
      metadata: Record<string, unknown>;
    }) => {
      const existing = threads.get(id);
      if (!existing) throw new Error("thread not found");
      const next = { ...existing, title, metadata, updatedAt: new Date() };
      threads.set(id, next);
      return next;
    }),
    saveThread: vi.fn(async ({ thread }: { thread: Record<string, unknown> }) => {
      threads.set(String(thread.id), thread);
      return thread;
    }),
  };
  return { memory, threads };
});

vi.mock("../mastra.js", () => ({
  mastra: {
    getLogger: () => ({
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
    getMemory: () => memory,
  },
  getObservability: () => null,
}));

vi.mock("../agents/qingagent.js", () => ({
  getQingagentSkills: vi.fn(async () => ({
    maybeRefresh: vi.fn(async () => {}),
    has: vi.fn(async () => false),
  })),
  qingagentAgent: { stream: vi.fn(), resumeStream: vi.fn() },
}));

let tempDb: TempDocumentsDb;

function text(value: string, marks?: PmMark[]): PmInlineNode {
  return marks && marks.length > 0
    ? { type: "text", text: value, marks }
    : { type: "text", text: value };
}

function paragraph(blockId: string, content: string | PmInlineNode[]): PmBlockNode {
  return {
    type: "paragraph",
    attrs: { blockId },
    content: typeof content === "string" ? [text(content)] : content,
  };
}

function doc(blocks: PmBlockNode[]): PmDoc {
  return { type: "doc", attrs: { schemaVersion: 1 }, content: blocks };
}

function docText(pmDoc: PmDoc | undefined): string {
  return (pmDoc?.content ?? [])
    .map((block) =>
      "content" in block && Array.isArray(block.content)
        ? block.content.map((node) => (node.type === "text" ? node.text : "\n")).join("")
        : "",
    )
    .join("\n");
}

async function seedDocument(sessionId: string, pmDoc: PmDoc, version = 1): Promise<void> {
  await documentRepo.save(
    documentInput(sessionId, {
      id: sessionId,
      threadId: sessionId,
      docVersion: version,
      lastSyncedVersion: version,
      legacySections: pmToLegacySections(pmDoc) as unknown as LegacySection[],
      pmDoc,
    }),
  );
}

beforeEach(() => {
  tempDb = prepareTempDocumentsDb("qingagent-pending-draft-");
  threads.clear();
  vi.clearAllMocks();
});

afterEach(() => {
  tempDb.cleanup();
});

describe("pending draft rehydrate", () => {
  it("loadSessionFromThread 刷新后重现待审,正文不覆盖", async () => {
    const sessionId = "rehy-load";
    const base = doc([paragraph("block-a", "旧正文")]);
    const draft = doc([paragraph("block-a", "新正文")]);
    await seedDocument(sessionId, base, 4);
    await documentDraftRepo.savePending({
      docId: sessionId,
      threadId: sessionId,
      baseVersion: 4,
      baseHash: getPmContentHash(base),
      draftPmDoc: draft,
    });
    threads.set(sessionId, {
      id: sessionId,
      title: "恢复测试",
      resourceId: "qingagent-user",
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      updatedAt: new Date("2026-01-01T00:00:00.000Z"),
      metadata: {
        docId: sessionId,
        docState: { kind: "editing" },
        docVersion: 4,
        legacySections: [],
        messages: [],
      },
    });

    const { loadSessionFromThread } = await import("../session/threadPersistence.js");
    const restored = await loadSessionFromThread(sessionId);

    expect(restored?.docState).toEqual({ kind: "pendingReview" });
    expect(docText(restored?.doc)).toBe("旧正文");
    expect(docText(restored?.docDraftCandidateDoc ?? undefined)).toBe("新正文");
    expect(restored?.suggestions.size).toBeGreaterThan(0);
    expect(restored?.suggestionBaseDoc).toEqual(base);
  });

  it("rehydrate 直接路径 hash 一致时发 docDiffReady 且不改 state.doc", async () => {
    const state = createSession("rehy-direct");
    const base = doc([paragraph("block-a", "旧正文")]);
    const draft = doc([paragraph("block-a", "新正文")]);
    state.doc = base;
    state.legacySections = pmToLegacySections(base) as never;
    state.docVersion = 1;
    await documentDraftRepo.savePending({
      docId: state.docId,
      threadId: state.sessionId,
      baseVersion: 1,
      baseHash: getPmContentHash(base),
      draftPmDoc: draft,
    });

    const result = await rehydratePendingDraft(state);

    expect(result.kind).toBe("restored");
    expect(result.kind === "restored" ? result.frames.some((frame) => frame.kind === "docDiffReady") : false).toBe(true);
    expect(docText(state.doc)).toBe("旧正文");
    expect(state.docState).toEqual({ kind: "pendingReview" });
  });

  it("hash 不一致时标记 conflict,不静默恢复审查", async () => {
    const bold: PmMark = { type: "bold" };
    const base = doc([paragraph("block-a", [text("正文")])]);
    const changedMarksOnly = doc([paragraph("block-a", [text("正文", [bold])])]);
    const draft = doc([paragraph("block-a", [text("草稿正文")])]);
    const state = createSession("rehy-conflict");
    state.doc = changedMarksOnly;
    state.legacySections = pmToLegacySections(changedMarksOnly) as never;
    state.docVersion = 2;
    await documentDraftRepo.savePending({
      docId: state.docId,
      threadId: state.sessionId,
      baseVersion: 1,
      baseHash: getPmContentHash(base),
      draftPmDoc: draft,
    });

    const result = await rehydratePendingDraft(state);
    const row = await documentDraftRepo.load(state.docId);

    expect(result.kind).toBe("conflict");
    expect(row?.status).toBe("conflict");
    expect(state.docState).toEqual({ kind: "editing" });
    expect(state.suggestions.size).toBe(0);
    expect(docText(state.doc)).toBe("正文");
    expect(state.docDraftCandidateDoc).toBeNull();
  });

  it("空 diff 清 row 回 editing", async () => {
    const state = createSession("rehy-empty");
    const base = doc([paragraph("block-a", "正文")]);
    state.doc = base;
    state.legacySections = pmToLegacySections(base) as never;
    state.docVersion = 3;
    await documentDraftRepo.savePending({
      docId: state.docId,
      threadId: state.sessionId,
      baseVersion: 2,
      baseHash: getPmContentHash(base),
      draftPmDoc: base,
    });

    const result = await rehydratePendingDraft(state);

    expect(result.kind).toBe("empty_diff");
    await expect(documentDraftRepo.load(state.docId)).resolves.toBeNull();
    expect(state.docState).toEqual({ kind: "editing" });
  });

  it("version 不一致但 hash 一致允许恢复,batch id 与同 diff 重算一致", async () => {
    const state = createSession("rehy-version-mismatch");
    const base = doc([paragraph("block-a", "湖边有柳树。他拿着蓝毛巾。")]);
    const draft = doc([paragraph("block-a", "湖边有胡桃树。他拿着黄毛巾。")]);
    state.doc = base;
    state.legacySections = pmToLegacySections(base) as never;
    state.docVersion = 8;
    const expected = buildDraftDiff(base, draft, { baseVersion: 7 }).map((hunk) => hunk.reviewBatchId);
    await documentDraftRepo.savePending({
      docId: state.docId,
      threadId: state.sessionId,
      baseVersion: 7,
      baseHash: getPmContentHash(base),
      draftPmDoc: draft,
    });

    const result = await rehydratePendingDraft(state);

    expect(result.kind).toBe("restored");
    expect([...state.suggestions.values()].map((record) => record.suggestion.reviewBatchId)).toEqual(expected);
  });

  it("rehydrate 后候选顶层 blockId 与持久草稿一致", async () => {
    const state = createSession("rehy-block-id");
    const base = doc([paragraph("block-base", "正文")]);
    const draft = doc([
      paragraph("block-empty-a", ""),
      paragraph("block-empty-b", ""),
      paragraph("block-base", "正文"),
    ]);
    const persistedIds = draft.content.map((block) => block.attrs.blockId);
    state.doc = base;
    state.legacySections = pmToLegacySections(base) as never;
    state.docVersion = 1;
    await documentDraftRepo.savePending({
      docId: state.docId,
      threadId: state.sessionId,
      baseVersion: 1,
      baseHash: getPmContentHash(base),
      draftPmDoc: draft,
    });

    const result = await rehydratePendingDraft(state);

    expect(result.kind).toBe("restored");
    expect(state.docDraftCandidateDoc?.content.map((block) => block.attrs.blockId)).toEqual(persistedIds);
  });

  it("draft_candidate 首稿恢复复用自然 generation opId,重复恢复不生成第二版", async () => {
    const sessionId = "rehy-first-candidate";
    const draft = doc([paragraph("block-first", "首稿候选正文")]);
    await documentDraftRepo.saveCandidate({
      docId: sessionId,
      threadId: sessionId,
      baseVersion: 0,
      baseHash: getPmContentHash(doc([])),
      draftPmDoc: draft,
      sourceStreamId: "stream-first",
      sourceToolCallId: "wd-first",
    });
    const firstState = createSession(sessionId);

    const first = await rehydratePendingDraft(firstState);

    expect(first.kind).toBe("restored");
    expect(firstState.docVersion).toBe(1);
    expect(docText(firstState.doc)).toBe("首稿候选正文");
    expect(firstState.lastContentEditedAt)
      .toBe((await findOpByDocumentVersion(sessionId, 1))?.createdAt);
    await expect(documentDraftRepo.load(sessionId)).resolves.toBeNull();
    await expect(listVersions(sessionId)).resolves.toHaveLength(1);

    await documentDraftRepo.saveCandidate({
      docId: sessionId,
      threadId: sessionId,
      baseVersion: 0,
      baseHash: getPmContentHash(doc([])),
      draftPmDoc: draft,
      sourceStreamId: "stream-first",
      sourceToolCallId: "wd-first",
    });
    const secondState = createSession(sessionId, "2020-01-01T00:00:00.000Z");

    const second = await rehydratePendingDraft(secondState);

    expect(second.kind).toBe("restored");
    expect(secondState.docVersion).toBe(1);
    expect(docText(secondState.doc)).toBe("首稿候选正文");
    expect(secondState.lastContentEditedAt).toBe("2020-01-01T00:00:00.000Z");
    await expect(listVersions(sessionId)).resolves.toHaveLength(1);
    const ops = await getDocumentsClient().execute({
      sql: "SELECT COUNT(*) AS c FROM document_ops WHERE op_id = ?",
      args: [`generation:${sessionId}:stream-first`],
    });
    expect(Number(ops.rows[0]?.c ?? 0)).toBe(1);
  });

  it("冷恢复首稿提交在 await 返回前落盘内容时间，第二次进程级冷开保持幂等", async () => {
    const sessionId = "rehy-first-candidate-cold-persist";
    const draft = doc([paragraph("block-first", "冷恢复首稿")]);
    const frozenThreadTime = "2025-01-02T03:04:05.000Z";
    threads.set(sessionId, {
      id: sessionId,
      title: "冷恢复",
      resourceId: "qingagent-user",
      createdAt: new Date(frozenThreadTime),
      updatedAt: new Date(frozenThreadTime),
      metadata: {
        docId: sessionId,
        docState: { kind: "empty" },
        docVersion: 0,
        lastContentEditedAt: frozenThreadTime,
        lastSyncedDocumentSnapshot: 0,
        legacySections: [],
        materials: [],
        title: "冷恢复",
        runId: null,
        toolCallId: null,
        askUserCompleted: false,
        lastPersistedAt: frozenThreadTime,
      },
    });
    await documentDraftRepo.saveCandidate({
      docId: sessionId,
      threadId: sessionId,
      baseVersion: 0,
      baseHash: getPmContentHash(doc([])),
      draftPmDoc: draft,
      sourceStreamId: "stream-cold",
      sourceToolCallId: "wd-cold",
    });
    const { loadSessionFromThread } = await import("../session/threadPersistence.js");

    const first = await loadSessionFromThread(sessionId);
    const opTime = (await findOpByDocumentVersion(sessionId, 1))?.createdAt;
    const persistedAfterAwait = threads.get(sessionId)?.metadata as {
      docVersion?: number;
      lastContentEditedAt?: string;
    };
    expect(first?.docVersion).toBe(1);
    expect(first?.lastContentEditedAt).toBe(opTime);
    expect(persistedAfterAwait).toMatchObject({
      docVersion: 1,
      lastContentEditedAt: opTime,
    });

    await documentDraftRepo.saveCandidate({
      docId: sessionId,
      threadId: sessionId,
      baseVersion: 0,
      baseHash: getPmContentHash(doc([])),
      draftPmDoc: draft,
      sourceStreamId: "stream-cold",
      sourceToolCallId: "wd-cold",
    });
    memory.updateThread.mockClear();
    const second = await loadSessionFromThread(sessionId);
    expect(second?.docVersion).toBe(1);
    expect(second?.lastContentEditedAt).toBe(opTime);
    expect(memory.updateThread).not.toHaveBeenCalled();
    await expect(listVersions(sessionId)).resolves.toHaveLength(1);
  });

  it("draft_candidate 首稿缺 source_stream_id 时标 conflict,不拼 undefined opId", async () => {
    const sessionId = "rehy-first-missing-source";
    const draft = doc([paragraph("block-first", "缺 source 的首稿")]);
    await documentDraftRepo.saveCandidate({
      docId: sessionId,
      threadId: sessionId,
      baseVersion: 0,
      baseHash: getPmContentHash(doc([])),
      draftPmDoc: draft,
      sourceStreamId: "stream-to-null",
      sourceToolCallId: "wd-first",
    });
    await getDocumentsClient().execute({
      sql: "UPDATE document_drafts SET source_stream_id = NULL WHERE doc_id = ?",
      args: [sessionId],
    });
    const state = createSession(sessionId);

    const result = await rehydratePendingDraft(state);
    const row = await documentDraftRepo.load(sessionId);
    const badOps = await getDocumentsClient().execute({
      sql: "SELECT COUNT(*) AS c FROM document_ops WHERE op_id = ?",
      args: [`generation:${sessionId}:undefined`],
    });

    expect(result.kind).toBe("conflict");
    expect(row?.status).toBe("conflict");
    expect(row?.conflict).toMatchObject({ kind: "missing_source_stream_id" });
    expect(Number(badOps.rows[0]?.c ?? 0)).toBe(0);
    await expect(listVersions(sessionId)).resolves.toHaveLength(0);
  });
});
