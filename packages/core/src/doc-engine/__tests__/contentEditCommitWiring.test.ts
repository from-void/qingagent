import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BridgeFrame, DiffHunk, LegacySection } from "@qingagent/contract-ts";
import {
  getDeterministicId,
  materializeDraftBlockIds,
  normalizePmDoc,
  pmToLegacySections,
  pmToPlainText,
  type PmDoc,
} from "@qingagent/pm-schema";
import {
  commitPatches,
  createSession,
  createSessionScopedTools,
  settleDraftCandidate,
} from "../../bridge/index.js";
import { commitDocumentOp } from "../commitDocumentOp.js";
import { __resetDocCommitQueueForTest } from "../docCommitQueue.js";
import { diffHunkToStep } from "../draftReviewSuggestions.js";
import { applyDiffHunks } from "../proposalDiff.js";
import { documentRepo } from "@qingagent/db";
import { getDocumentsClient } from "@qingagent/db";
import { listVersions } from "@qingagent/db";
import {
  documentInput,
  prepareTempDocumentsDb,
  type TempDocumentsDb,
} from "@qingagent/db/testing";

const workspaceRoot = fileURLToPath(new URL("../../../../..", import.meta.url));
let tempDb: TempDocumentsDb;

beforeEach(() => {
  tempDb = prepareTempDocumentsDb("qingagent-typed-block-commit-");
  __resetDocCommitQueueForTest();
});

afterEach(() => {
  __resetDocCommitQueueForTest();
  tempDb.cleanup();
});

async function collectFrames(gen: AsyncIterable<BridgeFrame>): Promise<BridgeFrame[]> {
  const frames: BridgeFrame[] = [];
  for await (const frame of gen) frames.push(frame);
  return frames;
}

function editorTypedDoc(text: string): PmDoc {
  return {
    type: "doc",
    attrs: { schemaVersion: 1 },
    content: [{
      type: "paragraph",
      // updateDoc 接受任意非空稳定 id；`ai-block-*` 只是生成侧临时命名约定，
      // 不是 wire/schema 禁止值。用户编辑器可能在初始块上沿用该合法 id。
      attrs: { blockId: "ai-block-user-typed" },
      content: [{ type: "text", text }],
    }],
  } as unknown as PmDoc;
}

function paragraph(blockId: string, text: string): PmDoc["content"][number] {
  return {
    type: "paragraph",
    attrs: { blockId },
    content: [{ type: "text", text }],
  };
}

function doc(...content: PmDoc["content"]): PmDoc {
  return { type: "doc", attrs: { schemaVersion: 1 }, content };
}

function reviewCommitOpId(
  state: ReturnType<typeof createSession>,
  ids: readonly string[],
): string {
  const suggestions = ids
    .map((id) => {
      const suggestion = state.suggestions.get(id)?.suggestion;
      if (!suggestion) throw new Error(`missing suggestion ${id}`);
      return [
        suggestion.baseVersion,
        suggestion.batchId ?? "legacy",
        suggestion.id,
        state.patchVerdicts.get(id) ?? suggestion.status,
      ];
    })
    .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  return getDeterministicId("review-commit-op", {
    docId: state.docId,
    suggestions,
  });
}

async function suggestionRows(docId: string): Promise<Array<{ status: string; conflict: string | null }>> {
  const result = await getDocumentsClient().execute({
    sql: "SELECT status, conflict_json FROM document_suggestions WHERE doc_id = ? ORDER BY id",
    args: [docId],
  });
  return result.rows.map((row) => ({
    status: String(row.status),
    conflict: typeof row.conflict_json === "string" ? row.conflict_json : null,
  }));
}

function productionTypeScriptFiles(root: string): string[] {
  return readdirSync(root, { recursive: true })
    .map(String)
    .filter((relative) =>
      relative.endsWith(".ts") &&
      !relative.includes("__tests__") &&
      !relative.endsWith(".test.ts")
    )
    .map((relative) => join(root, relative));
}

