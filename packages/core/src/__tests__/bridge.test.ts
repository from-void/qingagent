import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import {
  createSession,
  deriveActiveOverlay,
  deriveAgentBusy,
  deriveContentState,
  deriveEditorState,
  deriveDocStateFacts,
  updatePatchVerdict,
  commitPatches,
} from "../bridge/index.js";
import type { SessionState } from "../bridge/index.js";
import type { BridgeFrame } from "@qingagent/contract-ts";
import {
  getPmContentHash,
  legacySectionsToPm,
  pmToLegacySections,
} from "@qingagent/pm-schema";
import { createSuggestionFromDiffHunk } from "../doc-engine/draftReviewSuggestions.js";
import {
  collectTopLevelTextBlocks,
  findLiteralMatches,
} from "../doc-engine/textEditOps.js";
import {
  documentDraftRepo,
  documentRepo,
  getDocumentsClient,
  upsertDocumentSuggestion,
} from "@qingagent/db";
import {
  documentInput,
  prepareTempDocumentsDb,
  type TempDocumentsDb,
} from "@qingagent/db/testing";
import { mastra } from "../mastra.js";

let tempDb: TempDocumentsDb;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function collectFrames(gen: AsyncIterable<BridgeFrame>): Promise<BridgeFrame[]> {
  const frames: BridgeFrame[] = [];
  for await (const f of gen) {
    frames.push(f);
  }
  return frames;
}

async function collectAsyncFrames(gen: AsyncIterable<BridgeFrame>): Promise<BridgeFrame[]> {
  const frames: BridgeFrame[] = [];
  for await (const f of gen) {
    frames.push(f);
  }
  return frames;
}

function seedStateWithDoc(state: SessionState): void {
  state.doc = legacySectionsToPm([
    { kind: "h1", data: { text: "春天的校园" } },
    { kind: "p", data: { text: "三月的阳光透过教学楼的玻璃窗，洒在走廊的地砖上。" } },
    { kind: "h2", data: { text: "花开时节", anchor: null } },
    {
      kind: "p",
      data: { text: "校园里的樱花树在不知不觉间绽放了，粉白色的花瓣随风飘落。" },
    },
  ] as never);
  state.docVersion = 1;
  state.docState = { kind: "pendingReview" };
}

type PatchOverrides = Partial<{
  before: string;
  after: string;
  blockIndex: number;
  summary: string;
}>;

async function addPatch(
  state: SessionState,
  id: string,
  overrides?: PatchOverrides,
): Promise<void> {
  const patch = {
    messageId: "msg-1",
    toolCallId: id,
    before: "三月的阳光",
    after: "四月的暖阳",
    blockIndex: 1,
    summary: "将三月改为四月",
    ...overrides,
  };
  if (!state.doc) throw new Error("测试夹具缺少 PM 文档");
  const [match] = findLiteralMatches(
    collectTopLevelTextBlocks(state.doc),
    patch.before,
    false,
  );
  if (!match) throw new Error(`测试夹具未找到唯一文本: ${patch.before}`);
  const builtSuggestion = createSuggestionFromDiffHunk({
    hunk: {
      hunkId: id,
      reviewBatchId: "review:test",
      groupMode: "independent",
      op: "replace",
      blockPath: match.block.path,
      anchor: {
        blockId: match.blockId,
        pmFrom: match.pmFrom,
        pmTo: match.pmTo,
      },
      before: null,
      after: patch.after ? [{ type: "text", text: patch.after }] : [],
      summary: patch.summary,
      beforeText: patch.before,
      afterText: patch.after,
    },
    docId: state.docId,
    baseVersion: state.docVersion,
    baseSchemaVersion: state.doc.attrs.schemaVersion,
  });
  // 这些 bridge 用例特意模拟无 diffHunk 的旧建议记录。
  const {
    diffHunk: _diffHunk,
    reviewBatchId: _reviewBatchId,
    groupMode: _groupMode,
    ...suggestion
  } = builtSuggestion;
  state.suggestions.set(id, {
    messageId: patch.messageId,
    toolCallId: patch.toolCallId,
    before: patch.before,
    after: patch.after,
    blockIndex: match.block.topIndex,
    suggestion,
  });
  await upsertDocumentSuggestion(suggestion);
  state.suggestionBaseDoc ??= state.doc;
  state.suggestionBaseVersion ??= state.docVersion;
}

