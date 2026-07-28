import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BridgeFrame, LegacySection } from "@qingagent/contract-ts";
import {
  getPmContentHash,
  normalizeStoredPmDoc,
  pmToLegacySections,
  type PmBlockNode,
  type PmDoc,
  type PmInlineNode,
  type PmMark,
} from "@qingagent/pm-schema";
import { rehydratePendingDraft } from "../doc-engine/pendingDraftRehydrate.js";
import { buildDraftDiff } from "../doc-engine/proposalDiff.js";
import { createSuggestionFromDiffHunk } from "../doc-engine/draftReviewSuggestions.js";
import { commitReviewGroups, updatePatchVerdict } from "../doc-engine/reviewCommit.js";
import { createSession } from "../session/sessionState.js";
import {
  __resetMigrationsForTest,
  documentDraftRepo,
  documentRepo,
  findOpByDocumentVersion,
  getDocumentsClient,
  listDocumentSuggestionStatuses,
  listVersions,
  runMigrations,
  upsertDocumentSuggestion,
} from "@qingagent/db";
import {
  documentInput,
  prepareTempDocumentsDb,
  type TempDocumentsDb,
} from "@qingagent/db/testing";
import { MIGRATIONS } from "@qingagent/db/migrations/registry";

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

function legacyListBaseJson(): string {
  return JSON.stringify({
    type: "doc",
    attrs: { schemaVersion: 1 },
    content: [{
      type: "bulletList",
      attrs: { blockId: "legacy-list" },
      content: [{
        type: "listItem",
        attrs: { blockId: "legacy-item" },
        content: [{
          type: "heading",
          attrs: { blockId: "legacy-heading", level: 3 },
          content: [{ type: "text", text: "规整前基线" }],
        }],
      }],
    }],
  });
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

  it("loadSessionFromThread 冷恢复冲突时保留 draftingFailed 恢复帧", async () => {
    const sessionId = "rehy-load-conflict";
    const persistedBase = doc([paragraph("block-a", "旧基线")]);
    const current = doc([paragraph("block-a", "已变化正文")]);
    const draft = doc([paragraph("block-a", "待审草稿")]);
    await seedDocument(sessionId, current, 5);
    await documentDraftRepo.savePending({
      docId: sessionId,
      threadId: sessionId,
      baseVersion: 4,
      baseHash: getPmContentHash(persistedBase),
      draftPmDoc: draft,
    });
    threads.set(sessionId, {
      id: sessionId,
      title: "冲突恢复测试",
      resourceId: "qingagent-user",
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      updatedAt: new Date("2026-01-01T00:00:00.000Z"),
      metadata: {
        docId: sessionId,
        docState: { kind: "pendingReview" },
        docVersion: 4,
        doc: persistedBase,
        legacySections: pmToLegacySections(persistedBase),
        messages: [],
      },
    });

    const { loadSessionFromThread } = await import("../session/threadPersistence.js");
    const restored = await loadSessionFromThread(sessionId);

    expect(restored?.docState).toEqual({ kind: "editing" });
    expect(restored?.suggestions.size).toBe(0);
    expect(restored?._pendingDraftRecoveryFrames).toEqual([
      {
        kind: "stream",
        data: {
          kind: "draftingFailed",
          data: {
            streamId: `restored-pending-review:${sessionId}`,
            reason: "正文已变化，请重新生成本轮审阅。",
            retriable: false,
          },
        },
      },
    ]);
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

  it("启动恢复命中 0025 阻断时保留草稿与建议原状", async () => {
    const sessionId = "rehy-recovery-blocked";
    const persistedBase = doc([paragraph("block-a", "旧基线")]);
    const current = doc([paragraph("block-a", "已被覆盖的正文")]);
    const draft = doc([paragraph("block-a", "必须保留的待审草稿")]);
    await seedDocument(sessionId, current, 9);
    await documentDraftRepo.savePending({
      docId: sessionId,
      threadId: sessionId,
      baseVersion: 1,
      baseHash: getPmContentHash(persistedBase),
      draftPmDoc: draft,
    });
    const pendingSuggestion = createSuggestionFromDiffHunk({
      hunk: buildDraftDiff(persistedBase, draft, { baseVersion: 1 })[0]!,
      docId: sessionId,
      baseVersion: 1,
      baseSchemaVersion: 1,
    });
    await upsertDocumentSuggestion(pendingSuggestion);
    await getDocumentsClient().execute({
      sql: `INSERT INTO document_write_blocks (
        doc_id, reason, source_doc_id, source_thread_id, version_id
      ) VALUES (?, 'quarantine_0002_foreign_snapshot', ?, ?, ?)`,
      args: [sessionId, "source-doc", sessionId, "source-version"],
    });
    const beforeDraft = await documentDraftRepo.load(sessionId);
    const beforeSuggestions = await getDocumentsClient().execute({
      sql: `SELECT id, status, conflict_json, updated_at
        FROM document_suggestions
        WHERE doc_id = ?
        ORDER BY id`,
      args: [sessionId],
    });
    const state = createSession(sessionId);
    state.doc = current;
    state.legacySections = pmToLegacySections(current) as never;
    state.docVersion = 9;
    state.docState = { kind: "editing" };

    const result = await rehydratePendingDraft(state);

    expect(result).toEqual({ kind: "skipped" });
    await expect(documentDraftRepo.load(sessionId)).resolves.toEqual(beforeDraft);
    const afterSuggestions = await getDocumentsClient().execute({
      sql: `SELECT id, status, conflict_json, updated_at
        FROM document_suggestions
        WHERE doc_id = ?
        ORDER BY id`,
      args: [sessionId],
    });
    expect(afterSuggestions.rows).toEqual(beforeSuggestions.rows);
    expect(state.docState).toEqual({ kind: "editing" });
    expect(state.suggestions.size).toBe(0);
  });

  it("0025 规整基线同步 draft base_hash，启动恢复不误报 mismatch", async () => {
    const sessionId = "rehy-normalized-base-hash";
    await runMigrations(MIGRATIONS.slice(0, 24));
    const client = getDocumentsClient();
    const legacyBaseJson = legacyListBaseJson();
    const legacyBaseHash = getPmContentHash(JSON.parse(legacyBaseJson));
    const pendingDraft = doc([paragraph("draft-p", "合法待审草稿")]);
    await client.execute({
      sql: `INSERT INTO documents (
        id, thread_id, resource_id, title, doc_state, doc_version,
        last_synced_version, doc_pm, doc_schema_version, content_hash,
        doc_format, version, created_at, updated_at, role
      ) VALUES (
        ?, ?, 'qingagent-user', '规整恢复', 'editing', 1, 1, ?, 1, ?,
        'pm', 1, '2026-07-24T00:00:00.000Z',
        '2026-07-24T00:00:00.000Z', 'main'
      )`,
      args: [sessionId, sessionId, legacyBaseJson, legacyBaseHash],
    });
    await client.execute({
      sql: `INSERT INTO document_drafts (
        doc_id, thread_id, base_version, base_hash, draft_pm, status,
        conflict_json, batch_id, review_batch_id, group_mode, source_stream_id,
        source_tool_call_id, created_at, updated_at
      ) VALUES (
        ?, ?, 1, ?, ?, 'pending_review', NULL, 'legacy', NULL, NULL, NULL,
        NULL, '2026-07-24T00:00:00.000Z', '2026-07-24T00:00:00.000Z'
      )`,
      args: [sessionId, sessionId, legacyBaseHash, JSON.stringify(pendingDraft)],
    });
    __resetMigrationsForTest();
    const appliedIds = (await runMigrations()).appliedIds;
    expect(appliedIds.filter((id) => id === 25)).toEqual([25]);
    const normalizedRow = (await client.execute({
      sql: "SELECT doc_pm, content_hash FROM documents WHERE id = ?",
      args: [sessionId],
    })).rows[0]!;
    const normalizedBase = normalizeStoredPmDoc(
      JSON.parse(String(normalizedRow.doc_pm)) as unknown,
    );
    const normalizedBaseHash = getPmContentHash(normalizedBase);
    expect(normalizedBaseHash).not.toBe(legacyBaseHash);
    expect(String(normalizedRow.content_hash)).toBe(normalizedBaseHash);
    await expect(documentDraftRepo.load(sessionId)).resolves.toMatchObject({
      baseHash: normalizedBaseHash,
      status: "pending_review",
    });
    const state = createSession(sessionId);
    state.doc = normalizedBase;
    state.legacySections = pmToLegacySections(normalizedBase) as never;
    state.docVersion = 1;

    const result = await rehydratePendingDraft(state);

    expect(result.kind).toBe("restored");
    await expect(documentDraftRepo.load(sessionId)).resolves.toMatchObject({
      baseHash: normalizedBaseHash,
      status: "pending_review",
      conflict: null,
    });
    expect(state.docState).toEqual({ kind: "pendingReview" });
  });

  it("F8: 恢复 pending draft 时补写活动批次缺失的 suggestion 行", async () => {
    const state = createSession("rehy-missing-suggestion-row");
    const base = doc([
      paragraph("block-a", "甲旧"),
      paragraph("block-b", "乙旧"),
    ]);
    const draft = doc([
      paragraph("block-a", "甲新"),
      paragraph("block-b", "乙新"),
    ]);
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
    const hunks = buildDraftDiff(base, draft, { baseVersion: 1 });
    await upsertDocumentSuggestion(createSuggestionFromDiffHunk({
      hunk: hunks[0]!,
      docId: state.docId,
      baseVersion: 1,
      baseSchemaVersion: 1,
    }));

    await rehydratePendingDraft(state);

    await expect(listDocumentSuggestionStatuses(
      state.docId,
      1,
      hunks.map((hunk) => hunk.hunkId),
    )).resolves.toHaveLength(hunks.length);
  });

  it("拒绝后重启恢复裁决，再提交时不应用已拒绝修改", async () => {
    const sessionId = "rehy-rejected-verdict";
    const base = doc([
      paragraph("block-a", "甲旧"),
      paragraph("block-b", "乙旧"),
    ]);
    const draft = doc([
      paragraph("block-a", "甲新"),
      paragraph("block-b", "乙新"),
    ]);
    await seedDocument(sessionId, base);
    await documentDraftRepo.savePending({
      docId: sessionId,
      threadId: sessionId,
      baseVersion: 1,
      baseHash: getPmContentHash(base),
      draftPmDoc: draft,
    });
    const originalHunks = buildDraftDiff(base, draft, { baseVersion: 1 });
    for (const hunk of originalHunks) {
      await upsertDocumentSuggestion(createSuggestionFromDiffHunk({
        hunk,
        docId: sessionId,
        baseVersion: 1,
        baseSchemaVersion: 1,
      }));
    }

    const beforeRestart = createSession(sessionId);
    beforeRestart.doc = base;
    beforeRestart.legacySections = pmToLegacySections(base) as never;
    beforeRestart.docVersion = 1;
    await rehydratePendingDraft(beforeRestart);
    const rejectedHunk = originalHunks[0]!;
    for await (const _frame of updatePatchVerdict(beforeRestart, rejectedHunk.hunkId, "rejected")) {
      // 命令帧消费完即代表裁决已落库。
    }

    const afterRestart = createSession(sessionId);
    afterRestart.doc = base;
    afterRestart.legacySections = pmToLegacySections(base) as never;
    afterRestart.docVersion = 1;
    const restored = await rehydratePendingDraft(afterRestart);
    const restoredIds = [...afterRestart.suggestions.keys()];

    expect(restoredIds).toEqual(originalHunks.map((hunk) => hunk.hunkId));
    expect(afterRestart.patchVerdicts.get(rejectedHunk.hunkId)).toBe("rejected");
    expect(afterRestart.suggestions.get(rejectedHunk.hunkId)?.suggestion.status).toBe("rejected");
    expect(restored.kind === "restored"
      ? restored.frames.find((frame) => frame.kind === "docDiffReady")?.data.suggestions
        .find((suggestion) => suggestion.id === rejectedHunk.hunkId)?.status
      : undefined).toBe("rejected");

    const acceptedHunk = originalHunks[1]!;
    for await (const _frame of commitReviewGroups(afterRestart, {
      acceptReviewBatchIds: [acceptedHunk.reviewBatchId],
      rejectReviewBatchIds: [rejectedHunk.reviewBatchId],
    })) {
      // 提交完整消费。
    }
    expect(docText(afterRestart.doc)).toBe("甲旧\n乙新");
  });

  it("分批提交 rebase 后新批次裁决落库并可在重启后恢复", async () => {
    const sessionId = "rehy-rebased-verdict";
    const base = doc([
      paragraph("block-a", "甲旧"),
      paragraph("block-b", "乙旧"),
      paragraph("block-c", "丙旧"),
    ]);
    const draft = doc([
      paragraph("block-a", "甲新"),
      paragraph("block-b", "乙新"),
      paragraph("block-c", "丙新"),
    ]);
    await seedDocument(sessionId, base);
    await documentDraftRepo.savePending({
      docId: sessionId,
      threadId: sessionId,
      baseVersion: 1,
      baseHash: getPmContentHash(base),
      draftPmDoc: draft,
    });
    const originalHunks = buildDraftDiff(base, draft, { baseVersion: 1 });
    for (const hunk of originalHunks) {
      await upsertDocumentSuggestion(createSuggestionFromDiffHunk({
        hunk,
        docId: sessionId,
        baseVersion: 1,
        baseSchemaVersion: 1,
      }));
    }

    const beforeRestart = createSession(sessionId);
    beforeRestart.doc = base;
    beforeRestart.legacySections = pmToLegacySections(base) as never;
    beforeRestart.docVersion = 1;
    await rehydratePendingDraft(beforeRestart);
    const [committedHunk, ...keptHunks] = originalHunks;
    if (!committedHunk || keptHunks.length < 2) throw new Error("fixture missing hunks");
    for await (const _frame of commitReviewGroups(beforeRestart, {
      acceptReviewBatchIds: [committedHunk.reviewBatchId],
      keepPendingReviewBatchIds: keptHunks.map((hunk) => hunk.reviewBatchId),
    })) {
      // 完整消费后 rebase 新批次已先于 docDiffReady 落库。
    }

    expect(beforeRestart.docVersion).toBe(2);
    const rebasedSuggestion = [...beforeRestart.suggestions.values()]
      .find((record) => record.diffHunk?.anchor.blockId === "block-b")?.suggestion;
    if (!rebasedSuggestion) throw new Error("fixture missing rebased suggestion");
    for await (const _frame of updatePatchVerdict(
      beforeRestart,
      rebasedSuggestion.id,
      "accepted",
    )) {
      // 命令完成即代表新 baseVersion 下的裁决已落库。
    }

    const oldRows = await getDocumentsClient().execute({
      sql: "SELECT id, status FROM document_suggestions WHERE doc_id = ? AND base_version = 1",
      args: [sessionId],
    });
    expect(oldRows.rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: committedHunk.hunkId, status: "committed" }),
      ...keptHunks.map((hunk) => expect.objectContaining({ id: hunk.hunkId, status: "ignored" })),
    ]));

    const afterRestart = createSession(sessionId);
    afterRestart.doc = beforeRestart.doc;
    afterRestart.legacySections = pmToLegacySections(beforeRestart.doc!) as never;
    afterRestart.docVersion = beforeRestart.docVersion;
    const restored = await rehydratePendingDraft(afterRestart);

    expect(restored.kind).toBe("restored");
    expect(afterRestart.patchVerdicts.get(rebasedSuggestion.id)).toBe("accepted");
    expect(afterRestart.suggestions.get(rebasedSuggestion.id)?.suggestion.status).toBe("accepted");
  });

  it("F7: 先裁决 B、仅提交 A 后重启仍恢复 B 的裁决", async () => {
    const sessionId = "rehy-verdict-before-rebase";
    const base = doc([
      paragraph("block-a", "甲旧"),
      paragraph("block-b", "乙旧"),
    ]);
    const draft = doc([
      paragraph("block-a", "甲新"),
      paragraph("block-b", "乙新"),
    ]);
    await seedDocument(sessionId, base);
    await documentDraftRepo.savePending({
      docId: sessionId,
      threadId: sessionId,
      baseVersion: 1,
      baseHash: getPmContentHash(base),
      draftPmDoc: draft,
    });
    const originalHunks = buildDraftDiff(base, draft, { baseVersion: 1 });
    for (const hunk of originalHunks) {
      await upsertDocumentSuggestion(createSuggestionFromDiffHunk({
        hunk,
        docId: sessionId,
        baseVersion: 1,
        baseSchemaVersion: 1,
      }));
    }

    const beforeRestart = createSession(sessionId);
    beforeRestart.doc = base;
    beforeRestart.legacySections = pmToLegacySections(base) as never;
    beforeRestart.docVersion = 1;
    await rehydratePendingDraft(beforeRestart);
    const hunkA = originalHunks.find((hunk) => hunk.anchor.blockId === "block-a");
    const hunkB = originalHunks.find((hunk) => hunk.anchor.blockId === "block-b");
    if (!hunkA || !hunkB) throw new Error("fixture missing hunks");

    for await (const _frame of updatePatchVerdict(beforeRestart, hunkB.hunkId, "accepted")) {
      // 先保存 B 的裁决，再单独提交 A。
    }
    const frames: BridgeFrame[] = [];
    for await (const frame of commitReviewGroups(beforeRestart, {
      acceptReviewBatchIds: [hunkA.reviewBatchId],
      keepPendingReviewBatchIds: [hunkB.reviewBatchId],
    })) {
      frames.push(frame);
    }

    const rebasedB = [...beforeRestart.suggestions.values()]
      .find((record) => record.diffHunk?.anchor.blockId === "block-b")?.suggestion;
    if (!rebasedB) throw new Error("fixture missing rebased B");
    expect(beforeRestart.patchVerdicts.get(rebasedB.id)).toBe("accepted");
    expect(rebasedB.status).toBe("accepted");
    const rebasedBCard = frames
      .filter((frame) => frame.kind === "toolCallUpdated")
      .find((frame) => frame.kind === "toolCallUpdated" && frame.data.toolCallId === rebasedB.id);
    expect(rebasedBCard?.data.spec.status.kind).toBe("accepted");

    const afterRestart = createSession(sessionId);
    afterRestart.doc = beforeRestart.doc;
    afterRestart.legacySections = pmToLegacySections(beforeRestart.doc!) as never;
    afterRestart.docVersion = beforeRestart.docVersion;
    await rehydratePendingDraft(afterRestart);

    expect(afterRestart.patchVerdicts.get(rebasedB.id)).toBe("accepted");
    expect(afterRestart.suggestions.get(rebasedB.id)?.suggestion.status).toBe("accepted");
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

  it("snapshot 恢复跳过首稿候选提交与草稿清理", async () => {
    const sessionId = "rehy-first-snapshot";
    const draft = doc([paragraph("block-first", "只读首稿")]);
    const frozenThreadTime = "2025-01-02T03:04:05.000Z";
    threads.set(sessionId, {
      id: sessionId,
      title: "只读恢复",
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
        title: "只读恢复",
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
      sourceStreamId: "stream-snapshot",
      sourceToolCallId: "wd-snapshot",
    });
    const { loadSessionFromThread } = await import("../session/threadPersistence.js");

    const restored = await loadSessionFromThread(sessionId, { mode: "snapshot" });

    expect(restored?.docVersion).toBe(0);
    await expect(documentRepo.load(sessionId)).resolves.toBeNull();
    await expect(documentDraftRepo.load(sessionId)).resolves.toMatchObject({
      status: "draft_candidate",
      sourceStreamId: "stream-snapshot",
    });
    await expect(listVersions(sessionId)).resolves.toHaveLength(0);
    expect(memory.updateThread).not.toHaveBeenCalled();
  });
});