describe("content-edit commit wiring", () => {
  it("requires every production commitDocumentOp await site to advance content time", () => {
    const roots = [
      join(workspaceRoot, "packages/core/src"),
      join(workspaceRoot, "packages/server/src"),
    ];
    const unwired: Array<{ file: string; commits: number; advances: number }> = [];
    let totalCommits = 0;

    for (const file of roots.flatMap(productionTypeScriptFiles)) {
      const source = readFileSync(file, "utf8");
      const commits = source.match(/await\s+commitDocumentOp\s*\(/g)?.length ?? 0;
      if (commits === 0) continue;
      const advances = source.match(/advanceLastContentEditedAt\s*\(/g)?.length ?? 0;
      totalCommits += commits;
      if (advances < commits) {
        unwired.push({ file, commits, advances });
      }
    }

    expect(totalCommits).toBe(5);
    expect(unwired).toEqual([]);
  });
});

describe("用户手打块的候选审阅提交", () => {
  it("首次 suggestion 落库失败时不发送 docDiffReady", async () => {
    const state = createSession("candidate-persist-failure");
    const base = doc(paragraph("block-a", "旧正文"));
    const draft = doc(paragraph("block-a", "新正文"));
    state.doc = base;
    state.legacySections = pmToLegacySections(base) as unknown as LegacySection[];
    state.docVersion = 1;
    state.docState = { kind: "editing" };
    state.docDraftBaseDoc = base;
    state.docDraftBaseSections = state.legacySections;
    state.docDraftBaseVersion = 1;
    state.docDraftCandidateDoc = draft;
    state.docDraftCandidateSections = pmToLegacySections(draft) as unknown as LegacySection[];
    await documentRepo.save(documentInput(state.docId, {
      threadId: state.sessionId,
      docVersion: 1,
      pmDoc: base,
      legacySections: state.legacySections,
    }));
    await getDocumentsClient().execute("DROP TABLE document_suggestions");

    const frames = await collectFrames(settleDraftCandidate({
      state,
      agentMessageId: "agent-message-persist-failure",
      streamId: "agent-stream-persist-failure",
      runId: "agent-run-persist-failure",
      wholeDocument: false,
    }));

    expect(frames.some((frame) => frame.kind === "docDiffReady")).toBe(false);
    expect(frames).toContainEqual({
      kind: "stream",
      data: {
        kind: "draftingFailed",
        data: {
          streamId: "agent-stream-persist-failure",
          reason: "本次待审草稿保存失败，请重试。",
          retriable: true,
        },
      },
    });
    expect(state.suggestions.size).toBe(0);
    expect(state.docState).toEqual({ kind: "editing" });
  });

  it("docWrite 保存的手打块经 editDraft 局部替换后应 applied，而非 block_removed conflict", async () => {
    const state = createSession("typed-block-commit");
    const submittedDoc = normalizePmDoc(editorTypedDoc("用户手打原文"));
    const userWrite = await commitDocumentOp({
      docId: state.docId,
      threadId: state.threadId ?? state.sessionId,
      resourceId: state.resourceId,
      expectedDocumentSnapshot: 0,
      clientMutationId: "typed-block-write-1",
      opKind: "replace_doc",
      actorType: "user",
      createIfMissing: {
        title: state.title,
        docState: "editing",
        lastSyncedVersion: 0,
      },
      summary: "用户编辑保存",
      apply: () => ({ nextDoc: submittedDoc }),
    });
    expect(userWrite.status).toBe("committed");
    if (userWrite.status !== "committed") throw new Error(userWrite.status);

    state.doc = userWrite.doc;
    state.legacySections = pmToLegacySections(userWrite.doc) as unknown as LegacySection[];
    state.docVersion = userWrite.docVersion;
    state.docState = { kind: "editing" };

    const tools = createSessionScopedTools(state);
    const editResult = await tools.editDraft.execute?.(
      {
        ops: [{
          action: "replaceText",
          find: "用户手打原文",
          replace: "Agent 修订正文",
        }],
      },
      {} as never,
    );
    expect(editResult).toMatchObject({ ok: true, changed: true });

    await collectFrames(settleDraftCandidate({
      state,
      agentMessageId: "agent-message-1",
      streamId: "agent-stream-1",
      runId: "agent-run-1",
      wholeDocument: false,
    }));
    expect(state.suggestions.size).toBeGreaterThan(0);

    const suggestionIds = [...state.suggestions.keys()];
    const commitFrames = await collectFrames(commitPatches(state, suggestionIds));
    const stored = await documentRepo.load(state.docId);
    const versions = await listVersions(state.docId);

    expect(pmToPlainText(stored!.pmDoc!)).toBe("Agent 修订正文");
    expect(versions[0]?.summary).toBe("提交 1 处局部修改");
    expect(await suggestionRows(state.docId)).toEqual([{ status: "committed", conflict: null }]);
    expect(commitFrames.some((frame) =>
      frame.kind === "toolCallUpdated" &&
      frame.data.toolCallId === suggestionIds[0] &&
      frame.data.spec.status.kind === "failed"
    )).toBe(false);
  });

  it("审阅批注映射失败时正文、版本与 suggestion 结算一起回滚", async () => {
    const state = createSession("review-annotation-atomic");
    const base = doc(paragraph("review-annotation-block", "旧正文"));
    const initial = await commitDocumentOp({
      docId: state.docId,
      threadId: state.threadId ?? state.sessionId,
      resourceId: state.resourceId,
      expectedDocumentSnapshot: 0,
      opId: "seed-review-annotation-atomic",
      opKind: "replace_doc",
      actorType: "agent",
      createIfMissing: {
        title: state.title,
        docState: "editing",
        lastSyncedVersion: 0,
      },
      apply: () => ({ nextDoc: base }),
    });
    expect(initial.status).toBe("committed");
    if (initial.status !== "committed") throw new Error(initial.status);
    state.doc = initial.doc;
    state.legacySections = pmToLegacySections(initial.doc) as unknown as LegacySection[];
    state.docVersion = initial.docVersion;
    state.docState = { kind: "editing" };

    const tools = createSessionScopedTools(state);
    expect(await tools.editDraft.execute?.({
      ops: [{ action: "replaceText", find: "旧正文", replace: "新正文" }],
    }, {} as never)).toMatchObject({ ok: true, changed: true });
    await collectFrames(settleDraftCandidate({
      state,
      agentMessageId: "agent-message-review-annotation",
      streamId: "agent-stream-review-annotation",
      runId: "agent-run-review-annotation",
      wholeDocument: false,
    }));
    const suggestionIds = [...state.suggestions.keys()];
    expect(suggestionIds).toHaveLength(1);
    state.patchVerdicts.set(suggestionIds[0]!, "accepted");
    state.annotationGroups = [{
      id: "annotation-review-atomic",
      summary: "核对正文",
      note: "正文批注",
      origin: "consistency",
      status: "reviewing",
      anchors: [{
        blockId: "review-annotation-block",
        pmFrom: 1,
        pmTo: 4,
        quote: "旧正文",
        textHash: "hash-review-annotation",
      }],
    }];
    const versionsBefore = await listVersions(state.docId);
    await getDocumentsClient().execute("DROP TABLE document_suggestions");

    const frames: BridgeFrame[] = [];
    try {
      frames.push(...await collectFrames(commitPatches(state, suggestionIds)));
    } catch {
      // 修复前映射异常会从已提交正文之后冒泡；断言以持久化原子性为准。
    }

    expect(pmToPlainText((await documentRepo.load(state.docId))!.pmDoc!)).toBe("旧正文");
    expect(await listVersions(state.docId)).toHaveLength(versionsBefore.length);
    expect(frames.some((frame) =>
      frame.kind === "documentSnapshotWritten" || frame.kind === "docCommitted"
    )).toBe(false);
    expect(state.suggestions.size).toBe(1);
  });

  it("整篇候选的批注映射失败时不提交正文或版本", async () => {
    const state = createSession("whole-annotation-atomic");
    const base = doc();
    const draft = doc(paragraph("whole-annotation-block", "生成正文"));
    await documentRepo.save(documentInput(state.docId, {
      threadId: state.threadId ?? state.sessionId,
      docVersion: 1,
      pmDoc: base,
      legacySections: [],
    }));
    state.doc = base;
    state.legacySections = [];
    state.docVersion = 1;
    state.docState = { kind: "editing" };
    state.docDraftBaseDoc = base;
    state.docDraftBaseVersion = 1;
    state.docDraftBaseSections = [];
    state.docDraftCandidateDoc = draft;
    state.docDraftCandidateSections = pmToLegacySections(draft) as unknown as LegacySection[];
    state.annotationGroups = [{
      id: "annotation-whole-atomic",
      summary: "核对生成正文",
      note: "生成批注",
      origin: "source-check",
      status: "reviewing",
      anchors: [{
        blockId: "whole-annotation-block",
        pmFrom: 1,
        pmTo: 5,
        quote: "生成正文",
        textHash: "hash-whole-annotation",
      }],
    }];
    await getDocumentsClient().execute("DROP TABLE document_suggestions");

    const frames: BridgeFrame[] = [];
    try {
      frames.push(...await collectFrames(settleDraftCandidate({
        state,
        agentMessageId: "agent-message-whole-annotation",
        streamId: "agent-stream-whole-annotation",
        runId: "agent-run-whole-annotation",
        wholeDocument: true,
      })));
    } catch {
      // 修复前映射异常会在正文提交后冒泡。
    }

    expect(pmToPlainText((await documentRepo.load(state.docId))!.pmDoc!)).toBe("");
    expect(await listVersions(state.docId)).toEqual([]);
    expect(frames.some((frame) =>
      frame.kind === "documentSnapshotWritten" ||
      frame.kind === "docGenerationEvent"
    )).toBe(false);
    expect(state.docVersion).toBe(1);
  });

  it("整批目标的基线哈希漂移时不部分落库并保留候选", async () => {
    const state = createSession("typed-block-partial-conflict");
    const base = doc(
      paragraph("typed-survivor", "甲原文"),
      paragraph("typed-removed", "乙原文"),
    );
    state.doc = base;
    state.legacySections = pmToLegacySections(base) as unknown as LegacySection[];
    state.docVersion = 1;
    state.docState = { kind: "editing" };

    // 模拟审阅期间 canonical 的第二个目标已被并发删除：版本号未变但基线哈希已漂移。
    const canonical = doc(paragraph("typed-survivor", "甲原文"));
    await documentRepo.save(documentInput(state.docId, {
      threadId: state.threadId ?? state.sessionId,
      docVersion: 1,
      pmDoc: canonical,
      legacySections: pmToLegacySections(canonical) as unknown as LegacySection[],
    }));

    const tools = createSessionScopedTools(state);
    const editResult = await tools.editDraft.execute?.({
      ops: [
        { action: "replaceText", find: "甲原文", replace: "甲修订" },
        { action: "replaceText", find: "乙原文", replace: "乙修订" },
      ],
    }, {} as never);
    expect(editResult).toMatchObject({ ok: true, changed: true, hunkCount: 2 });

    await collectFrames(settleDraftCandidate({
      state,
      agentMessageId: "agent-message-partial",
      streamId: "agent-stream-partial",
      runId: "agent-run-partial",
      wholeDocument: false,
    }));
    const ids = [...state.suggestions.keys()];
    expect(ids).toHaveLength(2);

    const frames = await collectFrames(commitPatches(state, ids));
    expect(pmToPlainText((await documentRepo.load(state.docId))!.pmDoc!)).toBe("甲原文");
    expect(await listVersions(state.docId)).toEqual([]);
    expect(frames.some((frame) => frame.kind === "docCommitted")).toBe(false);
    expect(state.suggestions.size).toBe(2);
    expect((await suggestionRows(state.docId)).map((row) => row.status)).toEqual([
      "reviewing",
      "reviewing",
    ]);
  });

  it("部分成功在 DB 提交后重放同一 opId 时仍恢复 applied/conflict 结算", async () => {
    const state = createSession("typed-block-partial-replay");
    const base = doc(
      paragraph("typed-replay-survivor", "甲原文"),
      paragraph("typed-replay-removed", "乙原文"),
    );
    state.doc = base;
    state.legacySections = pmToLegacySections(base) as unknown as LegacySection[];
    state.docVersion = 1;
    state.docState = { kind: "editing" };

    const canonical = doc(paragraph("typed-replay-survivor", "甲原文"));
    await documentRepo.save(documentInput(state.docId, {
      threadId: state.threadId ?? state.sessionId,
      docVersion: 1,
      pmDoc: canonical,
      legacySections: pmToLegacySections(canonical) as unknown as LegacySection[],
    }));

    const tools = createSessionScopedTools(state);
    expect(await tools.editDraft.execute?.({
      ops: [
        { action: "replaceText", find: "甲原文", replace: "甲修订" },
        { action: "replaceText", find: "乙原文", replace: "乙修订" },
      ],
    }, {} as never)).toMatchObject({ ok: true, changed: true, hunkCount: 2 });
    await collectFrames(settleDraftCandidate({
      state,
      agentMessageId: "agent-message-partial-replay",
      streamId: "agent-stream-partial-replay",
      runId: "agent-run-partial-replay",
      wholeDocument: false,
    }));

    const ids = [...state.suggestions.keys()];
    const hunks = ids
      .map((id) => state.suggestions.get(id)?.diffHunk)
      .filter((hunk): hunk is DiffHunk => hunk !== undefined);
    expect(hunks).toHaveLength(2);
    const opId = reviewCommitOpId(state, ids);
    const firstCommit = await commitDocumentOp({
      docId: state.docId,
      threadId: state.threadId ?? state.sessionId,
      resourceId: state.resourceId,
      expectedDocumentSnapshot: state.docVersion,
      opId,
      opKind: "patch_steps",
      actorType: "agent",
      summary: "模拟审阅结算前崩溃",
      apply: (currentDoc) => {
        const applied = applyDiffHunks(currentDoc, hunks, {
          oldBaseDoc: base,
          anchorByBlockId: true,
        });
        return {
          nextDoc: applied.doc,
          steps: applied.applied.map((hunk) =>
            ({
              ...diffHunkToStep(hunk, hunk.anchor.pmFrom ?? 0, hunk.anchor.pmTo ?? hunk.anchor.pmFrom ?? 0),
              suggestionId: hunk.hunkId,
            })
          ),
        };
      },
    });
    expect(firstCommit).toMatchObject({ status: "committed", createdNewVersion: true });

    // 内存 suggestion 仍为 reviewing，模拟事务提交后、结算前进程退出；再次提交命中同一 opId。
    const replayFrames = await collectFrames(commitPatches(state, ids));
    expect(replayFrames.find((frame) => frame.kind === "docCommitted")).toEqual({
      kind: "docCommitted",
      data: {
        sessionId: state.sessionId,
        version: 2,
        appliedCount: 1,
        conflictCount: 1,
      },
    });
    expect((await suggestionRows(state.docId)).map((row) => row.status).sort()).toEqual([
      "committed",
      "conflict",
    ]);
    expect(await listVersions(state.docId)).toHaveLength(1);
  });

  it("升级前部分成功 op 缺少 suggestionId 时不猜测逐项成功并省略不可知计数", async () => {
    const state = createSession("typed-block-legacy-replay");
    const base = doc(
      paragraph("typed-legacy-survivor", "旧版甲原文"),
      paragraph("typed-legacy-removed", "旧版乙原文"),
    );
    state.doc = base;
    state.legacySections = pmToLegacySections(base) as unknown as LegacySection[];
    state.docVersion = 1;
    state.docState = { kind: "editing" };
    const canonical = doc(paragraph("typed-legacy-survivor", "旧版甲原文"));
    await documentRepo.save(documentInput(state.docId, {
      threadId: state.threadId ?? state.sessionId,
      docVersion: 1,
      pmDoc: canonical,
      legacySections: pmToLegacySections(canonical) as unknown as LegacySection[],
    }));

    const tools = createSessionScopedTools(state);
    expect(await tools.editDraft.execute?.({
      ops: [
        { action: "replaceText", find: "旧版甲原文", replace: "旧版甲修订" },
        { action: "replaceText", find: "旧版乙原文", replace: "旧版乙修订" },
      ],
    }, {} as never)).toMatchObject({ ok: true, changed: true, hunkCount: 2 });
    await collectFrames(settleDraftCandidate({
      state,
      agentMessageId: "agent-message-legacy-replay",
      streamId: "agent-stream-legacy-replay",
      runId: "agent-run-legacy-replay",
      wholeDocument: false,
    }));

    const ids = [...state.suggestions.keys()];
    const hunks = ids
      .map((id) => state.suggestions.get(id)?.diffHunk)
      .filter((hunk): hunk is DiffHunk => hunk !== undefined);
    expect(hunks).toHaveLength(2);
    const firstCommit = await commitDocumentOp({
      docId: state.docId,
      threadId: state.threadId ?? state.sessionId,
      resourceId: state.resourceId,
      expectedDocumentSnapshot: state.docVersion,
      opId: reviewCommitOpId(state, ids),
      opKind: "patch_steps",
      actorType: "agent",
      summary: "模拟升级前审阅提交",
      apply: (currentDoc) => {
        const applied = applyDiffHunks(currentDoc, hunks, {
          oldBaseDoc: base,
          anchorByBlockId: true,
        });
        return {
          nextDoc: applied.doc,
          // 模拟升级前 document_ops：标准 PM step 中没有 suggestionId 恢复元数据。
          steps: applied.applied.map((hunk) =>
            diffHunkToStep(hunk, hunk.anchor.pmFrom ?? 0, hunk.anchor.pmTo ?? hunk.anchor.pmFrom ?? 0)
          ),
        };
      },
    });
    expect(firstCommit).toMatchObject({ status: "committed", createdNewVersion: true });

    const replayFrames = await collectFrames(commitPatches(state, ids));
    expect(replayFrames.find((frame) => frame.kind === "docCommitted")).toEqual({
      kind: "docCommitted",
      data: { sessionId: state.sessionId, version: 2 },
    });
    expect((await suggestionRows(state.docId)).map((row) => row.status)).toEqual([
      "conflict",
      "conflict",
    ]);
  });

  it("全部目标失效时不落内容相同的新版本，也不发送 docCommitted 成功帧", async () => {
    const state = createSession("typed-block-all-conflict");
    const base = doc(
      paragraph("typed-target", "待修改原文"),
      paragraph("typed-survivor", "无关正文"),
    );
    state.doc = base;
    state.legacySections = pmToLegacySections(base) as unknown as LegacySection[];
    state.docVersion = 1;
    state.docState = { kind: "editing" };

    const canonical = doc(paragraph("typed-survivor", "无关正文"));
    await documentRepo.save(documentInput(state.docId, {
      threadId: state.threadId ?? state.sessionId,
      docVersion: 1,
      pmDoc: canonical,
      legacySections: pmToLegacySections(canonical) as unknown as LegacySection[],
    }));

    const tools = createSessionScopedTools(state);
    expect(await tools.editDraft.execute?.({
      ops: [{ action: "replaceText", find: "待修改原文", replace: "不应写入" }],
    }, {} as never)).toMatchObject({ ok: true, changed: true });
    await collectFrames(settleDraftCandidate({
      state,
      agentMessageId: "agent-message-all-conflict",
      streamId: "agent-stream-all-conflict",
      runId: "agent-run-all-conflict",
      wholeDocument: false,
    }));

    const frames = await collectFrames(commitPatches(state, [...state.suggestions.keys()]));
    expect(await listVersions(state.docId)).toEqual([]);
    expect(pmToPlainText((await documentRepo.load(state.docId))!.pmDoc!)).toBe("无关正文");
    expect(frames.some((frame) => frame.kind === "docCommitted")).toBe(false);
    expect(state.suggestions.size).toBe(1);
    expect(await suggestionRows(state.docId)).toEqual([
      expect.objectContaining({ status: "reviewing" }),
    ]);
  });

  it("agent writeDraft 已物化的 canonical blockId 继续保持正常可提交", async () => {
    const state = createSession("agent-write-draft-control");
    const generated = materializeDraftBlockIds(doc(
      paragraph("ai-block-agent-generated", "Agent 首稿原文"),
    ), { namespace: "writeDraft.control" });
    expect(generated.content[0]?.attrs.blockId).not.toMatch(/^ai-block-/);

    const initial = await commitDocumentOp({
      docId: state.docId,
      threadId: state.threadId ?? state.sessionId,
      resourceId: state.resourceId,
      expectedDocumentSnapshot: 0,
      opId: "generation:agent-write-draft-control:stream-1",
      opKind: "replace_doc",
      actorType: "agent",
      createIfMissing: {
        title: state.title,
        docState: "editing",
        lastSyncedVersion: 0,
      },
      summary: "AI 生成文档",
      apply: () => ({ nextDoc: generated }),
    });
    expect(initial.status).toBe("committed");
    if (initial.status !== "committed") throw new Error(initial.status);
    state.doc = initial.doc;
    state.legacySections = pmToLegacySections(initial.doc) as unknown as LegacySection[];
    state.docVersion = initial.docVersion;
    state.docState = { kind: "editing" };

    const tools = createSessionScopedTools(state);
    expect(await tools.editDraft.execute?.({
      ops: [{ action: "replaceText", find: "Agent 首稿原文", replace: "Agent 首稿修订" }],
    }, {} as never)).toMatchObject({ ok: true, changed: true });
    await collectFrames(settleDraftCandidate({
      state,
      agentMessageId: "agent-message-write-control",
      streamId: "agent-stream-write-control",
      runId: "agent-run-write-control",
      wholeDocument: false,
    }));
    await collectFrames(commitPatches(state, [...state.suggestions.keys()]));

    expect(pmToPlainText((await documentRepo.load(state.docId))!.pmDoc!)).toBe("Agent 首稿修订");
    expect((await suggestionRows(state.docId)).map((row) => row.status)).toEqual(["committed"]);
  });
});
