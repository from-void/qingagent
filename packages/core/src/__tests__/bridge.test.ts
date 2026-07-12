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
import { legacySectionsToPm } from "@qingagent/pm-schema";
import { compileSuggestionFromBeforeAfter } from "../doc-engine/pmPatch.js";
import { documentRepo } from "@qingagent/db";
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

function collectFrames(gen: Generator<BridgeFrame>): BridgeFrame[] {
  const frames: BridgeFrame[] = [];
  for (const f of gen) {
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
  state.legacySections = [
    { kind: "h1", data: { text: "春天的校园" } },
    { kind: "p", data: { text: "三月的阳光透过教学楼的玻璃窗，洒在走廊的地砖上。" } },
    { kind: "h2", data: { text: "花开时节", anchor: null } },
    {
      kind: "p",
      data: { text: "校园里的樱花树在不知不觉间绽放了，粉白色的花瓣随风飘落。" },
    },
  ];
  state.doc = legacySectionsToPm(state.legacySections as never);
  state.docVersion = 1;
  state.docState = { kind: "pendingReview" };
}

type PatchOverrides = Partial<{
  before: string;
  after: string;
  blockIndex: number;
  summary: string;
}>;

function addPatch(
  state: SessionState,
  id: string,
  overrides?: PatchOverrides,
): void {
  const patch = {
    messageId: "msg-1",
    toolCallId: id,
    before: "三月的阳光",
    after: "四月的暖阳",
    blockIndex: 1,
    summary: "将三月改为四月",
    ...overrides,
  };
  state.doc ??= legacySectionsToPm(state.legacySections as never);
  const result = compileSuggestionFromBeforeAfter({
    doc: state.doc,
    docId: state.docId,
    baseVersion: state.docVersion,
    suggestionId: id,
    patch,
  });
  if (!result.ok) throw new Error(result.error);
  state.suggestions.set(id, {
    messageId: patch.messageId,
    toolCallId: patch.toolCallId,
    before: patch.before,
    after: patch.after,
    blockIndex: result.record.blockIndex,
    suggestion: result.record.suggestion,
  });
  state.suggestionBaseDoc ??= state.doc;
  state.suggestionBaseVersion ??= state.docVersion;
}

async function seedDocumentRow(state: SessionState): Promise<void> {
  await documentRepo.save(
    documentInput(state.docId, {
      threadId: state.threadId ?? state.sessionId,
      resourceId: state.resourceId,
      docVersion: state.docVersion,
      legacySections: state.legacySections,
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
    expect(state.legacySections).toEqual([]);
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
  it("emits toolCallUpdated with 'accepted' status", () => {
    const state = createSession("test");
    seedStateWithDoc(state);
    addPatch(state, "patch-1");

    const frames = collectFrames(updatePatchVerdict(state, "patch-1", "accepted"));

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

  it("emits toolCallUpdated with 'rejected' status", () => {
    const state = createSession("test");
    seedStateWithDoc(state);
    addPatch(state, "patch-2");

    const frames = collectFrames(updatePatchVerdict(state, "patch-2", "rejected"));

    expect(frames).toHaveLength(1);
    const frame = frames[0]!;

    if (frame.kind === "toolCallUpdated") {
      expect(frame.data.spec.status).toEqual({ kind: "rejected" });
    }
  });

  it("persists verdict in state.patchVerdicts", () => {
    const state = createSession("test");
    seedStateWithDoc(state);
    addPatch(state, "patch-v1");
    addPatch(state, "patch-v2");

    collectFrames(updatePatchVerdict(state, "patch-v1", "accepted"));
    collectFrames(updatePatchVerdict(state, "patch-v2", "rejected"));

    expect(state.patchVerdicts.get("patch-v1")).toBe("accepted");
    expect(state.patchVerdicts.get("patch-v2")).toBe("rejected");
  });

  it("unknown patch ID is a logged successful no-op", () => {
    const state = createSession("test");
    const warn = vi.spyOn(mastra.getLogger(), "warn").mockImplementation(() => undefined);

    const frames = collectFrames(updatePatchVerdict(state, "nonexistent", "accepted"));

    expect(frames).toEqual([
      {
        kind: "docStateChanged",
        data: { state: { kind: "empty" }, activeOverlay: null, agentBusy: false },
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

  it("preserves patch body content in emitted spec", () => {
    const state = createSession("test");
    seedStateWithDoc(state);
    addPatch(state, "patch-3", {
      before: "樱花树",
      after: "梅花树",
      blockIndex: 3,
      summary: "将樱花改为梅花",
    });

    const frames = collectFrames(updatePatchVerdict(state, "patch-3", "accepted"));
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
    addPatch(state, "patch-1");
    state.patchVerdicts.set("patch-1", "accepted");
    state.patchValidationResults.set("patch-1", { ok: true, applied: true });
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
      const snapshotSections = docFrame.data.doc.sections ?? [];
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
    expect(state.patchValidationResults.size).toBe(0);
  });

  it("提交完全部审阅后释放残留 stream 锁,允许后续图编辑保存", async () => {
    const state = createSession("test-stale-stream");
    seedStateWithDoc(state);
    addPatch(state, "patch-1");
    state.patchVerdicts.set("patch-1", "accepted");
    state.patchValidationResults.set("patch-1", { ok: true, applied: true });
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

  it("clears committed patches from state after commit", async () => {
    const state = createSession("test");
    seedStateWithDoc(state);
    addPatch(state, "patch-a");
    addPatch(state, "patch-b", {
      before: "樱花树",
      after: "桃花树",
      blockIndex: 3,
      summary: "将樱花改为桃花",
    });
    await seedDocumentRow(state);

    // Commit only patch-a
    await collectAsyncFrames(commitPatches(state, ["patch-a"]));

    // patch-a should be removed, patch-b should remain
    expect(state.suggestions.has("patch-a")).toBe(false);
    expect(state.suggestions.has("patch-b")).toBe(true);
  });

  it("applies multiple patches in correct order", async () => {
    const state = createSession("test");
    seedStateWithDoc(state);

    // Add two patches on different sections
    addPatch(state, "p1", {
      before: "春天的校园",
      after: "秋天的校园",
      blockIndex: 0,
      summary: "春天改秋天",
    });
    addPatch(state, "p2", {
      before: "花开时节",
      after: "落叶时分",
      blockIndex: 2,
      summary: "花开改落叶",
    });
    await seedDocumentRow(state);

    const frames = await collectAsyncFrames(commitPatches(state, ["p1", "p2"]));

    const docFrame = frames.find((f) => f.kind === "documentSnapshotWritten");
    if (docFrame?.kind === "documentSnapshotWritten") {
      const sections = docFrame.data.doc.sections ?? [];
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
    addPatch(state, "patch-1");
    await seedDocumentRow(state);

    expect(state.docVersion).toBe(1);
    await collectAsyncFrames(commitPatches(state, ["patch-1"]));
    expect(state.docVersion).toBe(2);
  });

  it("transitions state to committed then draft", async () => {
    const state = createSession("test");
    seedStateWithDoc(state);
    addPatch(state, "patch-1");
    await seedDocumentRow(state);

    await collectAsyncFrames(commitPatches(state, ["patch-1"]));

    expect(state.docState).toEqual({ kind: "editing" });
  });

  it("skips rejected patches when committing", async () => {
    const state = createSession("test");
    seedStateWithDoc(state);

    // Add two patches on different sections
    addPatch(state, "p-acc", {
      before: "春天的校园",
      after: "秋天的校园",
      blockIndex: 0,
      summary: "春天改秋天",
    });
    addPatch(state, "p-rej", {
      before: "花开时节",
      after: "落叶时分",
      blockIndex: 2,
      summary: "花开改落叶",
    });

    // Accept one, reject the other
    collectFrames(updatePatchVerdict(state, "p-acc", "accepted"));
    collectFrames(updatePatchVerdict(state, "p-rej", "rejected"));
    await seedDocumentRow(state);

    const frames = await collectAsyncFrames(commitPatches(state, ["p-acc", "p-rej"]));

    const docFrame = frames.find((f) => f.kind === "documentSnapshotWritten");
    expect(docFrame).toBeDefined();
    if (docFrame?.kind === "documentSnapshotWritten") {
      const sections = docFrame.data.doc.sections ?? [];
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

  it("clears patchVerdicts after commit", async () => {
    const state = createSession("test");
    seedStateWithDoc(state);
    addPatch(state, "patch-cv");

    collectFrames(updatePatchVerdict(state, "patch-cv", "accepted"));
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
        data: { state: { kind: "editing" }, activeOverlay: null, agentBusy: false },
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
    addPatch(state, "patch-1");
    await seedDocumentRow(state);

    const frames = await collectAsyncFrames(commitPatches(state, ["patch-1"]));

    for (const frame of frames) {
      expect(frame).toHaveProperty("kind");
      expect(frame).toHaveProperty("data");
      expect(typeof frame.kind).toBe("string");
    }
  });

  it("toolCallUpdated frame has correct nested structure", () => {
    const state = createSession("test");
    seedStateWithDoc(state);
    addPatch(state, "patch-1");

    const frames = collectFrames(updatePatchVerdict(state, "patch-1", "accepted"));
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
    addPatch(state, "patch-1");
    await seedDocumentRow(state);

    const frames = await collectAsyncFrames(commitPatches(state, ["patch-1"]));
    const docFrame = frames.find((f) => f.kind === "documentSnapshotWritten");
    expect(docFrame).toBeDefined();

    if (docFrame?.kind === "documentSnapshotWritten") {
      const doc = docFrame.data.doc;
      expect(doc).toHaveProperty("version");
      expect(doc).toHaveProperty("ts");
      expect(doc).toHaveProperty("sections");
      expect(typeof doc.version).toBe("number");
      expect(typeof doc.ts).toBe("string");
      expect(Array.isArray(doc.sections)).toBe(true);

      // Each section should have kind and data
      for (const section of doc.sections ?? []) {
        expect(section).toHaveProperty("kind");
        expect(section).toHaveProperty("data");
      }
    }
  });

  it("docStateChanged frame has correct state shape", async () => {
    const state = createSession("test");
    seedStateWithDoc(state);
    addPatch(state, "patch-1");

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