async function seedDocumentRow(state: SessionState): Promise<void> {
  await documentRepo.save(
    documentInput(state.docId, {
      threadId: state.threadId ?? state.sessionId,
      resourceId: state.resourceId,
      docVersion: state.docVersion,
      legacySections: pmToLegacySections(state.doc!) as never,
      pmDoc: state.doc,
    }),
  );
}

beforeEach(() => {
  tempDb = prepareTempDocumentsDb("qingagent-bridge-");
});

afterEach(() => {
  vi.restoreAllMocks();
  tempDb.cleanup();
});

// ---------------------------------------------------------------------------
// Tests: createSession
// ---------------------------------------------------------------------------

describe("createSession", () => {
  it("creates a session with initial state", () => {
    const state = createSession("test-session");

    expect(state.sessionId).toBe("test-session");
    expect(state.title).toBe("");
    expect(state.docState).toEqual({ kind: "empty" });
    expect(state.messages).toEqual([]);
    expect(state.doc).toBeUndefined();
    expect(state.docVersion).toBe(0);
    expect(state.streamId).toBeNull();
    expect(state.runId).toBeNull();
    expect(state.toolCallId).toBeNull();
    expect(state._abortController).toBeNull();
    expect(state._activeTurnPromise).toBeNull();
    expect(state.suggestions.size).toBe(0);
    expect(state.seqCounters.size).toBe(0);
    expect(state.lastSyncedDocumentSnapshot).toBe(0);
  });

  it("creates unique sessions with different IDs", () => {
    const s1 = createSession("session-1");
    const s2 = createSession("session-2");

    expect(s1.sessionId).not.toBe(s2.sessionId);
    // Ensure they are independent objects
    s1.title = "Test";
    expect(s2.title).toBe("");
  });
});

// ---------------------------------------------------------------------------
// Tests: updatePatchVerdict
// ---------------------------------------------------------------------------

describe("updatePatchVerdict", () => {
  it("emits toolCallUpdated with 'accepted' status", async () => {
    const state = createSession("test");
    seedStateWithDoc(state);
    await addPatch(state, "patch-1");

    const frames = await collectFrames(updatePatchVerdict(state, "patch-1", "accepted"));

    expect(frames).toHaveLength(1);
    const frame = frames[0]!;
    expect(frame.kind).toBe("toolCallUpdated");

    if (frame.kind === "toolCallUpdated") {
      expect(frame.data.toolCallId).toBe("patch-1");
      expect(frame.data.messageId).toBe("msg-1");
      expect(frame.data.spec.status).toEqual({ kind: "accepted" });
      expect(frame.data.spec.name).toBe("docSuggestion");
      expect(frame.data.spec.body.kind).toBe("docSuggestion");
    }
  });

  it("emits toolCallUpdated with 'rejected' status", async () => {
    const state = createSession("test");
    seedStateWithDoc(state);
    await addPatch(state, "patch-2");

    const frames = await collectFrames(updatePatchVerdict(state, "patch-2", "rejected"));

    expect(frames).toHaveLength(1);
    const frame = frames[0]!;

    if (frame.kind === "toolCallUpdated") {
      expect(frame.data.spec.status).toEqual({ kind: "rejected" });
    }
  });

  it("persists verdict in state.patchVerdicts", async () => {
    const state = createSession("test");
    seedStateWithDoc(state);
    await addPatch(state, "patch-v1");
    await addPatch(state, "patch-v2");

    await collectFrames(updatePatchVerdict(state, "patch-v1", "accepted"));
    await collectFrames(updatePatchVerdict(state, "patch-v2", "rejected"));

    expect(state.patchVerdicts.get("patch-v1")).toBe("accepted");
    expect(state.patchVerdicts.get("patch-v2")).toBe("rejected");
  });

  it("unknown patch ID is a logged successful no-op", async () => {
    const state = createSession("test");
    const warn = vi.spyOn(mastra.getLogger(), "warn").mockImplementation(() => undefined);

    const frames = await collectFrames(updatePatchVerdict(state, "nonexistent", "accepted"));

    expect(frames).toEqual([
      {
        kind: "docStateChanged",
        data: {
          state: { kind: "empty" },
          activeOverlay: null,
          agentBusy: false,
          reviewCompletion: "noop",
        },
      },
    ]);
    expect(warn).toHaveBeenCalledWith(
      "Skipped unknown or resolved review target",
      expect.objectContaining({
        sessionId: "test",
        command: "accept",
        patchId: "nonexistent",
        stateSuggestionRecordCount: 0,
        skipped: "patchVerdictTarget",
        remainingValidIdCount: 0,
      }),
    );
  });

  it("preserves patch body content in emitted spec", async () => {
    const state = createSession("test");
    seedStateWithDoc(state);
    await addPatch(state, "patch-3", {
      before: "樱花树",
      after: "梅花树",
      blockIndex: 3,
      summary: "将樱花改为梅花",
    });

    const frames = await collectFrames(updatePatchVerdict(state, "patch-3", "accepted"));
    const frame = frames[0]!;

    if (frame.kind === "toolCallUpdated") {
      const body = frame.data.spec.body;
      if (body.kind === "docSuggestion" && body.data.kind === "suggestion") {
        expect(body.data.data.preview.deleteText).toBe("樱花树");
        expect(body.data.data.preview.insertText).toBe("梅花树");
        expect(body.data.data.summary).toBe("将樱花改为梅花");
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Tests: commitPatches
// ---------------------------------------------------------------------------

describe("commitPatches", () => {
  it("applies a single patch and emits documentSnapshotWritten + modern docStateChanged", async () => {
    const state = createSession("test");
    seedStateWithDoc(state);
    await addPatch(state, "patch-1");
    state.patchVerdicts.set("patch-1", "accepted");
    await seedDocumentRow(state);

    const frames = await collectAsyncFrames(commitPatches(state, ["patch-1"]));

    // Expected: toolCallUpdated(committed) + documentSnapshotWritten + docCommitted
    // + modern docStateChanged(editing)
    expect(frames.length).toBeGreaterThanOrEqual(4);

    // Check toolCallUpdated with committed status
    const committedFrame = frames.find(
      (f) =>
        f.kind === "toolCallUpdated" &&
        f.data.spec.status.kind === "committed",
    );
    expect(committedFrame).toBeDefined();

    // Check documentSnapshotWritten
    const docFrame = frames.find((f) => f.kind === "documentSnapshotWritten");
    expect(docFrame).toBeDefined();
    if (docFrame?.kind === "documentSnapshotWritten") {
      expect(docFrame.data.doc.version).toBe(2); // bumped from 1
      const snapshotSections = pmToLegacySections(docFrame.data.doc.doc);
      expect(snapshotSections).toHaveLength(4);
      // The patch should have been applied: "三月的阳光" → "四月的暖阳"
      const pSection = snapshotSections[1];
      if (pSection?.kind === "p") {
        expect(pSection.data.text).toContain("四月的暖阳");
        expect(pSection.data.text).not.toContain("三月的阳光");
      }
    }

    expect(frames.find((f) => f.kind === "docCommitted")).toBeDefined();

    // Check docStateChanged transitions
    const stateFrames = frames.filter((f) => f.kind === "docStateChanged");
    expect(stateFrames.length).toBe(1);
    if (stateFrames[0]?.kind === "docStateChanged") {
      expect(stateFrames[0].data.state).toEqual({ kind: "editing" });
    }
    expect(deriveDocStateFacts(state).hasApplicableReviewPatch).toBe(false);
    expect(state.suggestions.has("patch-1")).toBe(false);
    expect(state.patchVerdicts.has("patch-1")).toBe(false);
  });

  it("提交完全部审阅后释放残留 stream 锁,允许后续图编辑保存", async () => {
    const state = createSession("test-stale-stream");
    seedStateWithDoc(state);
    await addPatch(state, "patch-1");
    state.patchVerdicts.set("patch-1", "accepted");
    state.streamId = "stale-review-stream";
    await seedDocumentRow(state);

    const frames = await collectAsyncFrames(commitPatches(state, ["patch-1"]));

    expect(frames.find((f) => f.kind === "docCommitted")).toBeDefined();
    expect(state.streamId).toBeNull();
    const stateFrame = frames.find((f) => f.kind === "docStateChanged");
    expect(stateFrame?.kind).toBe("docStateChanged");
    if (stateFrame?.kind === "docStateChanged") {
      expect(stateFrame.data.agentBusy).toBe(false);
      expect(stateFrame.data.state).toEqual({ kind: "editing" });
    }
    expect(deriveEditorState(
      deriveContentState(state),
      deriveAgentBusy(state),
      deriveActiveOverlay(state),
    )).toBe("editable");
  });

  it("提交改写导致批注组全丢时不输出批注定位固定文案", async () => {
    const state = createSession("test-annotation-remap");
    seedStateWithDoc(state);
    await addPatch(state, "patch-1");
    state.patchVerdicts.set("patch-1", "accepted");
    const [match] = findLiteralMatches(
      collectTopLevelTextBlocks(state.doc!),
      "三月的阳光",
      false,
    );
    expect(match).toBeDefined();
    state.annotationGroups = [{
      id: "annotation-stale",
      summary: "月份表述过时",
      note: "请核对月份",
      origin: "consistency",
      status: "reviewing",
      anchors: [{
        blockId: match!.blockId,
        pmFrom: match!.pmFrom,
        pmTo: match!.pmTo,
        quote: match!.matchText,
        textHash: "hash-stale",
      }],
    }];
    await seedDocumentRow(state);

    const frames = await collectAsyncFrames(commitPatches(state, ["patch-1"]));

    expect(frames).toContainEqual({
      kind: "annotationGroupsReady",
      data: {
        groups: [],
        replacedOrigins: ["consistency"],
        invalidatedAnchorCount: 1,
      },
    });
    expect(JSON.stringify(frames)).not.toContain("批注落地结果");
    expect(state.annotationGroups).toEqual([]);
    expect(JSON.stringify({ chatHistory: state.chatHistory, messages: state.messages }))
      .not.toContain("批注落地结果");
  });

  it("提交后清理已提交项，并将缺少 diffHunk 的剩余项结算为失败", async () => {
    const state = createSession("test");
    seedStateWithDoc(state);
    await addPatch(state, "patch-a");
    await addPatch(state, "patch-b", {
      before: "樱花树",
      after: "桃花树",
      blockIndex: 3,
      summary: "将樱花改为桃花",
    });
    await seedDocumentRow(state);

    // Commit only patch-a
    const frames = await collectAsyncFrames(commitPatches(state, ["patch-a"]));

    // patch-a 已提交；patch-b 无法 rebase，必须显式失败，不能静默留在待审状态。
    expect(state.suggestions.has("patch-a")).toBe(false);
    expect(state.suggestions.has("patch-b")).toBe(false);
    expect(frames.some((frame) =>
      frame.kind === "toolCallUpdated" &&
      frame.data.toolCallId === "patch-b" &&
      frame.data.spec.status.kind === "failed"
    )).toBe(true);
  });

  it("applies multiple patches in correct order", async () => {
    const state = createSession("test");
    seedStateWithDoc(state);

    // Add two patches on different sections
    await addPatch(state, "p1", {
      before: "春天的校园",
      after: "秋天的校园",
      blockIndex: 0,
      summary: "春天改秋天",
    });
    await addPatch(state, "p2", {
      before: "花开时节",
      after: "落叶时分",
      blockIndex: 2,
      summary: "花开改落叶",
    });
    await seedDocumentRow(state);

    const frames = await collectAsyncFrames(commitPatches(state, ["p1", "p2"]));

    const docFrame = frames.find((f) => f.kind === "documentSnapshotWritten");
    if (docFrame?.kind === "documentSnapshotWritten") {
      const sections = pmToLegacySections(docFrame.data.doc.doc);
      // Section 0: h1 should now be "秋天的校园"
      if (sections[0]?.kind === "h1") {
        expect(sections[0].data.text).toBe("秋天的校园");
      }
      // Section 2: h2 should now be "落叶时分"
      if (sections[2]?.kind === "h2") {
        expect(sections[2].data.text).toBe("落叶时分");
      }
    }
  });

  it("bumps docVersion after commit", async () => {
    const state = createSession("test");
    seedStateWithDoc(state);
    await addPatch(state, "patch-1");
    await seedDocumentRow(state);

    expect(state.docVersion).toBe(1);
    await collectAsyncFrames(commitPatches(state, ["patch-1"]));
    expect(state.docVersion).toBe(2);
  });

  it("transitions state to committed then draft", async () => {
    const state = createSession("test");
    seedStateWithDoc(state);
    await addPatch(state, "patch-1");
    await seedDocumentRow(state);

    await collectAsyncFrames(commitPatches(state, ["patch-1"]));

    expect(state.docState).toEqual({ kind: "editing" });
  });

  it("skips rejected patches when committing", async () => {
    const state = createSession("test");
    seedStateWithDoc(state);

    // Add two patches on different sections
    await addPatch(state, "p-acc", {
      before: "春天的校园",
      after: "秋天的校园",
      blockIndex: 0,
      summary: "春天改秋天",
    });
    await addPatch(state, "p-rej", {
      before: "花开时节",
      after: "落叶时分",
      blockIndex: 2,
      summary: "花开改落叶",
    });

    // Accept one, reject the other
    await collectFrames(updatePatchVerdict(state, "p-acc", "accepted"));
    await collectFrames(updatePatchVerdict(state, "p-rej", "rejected"));
    await seedDocumentRow(state);

    const frames = await collectAsyncFrames(commitPatches(state, ["p-acc", "p-rej"]));

    const docFrame = frames.find((f) => f.kind === "documentSnapshotWritten");
    expect(docFrame).toBeDefined();
    if (docFrame?.kind === "documentSnapshotWritten") {
      const sections = pmToLegacySections(docFrame.data.doc.doc);
      // Accepted patch: section 0 should be changed
      if (sections[0]?.kind === "h1") {
        expect(sections[0].data.text).toBe("秋天的校园");
      }
      // Rejected patch: section 2 should remain unchanged
      if (sections[2]?.kind === "h2") {
        expect(sections[2].data.text).toBe("花开时节");
      }
    }
  });

  it("全拒绝清理 draft 失败时保留审阅态，清理恢复后可原地重试", async () => {
    const state = createSession("rejected-draft-clear-retry");
    seedStateWithDoc(state);
    await addPatch(state, "patch-rejected");
    const candidateDoc = legacySectionsToPm([
      { kind: "h1", data: { text: "春天的校园" } },
      { kind: "p", data: { text: "四月的暖阳透过教学楼的玻璃窗，洒在走廊的地砖上。" } },
      { kind: "h2", data: { text: "花开时节", anchor: null } },
      {
        kind: "p",
        data: { text: "校园里的樱花树在不知不觉间绽放了，粉白色的花瓣随风飘落。" },
      },
    ] as never);
    state.docDraftBaseDoc = state.doc!;
    state.docDraftBaseVersion = state.docVersion;
    state.docDraftCandidateDoc = candidateDoc;
    await documentDraftRepo.savePending({
      docId: state.docId,
      threadId: state.threadId ?? state.sessionId,
      baseVersion: state.docVersion,
      baseHash: getPmContentHash(state.doc!),
      draftPmDoc: candidateDoc,
    });
    await collectFrames(updatePatchVerdict(state, "patch-rejected", "rejected"));
    await getDocumentsClient().execute(`CREATE TRIGGER fail_rejected_draft_delete
      BEFORE DELETE ON document_drafts
      WHEN OLD.doc_id = '${state.docId}'
      BEGIN
        SELECT RAISE(ABORT, 'injected rejected draft delete failure');
      END`);

    const failedFrames = await collectAsyncFrames(
      commitPatches(state, ["patch-rejected"]),
    );

    expect(state.docState).toEqual({ kind: "pendingReview" });
    expect(state.suggestions.has("patch-rejected")).toBe(true);
    expect(state.patchVerdicts.get("patch-rejected")).toBe("rejected");
    expect(state.docDraftCandidateDoc).toEqual(candidateDoc);
    await expect(documentDraftRepo.load(state.docId)).resolves.toMatchObject({
      status: "pending_review",
    });
    expect(failedFrames.some((frame) =>
      frame.kind === "documentSnapshotWritten"
    )).toBe(false);
    expect(failedFrames.some((frame) =>
      frame.kind === "docStateChanged" && frame.data.state.kind === "editing"
    )).toBe(false);
    expect(failedFrames.some((frame) =>
      frame.kind === "toolCallUpdated" &&
      frame.data.toolCallId === "patch-rejected" &&
      frame.data.spec.status.kind === "failed"
    )).toBe(true);

    await getDocumentsClient().execute("DROP TRIGGER fail_rejected_draft_delete");
    const retriedFrames = await collectAsyncFrames(
      commitPatches(state, ["patch-rejected"]),
    );

    expect(state.docState).toEqual({ kind: "editing" });
    expect(state.suggestions.size).toBe(0);
    expect(state.patchVerdicts.size).toBe(0);
    await expect(documentDraftRepo.load(state.docId)).resolves.toBeNull();
    expect(retriedFrames.some((frame) =>
      frame.kind === "documentSnapshotWritten"
    )).toBe(true);
  });

  it("clears patchVerdicts after commit", async () => {
    const state = createSession("test");
    seedStateWithDoc(state);
    await addPatch(state, "patch-cv");

    await collectFrames(updatePatchVerdict(state, "patch-cv", "accepted"));
    expect(state.patchVerdicts.has("patch-cv")).toBe(true);
    await seedDocumentRow(state);

    await collectAsyncFrames(commitPatches(state, ["patch-cv"]));
    expect(state.patchVerdicts.has("patch-cv")).toBe(false);
  });

  it("unknown patch ID is a logged successful commit no-op", async () => {
    const state = createSession("test");
    seedStateWithDoc(state);
    const warn = vi.spyOn(mastra.getLogger(), "warn").mockImplementation(() => undefined);

    const frames = await collectAsyncFrames(commitPatches(state, ["nonexistent"]));

    expect(frames).toEqual([
      {
        kind: "docStateChanged",
        data: {
          state: { kind: "editing" },
          activeOverlay: null,
          agentBusy: false,
          reviewCompletion: "noop",
        },
      },
    ]);
    expect(warn).toHaveBeenCalledWith(
      "Skipped unknown or resolved review target",
      expect.objectContaining({
        sessionId: "test",
        command: "commit",
        patchId: "nonexistent",
        stateSuggestionRecordCount: 0,
        skipped: "patchCommitTarget",
        remainingValidIdCount: 0,
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// Tests: BridgeFrame format compliance
// ---------------------------------------------------------------------------

describe("BridgeFrame format compliance", () => {
  it("every frame has kind and data properties", async () => {
    const state = createSession("test");
    seedStateWithDoc(state);
    await addPatch(state, "patch-1");
    await seedDocumentRow(state);

    const frames = await collectAsyncFrames(commitPatches(state, ["patch-1"]));

    for (const frame of frames) {
      expect(frame).toHaveProperty("kind");
      expect(frame).toHaveProperty("data");
      expect(typeof frame.kind).toBe("string");
    }
  });

  it("toolCallUpdated frame has correct nested structure", async () => {
    const state = createSession("test");
    seedStateWithDoc(state);
    await addPatch(state, "patch-1");

    const frames = await collectFrames(updatePatchVerdict(state, "patch-1", "accepted"));
    const frame = frames[0]!;

    expect(frame.kind).toBe("toolCallUpdated");
    if (frame.kind === "toolCallUpdated") {
      expect(frame.data).toHaveProperty("messageId");
      expect(frame.data).toHaveProperty("toolCallId");
      expect(frame.data).toHaveProperty("spec");

      const spec = frame.data.spec;
      expect(spec).toHaveProperty("id");
      expect(spec).toHaveProperty("name");
      expect(spec).toHaveProperty("render");
      expect(spec).toHaveProperty("status");
      expect(spec).toHaveProperty("body");
      expect(spec).toHaveProperty("result");

      // render should be a tagged union
      expect(spec.render).toHaveProperty("kind");
      // status should be a tagged union
      expect(spec.status).toHaveProperty("kind");
      // body should be a tagged union
      expect(spec.body).toHaveProperty("kind");
    }
  });

  it("documentSnapshotWritten frame has correct doc structure", async () => {
    const state = createSession("test");
    seedStateWithDoc(state);
    await addPatch(state, "patch-1");
    await seedDocumentRow(state);

    const frames = await collectAsyncFrames(commitPatches(state, ["patch-1"]));
    const docFrame = frames.find((f) => f.kind === "documentSnapshotWritten");
    expect(docFrame).toBeDefined();

    if (docFrame?.kind === "documentSnapshotWritten") {
      const doc = docFrame.data.doc;
      expect(doc).toHaveProperty("version");
      expect(doc).toHaveProperty("ts");
      expect(doc).toHaveProperty("doc");
      expect(typeof doc.version).toBe("number");
      expect(typeof doc.ts).toBe("string");
      expect(doc.doc.type).toBe("doc");
      expect(Array.isArray(doc.doc.content)).toBe(true);
    }
  });

  it("docStateChanged frame has correct state shape", async () => {
    const state = createSession("test");
    seedStateWithDoc(state);
    await addPatch(state, "patch-1");

    const frames = await collectAsyncFrames(commitPatches(state, ["patch-1"]));
    const stateFrames = frames.filter((f) => f.kind === "docStateChanged");

    for (const frame of stateFrames) {
      if (frame.kind === "docStateChanged") {
        expect(frame.data.state).toHaveProperty("kind");
        expect(
          [
            "empty",
            "editing",
            "pendingReview",
            "init",
            "plan",
            "drafting",
            "draft",
            "locked",
            "review",
            "committed",
            "history",
          ].includes(frame.data.state.kind),
        ).toBe(true);
      }
    }
  });
});

// resumeAfterAskUser has been removed; askUser resumes through runAgentTurn.
// Integration tests for the generateDoc tool-result handling belong in
// an E2E / integration test suite that can mock the LLM provider.
