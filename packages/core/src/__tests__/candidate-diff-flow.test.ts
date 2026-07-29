import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  tableSelectionTextSignature,
  type BridgeFrame,
  type ChatChip,
  type LegacySection,
} from "@qingagent/contract-ts";
import {
  applyBlockEdits,
  getPmContentHash,
  legacySectionsToPm,
  materializeDraftBlockIds,
  pmToLegacySections,
  pmTableSelectionCellTexts,
  type PmBlockNode,
  type PmDoc,
  type PmInlineNode,
  type PmMark,
} from "@qingagent/pm-schema";
import { documentRepo } from "@qingagent/db";
import { findOpByDocumentVersion } from "@qingagent/db";
import { documentDraftRepo } from "@qingagent/db";
import { listVersions } from "@qingagent/db";
import {
  documentInput,
  prepareTempDocumentsDb,
  type TempDocumentsDb,
} from "@qingagent/db/testing";

const { agentStream, logger, memory, memoryEnabled, threads } = vi.hoisted(() => {
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  const threads = new Map<string, Record<string, unknown>>();
  const memory = {
    updateThread: vi.fn(
      async ({ id, title, metadata }: { id: string; title: string; metadata: Record<string, unknown> }) => {
        const existing = threads.get(id) ?? {
          id,
          resourceId: "qingagent-user",
          createdAt: new Date("2026-01-01T00:00:00.000Z"),
        };
        threads.set(id, {
          ...existing,
          id,
          title,
          metadata,
          updatedAt: new Date("2026-01-01T00:00:00.000Z"),
        });
      },
    ),
    getThreadById: vi.fn(async ({ threadId }: { threadId: string }) => threads.get(threadId) ?? null),
    recall: vi.fn(async () => ({ messages: [] })),
  };
  return { agentStream: vi.fn(), logger, memory, memoryEnabled: { value: false }, threads };
});

vi.mock("../mastra.js", () => ({
  mastra: {
    getLogger: () => logger,
    getMemory: () => (memoryEnabled.value ? memory : null),
  },
  getObservability: () => null,
}));

vi.mock("../agents/qingagent.js", () => ({
  getQingagentSkills: vi.fn(async () => ({
    maybeRefresh: vi.fn(async () => {}),
    has: vi.fn(async () => false),
  })),
  qingagentAgent: {
    stream: agentStream,
    resumeStream: vi.fn(),
  },
}));

type StreamChunk =
  | {
      type: "tool-call";
      payload: {
        toolName: "readDraft" | "writeDraft" | "editDraft";
        toolCallId: string;
        args: Record<string, unknown>;
      };
    }
  | {
      type: "tool-result";
      payload: {
        toolName: "readDraft" | "writeDraft" | "editDraft";
        toolCallId: string;
        args: Record<string, unknown>;
        result: Record<string, unknown>;
      };
    };

async function* streamOf(...chunks: StreamChunk[]): AsyncGenerator<StreamChunk> {
  for (const chunk of chunks) yield chunk;
}

async function collectFrames(gen: AsyncGenerator<BridgeFrame>): Promise<BridgeFrame[]> {
  const frames: BridgeFrame[] = [];
  for await (const frame of gen) frames.push(frame);
  return frames;
}

async function collectFramesAndReturn<T>(
  gen: AsyncGenerator<BridgeFrame, T>,
): Promise<{ frames: BridgeFrame[]; result: T }> {
  const frames: BridgeFrame[] = [];
  for (;;) {
    const next = await gen.next();
    if (next.done) return { frames, result: next.value };
    frames.push(next.value);
  }
}

function appendedToolCallIds(frames: BridgeFrame[], toolName: string): string[] {
  return frames.flatMap((frame) =>
    frame.kind === "chatMessageAppended" &&
    frame.data.part.kind === "toolCall" &&
    frame.data.part.data.name === toolName
      ? [frame.data.part.data.id]
      : [],
  );
}

function doneToolCallIds(frames: BridgeFrame[], toolName: string): string[] {
  return frames.flatMap((frame) =>
    frame.kind === "toolCallUpdated" &&
    frame.data.spec.name === toolName &&
    frame.data.spec.status.kind === "done"
      ? [frame.data.toolCallId]
      : [],
  );
}

function p(text: string): LegacySection {
  return { kind: "p", data: { text } };
}

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

function pmDoc(content: PmBlockNode[]): PmDoc {
  return {
    type: "doc",
    attrs: { schemaVersion: 1 },
    content,
  };
}

function docText(doc: PmDoc | undefined): string {
  return (doc?.content ?? [])
    .map((block) =>
      "content" in block && Array.isArray(block.content)
        ? block.content.map((node) => (node.type === "text" ? node.text : "\n")).join("")
        : "",
    )
    .join("\n");
}

function tableTexts(doc: PmDoc | undefined): string[][] {
  const table = doc?.content.find((block): block is Extract<PmBlockNode, { type: "table" }> => block.type === "table");
  return (table?.content ?? []).map((row) =>
    row.content.map((cell) =>
      cell.content
        .map((block) =>
          "content" in block && Array.isArray(block.content)
            ? block.content.map((node) => node.type === "text" ? node.text : "").join("")
            : "",
        )
        .join(""),
    ),
  );
}

function writeDraftCall(toolCallId: string): StreamChunk {
  return {
    type: "tool-call",
    payload: { toolName: "writeDraft", toolCallId, args: { title: "测试", outline: "大纲" } },
  };
}

function editDraftCall(toolCallId: string, args: Record<string, unknown>): StreamChunk {
  return {
    type: "tool-call",
    payload: { toolName: "editDraft", toolCallId, args },
  };
}

function editDraftResult(
  toolCallId: string,
  args: Record<string, unknown>,
  result: Record<string, unknown>,
): StreamChunk {
  return {
    type: "tool-result",
    payload: { toolName: "editDraft", toolCallId, args, result },
  };
}

// writeDraft 真实 execute 会把生成结果写进 state.docDraftCandidateDoc(本处被 mock 掉,
// 故由测试在调用前手动落候选,模拟 execute 已跑完);tool-result 只回 {ok}。
function writeDraftResult(toolCallId: string): StreamChunk {
  return {
    type: "tool-result",
    payload: {
      toolName: "writeDraft",
      toolCallId,
      args: { title: "测试", outline: "大纲" },
      result: { ok: true, blockCount: 1, wordCount: 10 },
    },
  };
}

function readDraftCall(toolCallId: string): StreamChunk {
  return {
    type: "tool-call",
    payload: { toolName: "readDraft", toolCallId, args: { query: "首稿" } },
  };
}

function readDraftResult(toolCallId: string): StreamChunk {
  return {
    type: "tool-result",
    payload: {
      toolName: "readDraft",
      toolCallId,
      args: { query: "首稿" },
      result: { ok: true, text: "首稿正文", blocks: [] },
    },
  };
}

async function collectUntil(
  gen: AsyncGenerator<BridgeFrame>,
  stop: (frame: BridgeFrame) => boolean,
): Promise<BridgeFrame[]> {
  const frames: BridgeFrame[] = [];
  for (;;) {
    const next = await gen.next();
    if (next.done) break;
    frames.push(next.value);
    if (stop(next.value)) {
      await gen.return(undefined as never);
      break;
    }
  }
  return frames;
}

describe("candidate-diff backend flow", () => {
  let tempDb: TempDocumentsDb;

  beforeEach(async () => {
    // 影子双写已恒开:临时 libsql 库即是隔离,双写真实落在临时库。
    tempDb = prepareTempDocumentsDb("qingagent-candidate-diff-");
    vi.clearAllMocks();
    threads.clear();
    memoryEnabled.value = false;
    const { __resetSessionPersistenceForTest } = await import("../session/threadPersistence.js");
    __resetSessionPersistenceForTest();
  });

  afterEach(async () => {
    const { __resetSessionPersistenceForTest } = await import("../session/threadPersistence.js");
    __resetSessionPersistenceForTest();
    tempDb.cleanup();
  });

  async function seedDocument(state: {
    docId: string;
    sessionId: string;
    threadId?: string | null;
    docVersion: number;
    doc: PmDoc;
  }): Promise<void> {
    await documentRepo.save(
      documentInput(state.docId, {
        threadId: state.threadId ?? state.sessionId,
        docVersion: state.docVersion,
        legacySections: pmToLegacySections(state.doc) as unknown as LegacySection[],
        pmDoc: state.doc,
      }),
    );
  }

  it("首稿 writeDraft 胜出后先投影候选，回合末只提交一次 generation_finished", async () => {
    // 回归:AI-IR 出稿工具 writeDraft 此前不设 settledDocGenerationId,导致 settle 走
    // 裸 documentSnapshotWritten 分支,前端 native presentation 整篇打字机不触发(光标书写特效丢失)。
    // 修复:writeDraft 赋 generation id,使 settle 发 generation_finished。
    const { createSession, drainSessionPersistence, processAgentStream } = await import("../bridge/index.js");
    const state = createSession("candidate-writedraft-first");
    const generatedDoc = legacySectionsToPm([p("第一版正文")] as never);
    // 模拟 writeDraft.execute 已把候选文档落进 state(真实 execute 在 mock 流里不会跑)。
    state.docDraftCandidateDoc = generatedDoc;
    state.docDraftCandidateSections = pmToLegacySections(generatedDoc) as unknown as LegacySection[];

    const frames = await collectFrames(
      processAgentStream(
        streamOf(writeDraftCall("wd-first"), writeDraftResult("wd-first")),
        {
          state,
          agentMessageId: "agent-msg",
          streamId: "stream-writedraft",
          runId: "run-writedraft",
        },
      ),
    );

    const finished = frames.find(
      (frame) => frame.kind === "docGenerationEvent" && frame.data.kind === "generation_finished",
    );
    const projected = frames.find(
      (frame) => frame.kind === "docGenerationEvent" && frame.data.kind === "candidate_snapshot",
    );
    expect(projected?.kind).toBe("docGenerationEvent");
    if (projected?.kind === "docGenerationEvent" && projected.data.kind === "candidate_snapshot") {
      expect(docText(projected.data.data.doc)).toBe("第一版正文");
      expect(projected.data.data.baseVersion).toBe(0);
    }
    expect(finished?.kind).toBe("docGenerationEvent");
    if (finished?.kind === "docGenerationEvent" && finished.data.kind === "generation_finished") {
      // 前端揭示契约:必须是 generation_finished + 完整 PM doc + 推进后的版本/hash。
      // 事件先于异步标题与 editing 投影交付,故 web 必须能跨这个 locked 空窗保留 run。
      expect(docText(finished.data.data.doc)).toBe("第一版正文");
      expect(finished.data.data.finalVersion).toBe(state.docVersion);
      expect(finished.data.data.contentHash).toBe(getPmContentHash(generatedDoc));
    }
    const finishedIndex = frames.indexOf(finished!);
    const projectedIndex = frames.indexOf(projected!);
    const editingIndex = frames.findIndex(
      (frame) => frame.kind === "docStateChanged" && frame.data.state.kind === "editing",
    );
    expect(finishedIndex).toBeGreaterThanOrEqual(0);
    expect(projectedIndex).toBeGreaterThanOrEqual(0);
    expect(finishedIndex).toBeGreaterThan(projectedIndex);
    expect(frames.filter(
      (frame) => frame.kind === "docGenerationEvent" && frame.data.kind === "generation_finished",
    )).toHaveLength(1);
    expect(editingIndex).toBeGreaterThan(finishedIndex);
    // 首稿走整篇直接落地,不进审查、不发裸 documentSnapshotWritten。
    expect(frames.some((frame) => frame.kind === "docDiffReady")).toBe(false);
    expect(frames.some((frame) => frame.kind === "documentSnapshotWritten")).toBe(false);
    expect(state.docState).toEqual({ kind: "editing" });
    expect(docText(state.doc)).toBe("第一版正文");
  }, 10_000);

  it("空文档 editDraft insertBlock 在回合末按首稿提交并清理候选", async () => {
    const {
      createSession,
      createSessionScopedTools,
      processAgentStream,
    } = await import("../bridge/index.js");
    const state = createSession("candidate-editdraft-first");
    const args = {
      ops: [{
        action: "insertBlock" as const,
        position: "end" as const,
        blocks: "<p>editDraft 生成的首稿正文</p>",
      }],
    };
    const { editDraft } = createSessionScopedTools(state);
    const editResult = await editDraft.execute!(args, {} as never) as Record<string, unknown>;
    expect(editResult).toMatchObject({ ok: true, changed: true });

    const frames = await collectFrames(
      processAgentStream(
        streamOf(
          editDraftCall("ed-first", args),
          editDraftResult("ed-first", args, editResult),
        ),
        {
          state,
          agentMessageId: "agent-msg",
          streamId: "stream-editdraft-first",
          runId: "run-editdraft-first",
        },
      ),
    );

    expect(frames.some((frame) => frame.kind === "documentSnapshotWritten")).toBe(true);
    expect(state.docVersion).toBe(1);
    expect(docText(state.doc)).toBe("editDraft 生成的首稿正文");
    expect(state.docDraftCandidateDoc).toBeNull();
    await expect(documentDraftRepo.load(state.docId)).resolves.toBeNull();
    expect(docText((await documentRepo.load(state.docId))?.pmDoc)).toBe(
      "editDraft 生成的首稿正文",
    );
  });

  it("writeDraft 后连续 editDraft 每次更新候选投影，canonical 仍只在回合末提交一次", async () => {
    const { createSession, processAgentStream } = await import("../bridge/index.js");
    const state = createSession("candidate-write-edit-projection");
    const initialCandidate = legacySectionsToPm([p("胜出首稿")] as never);
    const editedCandidate = legacySectionsToPm([p("胜出首稿，已补充细节")] as never);
    state.docDraftCandidateDoc = initialCandidate;
    state.docDraftCandidateSections =
      pmToLegacySections(initialCandidate) as unknown as LegacySection[];

    async function* streamWithEdit(): AsyncGenerator<StreamChunk> {
      yield writeDraftCall("wd-project");
      yield writeDraftResult("wd-project");
      state.docDraftCandidateDoc = editedCandidate;
      state.docDraftCandidateSections =
        pmToLegacySections(editedCandidate) as unknown as LegacySection[];
      const args = {
        ops: [{
          action: "replaceBlock",
          blockId: editedCandidate.content[0]?.attrs?.blockId,
          blocks: "<p>胜出首稿，已补充细节</p>",
        }],
      };
      yield editDraftCall("ed-project", args);
      yield editDraftResult("ed-project", args, {
        ok: true,
        applied: [editedCandidate.content[0]?.attrs?.blockId],
        changed: true,
        hunkCount: 1,
      });
    }

    const frames = await collectFrames(
      processAgentStream(streamWithEdit(), {
        state,
        agentMessageId: "agent-project",
        streamId: "stream-project",
        runId: "run-project",
      }),
    );
    const snapshots = frames.filter(
      (frame) =>
        frame.kind === "docGenerationEvent" &&
        frame.data.kind === "candidate_snapshot",
    );
    expect(snapshots).toHaveLength(2);
    expect(snapshots.map((frame) =>
      frame.kind === "docGenerationEvent" &&
      frame.data.kind === "candidate_snapshot"
        ? docText(frame.data.data.doc)
        : null
    )).toEqual(["胜出首稿", "胜出首稿，已补充细节"]);
    const finished = frames.filter(
      (frame) =>
        frame.kind === "docGenerationEvent" &&
        frame.data.kind === "generation_finished",
    );
    expect(finished).toHaveLength(1);
    expect(docText(state.doc)).toBe("胜出首稿，已补充细节");
    expect(state.docVersion).toBe(1);
  }, 10_000);

  it("noop 丢弃候选时同步清库，冷恢复不再提交已丢弃首稿", async () => {
    const {
      createSession,
      rehydratePendingDraft,
      settleDraftCandidate,
    } = await import("../bridge/index.js");
    const sessionId = "candidate-noop-clears-checkpoint";
    const state = createSession(sessionId);
    const candidate = legacySectionsToPm([p("应被丢弃的候选正文")] as never);
    state.docDraftCandidateDoc = candidate;
    state.docDraftCandidateSections =
      pmToLegacySections(candidate) as unknown as LegacySection[];
    await documentDraftRepo.saveCandidate({
      docId: state.docId,
      threadId: state.sessionId,
      baseVersion: 0,
      baseHash: getPmContentHash(legacySectionsToPm([] as never)),
      draftPmDoc: candidate,
      sourceStreamId: "stream-noop",
      sourceToolCallId: "ed-noop",
    });

    const settled = await collectFramesAndReturn(settleDraftCandidate({
      state,
      agentMessageId: "agent-msg",
      streamId: "stream-noop",
      runId: "run-noop",
      wholeDocument: false,
    }));

    expect(settled.result).toEqual({ hunkCount: 0, docWritten: false });
    await expect(documentDraftRepo.load(state.docId)).resolves.toBeNull();
    const restarted = createSession(sessionId);
    await expect(rehydratePendingDraft(restarted)).resolves.toEqual({ kind: "skipped" });
    expect(restarted.docVersion).toBe(0);
    await expect(documentRepo.load(state.docId)).resolves.toBeNull();
  });

  it.each([
    [
      "纯图片文档",
      pmDoc([{
        type: "image",
        attrs: {
          blockId: "base-image",
          src: "/api/v1/files/550e8400-e29b-41d4-a716-446655440000/base.svg",
          alt: null,
          caption: null,
        },
      }]),
    ],
    [
      "纯分隔线文档",
      pmDoc([{ type: "horizontalRule", attrs: { blockId: "base-rule" } }]),
    ],
  ])("%s 不进 review、直接落地首稿", async (_label, baseDoc) => {
    const { createSession, processAgentStream } = await import("../bridge/index.js");
    const state = createSession(`candidate-empty-media-${baseDoc.content[0]?.type}`);
    const generatedDoc = legacySectionsToPm([p("直接落地的首稿正文")] as never);
    state.doc = baseDoc;
    state.legacySections = pmToLegacySections(baseDoc) as unknown as LegacySection[];
    state.docVersion = 1;
    state.docState = { kind: "editing" };
    state.docDraftCandidateDoc = generatedDoc;
    state.docDraftCandidateSections = pmToLegacySections(generatedDoc) as unknown as LegacySection[];
    await seedDocument({ docId: state.docId, sessionId: state.sessionId, docVersion: 1, doc: baseDoc });

    const frames = await collectFrames(
      processAgentStream(
        streamOf(writeDraftCall("wd-empty-media"), writeDraftResult("wd-empty-media")),
        {
          state,
          agentMessageId: "agent-msg",
          streamId: "stream-empty-media",
          runId: "run-empty-media",
        },
      ),
    );

    expect(frames.some((frame) => frame.kind === "docDiffReady")).toBe(false);
    expect(frames.some(
      (frame) => frame.kind === "docGenerationEvent" && frame.data.kind === "generation_finished",
    )).toBe(true);
    expect(state.suggestions.size).toBe(0);
    expect(state.docState).toEqual({ kind: "editing" });
    expect(docText(state.doc)).toBe("直接落地的首稿正文");
  }, 10_000);

  it("writeDraft 成功后同回合 askUserQuestion 挂起,先落定首稿且恢复后的 readDraft 可读", async () => {
    const {
      createSession,
      createSessionScopedTools,
      processAgentStream,
    } = await import("../bridge/index.js");
    const state = createSession("candidate-write-then-suspend");
    const generatedDoc = legacySectionsToPm([p("挂起后仍可读取的首稿正文")] as never);
    state.docDraftCandidateDoc = generatedDoc;
    state.docDraftCandidateSections = pmToLegacySections(generatedDoc) as unknown as LegacySection[];

    const askUserCall = {
      type: "tool-call",
      payload: {
        toolName: "askUserQuestion",
        toolCallId: "ask-after-write",
        args: { purpose: "quickClarification" },
      },
    } as unknown as StreamChunk;
    const askUserSuspend = {
      type: "tool-call-suspended",
      payload: {
        toolName: "askUserQuestion",
        toolCallId: "ask-after-write",
        args: { purpose: "quickClarification" },
        suspendPayload: {
          id: "ask-after-write",
          purpose: "quickClarification",
          source: null,
          rationale: "确认是否精简",
          questions: [{
            id: "q-confirm",
            label: "是否精简到 1800 字？",
            kind: "single",
            options: [{ value: "yes", label: "是", description: null, preview: null }],
            placeholder: null,
          }],
        },
      },
    } as unknown as StreamChunk;

    const frames = await collectFrames(
      processAgentStream(
        streamOf(
          writeDraftCall("wd-before-suspend"),
          writeDraftResult("wd-before-suspend"),
          askUserCall,
          askUserSuspend,
        ),
        {
          state,
          agentMessageId: "agent-write-then-suspend",
          streamId: "stream-write-then-suspend",
          runId: "run-write-then-suspend",
        },
      ),
    );

    // 挂起帧返回前已走与自然回合末相同的 generation settle；首稿成为 canonical，
    // scratch 可以清掉但内容不能丢，右侧必须先收到完整 PM 文档帧。
    expect(state.runId).toBe("run-write-then-suspend");
    expect(state.docVersion).toBe(1);
    expect(docText(state.doc)).toBe("挂起后仍可读取的首稿正文");
    expect(state.docDraftCandidateDoc).toBeNull();
    const finishedIndex = frames.findIndex(
      (frame) => frame.kind === "docGenerationEvent" && frame.data.kind === "generation_finished",
    );
    const askPendingIndex = frames.findIndex(
      (frame) =>
        frame.kind === "toolCallUpdated" &&
        frame.data.toolCallId === "ask-after-write" &&
        frame.data.spec.status.kind === "pending",
    );
    expect(finishedIndex).toBeGreaterThanOrEqual(0);
    expect(askPendingIndex).toBeGreaterThan(finishedIndex);
    const finished = frames[finishedIndex];
    if (finished?.kind !== "docGenerationEvent" || finished.data.kind !== "generation_finished") {
      throw new Error("expected generation_finished before askUser suspension");
    }
    expect(docText(finished.data.data.doc)).toBe("挂起后仍可读取的首稿正文");
    expect(frames.some(
      (frame) =>
        frame.kind === "docStateChanged" &&
        frame.data.state.kind === "editing" &&
        frame.data.activeOverlay === "askUser",
    )).toBe(true);

    // handleResume 注入的正是同一个 sessionScoped readDraft；直接执行真实工具，
    // 验证活会话恢复无需冷回灌也能读到刚才的候选内容。
    const { readDraftAiIr } = createSessionScopedTools(state);
    const readResult = await readDraftAiIr.execute!(
      { mode: "full", includeText: true },
      {} as never,
    ) as { ok: boolean; blocks?: Array<{ text?: string }>; wordCount?: number };
    expect(readResult.ok).toBe(true);
    expect(readResult.wordCount).toBeGreaterThan(0);
    expect(readResult.blocks?.map((block) => block.text).join("\n"))
      .toContain("挂起后仍可读取的首稿正文");
  }, 10_000);

  it("已有正文的 writeDraft 同回合挂起仍进入 pendingReview,并保留新版候选供 readDraft", async () => {
    const {
      createSession,
      createSessionScopedTools,
      processAgentStream,
    } = await import("../bridge/index.js");
    const state = createSession("candidate-rewrite-then-suspend");
    const baseDoc = legacySectionsToPm([p("旧版正文")] as never);
    const generatedDoc = legacySectionsToPm([p("待确认的新版正文")] as never);
    state.doc = baseDoc;
    state.legacySections = pmToLegacySections(baseDoc) as unknown as LegacySection[];
    state.docVersion = 1;
    state.docState = { kind: "editing" };
    state.docDraftBaseDoc = baseDoc;
    state.docDraftBaseSections = pmToLegacySections(baseDoc) as unknown as LegacySection[];
    state.docDraftBaseVersion = 1;
    state.docDraftCandidateDoc = generatedDoc;
    state.docDraftCandidateSections = pmToLegacySections(generatedDoc) as unknown as LegacySection[];
    await seedDocument({ docId: state.docId, sessionId: state.sessionId, docVersion: 1, doc: baseDoc });

    const frames = await collectFrames(
      processAgentStream(
        streamOf(
          writeDraftCall("wd-rewrite-before-suspend"),
          writeDraftResult("wd-rewrite-before-suspend"),
          {
            type: "tool-call",
            payload: {
              toolName: "askUserQuestion",
              toolCallId: "ask-after-rewrite",
              args: { purpose: "quickClarification" },
            },
          } as unknown as StreamChunk,
          {
            type: "tool-call-suspended",
            payload: {
              toolName: "askUserQuestion",
              toolCallId: "ask-after-rewrite",
              args: { purpose: "quickClarification" },
              suspendPayload: {
                id: "ask-after-rewrite",
                purpose: "quickClarification",
                source: null,
                rationale: "确认改写方向",
                questions: [{
                  id: "q-confirm-rewrite",
                  label: "是否采用新版？",
                  kind: "single",
                  options: [{ value: "yes", label: "是", description: null, preview: null }],
                  placeholder: null,
                }],
              },
            },
          } as unknown as StreamChunk,
        ),
        {
          state,
          agentMessageId: "agent-rewrite-then-suspend",
          streamId: "stream-rewrite-then-suspend",
          runId: "run-rewrite-then-suspend",
        },
      ),
    );

    expect(state.docState).toEqual({ kind: "pendingReview" });
    expect(state.docVersion).toBe(1);
    expect(docText(state.doc)).toBe("旧版正文");
    expect(docText(state.docDraftCandidateDoc ?? undefined)).toBe("待确认的新版正文");
    expect(frames.some((frame) => frame.kind === "docDiffReady")).toBe(true);
    expect(frames.some(
      (frame) =>
        frame.kind === "docStateChanged" &&
        frame.data.state.kind === "pendingReview" &&
        frame.data.activeOverlay === "askUser",
    )).toBe(true);

    const { readDraftAiIr } = createSessionScopedTools(state);
    const readResult = await readDraftAiIr.execute!(
      { mode: "full", includeText: true },
      {} as never,
    ) as { blocks?: Array<{ text?: string }> };
    expect(readResult.blocks?.map((block) => block.text).join("\n"))
      .toContain("待确认的新版正文");
  }, 10_000);

  it("writeDraft 成功后即使 settle 前中断也已写入 draft_candidate row", async () => {
    const { createSession, drainSessionPersistence, processAgentStream } = await import("../bridge/index.js");
    const state = createSession("candidate-writedraft-checkpoint");
    const generatedDoc = legacySectionsToPm([p("checkpoint 首稿")] as never);
    state.docDraftCandidateDoc = generatedDoc;
    state.docDraftCandidateSections = pmToLegacySections(generatedDoc) as unknown as LegacySection[];

    await collectUntil(
      processAgentStream(
        streamOf(writeDraftCall("wd-checkpoint"), writeDraftResult("wd-checkpoint")),
        {
          state,
          agentMessageId: "agent-msg",
          streamId: "stream-checkpoint",
          runId: "run-checkpoint",
        },
      ),
      (frame) =>
        frame.kind === "toolCallUpdated" &&
        frame.data.toolCallId === "wd-checkpoint" &&
        frame.data.spec.status.kind === "done",
    );

    const row = await documentDraftRepo.load(state.docId);
    expect(row).toMatchObject({
      status: "draft_candidate",
      baseVersion: 0,
      sourceStreamId: "stream-checkpoint",
      sourceToolCallId: "wd-checkpoint",
    });
    expect(docText(row?.draftPmDoc)).toBe("checkpoint 首稿");
    await expect(documentRepo.load(state.docId)).resolves.toBeNull();
    const writeDraftPart = state.chatHistory
      .flatMap((message) => message.parts)
      .find((part) => part.kind === "toolCall" && part.data.id === "wd-checkpoint");
    expect(writeDraftPart?.kind).toBe("toolCall");
    if (writeDraftPart?.kind === "toolCall") {
      expect(writeDraftPart.data.status.kind).toBe("done");
    }
  });

  it("writeDraft checkpoint 后 readDraft result 中断,drain 后冷恢复保留轨迹并提交首稿", async () => {
    memoryEnabled.value = true;
    const {
      createSession,
      drainSessionPersistence,
      loadSessionFromThread,
      processAgentStream,
    } = await import("../bridge/index.js");
    const state = createSession("candidate-readDraft-restore");
    const generatedDoc = legacySectionsToPm([p("readDraft 后恢复的首稿")] as never);
    state.docDraftCandidateDoc = generatedDoc;
    state.docDraftCandidateSections = pmToLegacySections(generatedDoc) as unknown as LegacySection[];

    await collectUntil(
      processAgentStream(
        streamOf(
          writeDraftCall("wd-before-read"),
          writeDraftResult("wd-before-read"),
          readDraftCall("read-after-write"),
          readDraftResult("read-after-write"),
        ),
        {
          state,
          agentMessageId: "agent-msg",
          streamId: "stream-read-restore",
          runId: "run-read-restore",
        },
      ),
      (frame) =>
        frame.kind === "toolCallUpdated" &&
        frame.data.toolCallId === "read-after-write" &&
        frame.data.spec.status.kind === "done",
    );

    expect((await documentDraftRepo.load(state.docId))?.status).toBe("draft_candidate");
    await drainSessionPersistence();
    const restored = await loadSessionFromThread(state.sessionId);

    const toolNames =
      restored?.chatHistory.flatMap((message) =>
        message.parts.flatMap((part) => (part.kind === "toolCall" ? [part.data.name] : [])),
      ) ?? [];
    expect(toolNames).toEqual(expect.arrayContaining(["writeDraft", "readDraft"]));
    expect(docText(restored?.doc)).toBe("readDraft 后恢复的首稿");
    expect(restored?.docVersion).toBe(1);
    expect(restored?.modelKnownDocVersion).toBeNull();
    await expect(documentDraftRepo.load(state.docId)).resolves.toBeNull();
    await expect(listVersions(state.docId)).resolves.toHaveLength(1);
  });

  it("同回合 3 次 writeDraft 都追加 pill,只 settle 最后一次候选", async () => {
    memoryEnabled.value = true;
    const { createSession, drainSessionPersistence, processAgentStream } = await import("../bridge/index.js");
    const state = createSession("candidate-three-writedraft");
    const candidates = [
      legacySectionsToPm([p("第一轮正文")] as never),
      legacySectionsToPm([p("第二轮正文")] as never),
      legacySectionsToPm([p("第三轮正文 1303")] as never),
    ];

    async function* threeWriteDrafts(): AsyncGenerator<StreamChunk> {
      for (const [index, doc] of candidates.entries()) {
        const toolCallId = `wd-${index + 1}`;
        yield writeDraftCall(toolCallId);
        state.docDraftCandidateDoc = doc;
        state.docDraftCandidateSections = pmToLegacySections(doc) as unknown as LegacySection[];
        yield writeDraftResult(toolCallId);
      }
    }

    const frames = await collectFrames(
      processAgentStream(threeWriteDrafts(), {
        state,
        agentMessageId: "agent-msg",
        streamId: "stream-three-writedraft",
        runId: "run-three-writedraft",
      }),
    );
    await drainSessionPersistence();

    const historyToolCallIds =
      state.chatHistory[0]?.parts
        .filter((part) => part.kind === "toolCall" && part.data.name === "writeDraft")
        .map((part) => (part.kind === "toolCall" ? part.data.id : null)) ?? [];
    const finished = frames.filter(
      (frame) => frame.kind === "docGenerationEvent" && frame.data.kind === "generation_finished",
    );

    expect(appendedToolCallIds(frames, "writeDraft")).toEqual(["wd-1", "wd-2", "wd-3"]);
    expect(doneToolCallIds(frames, "writeDraft")).toEqual(["wd-1", "wd-2", "wd-3"]);
    expect(historyToolCallIds).toEqual(["wd-1", "wd-2", "wd-3"]);
    expect(finished).toHaveLength(1);
    if (finished[0]?.kind === "docGenerationEvent" && finished[0].data.kind === "generation_finished") {
      expect(finished[0].data.data.generationId).toBe("gen-stream-three-writedraft-wd-3");
      expect(docText(finished[0].data.data.doc)).toBe("第三轮正文 1303");
    }
    expect(docText(state.doc)).toBe("第三轮正文 1303");
    await expect(listVersions(state.docId)).resolves.toHaveLength(1);
    expect(memory.updateThread.mock.calls.length).toBeLessThanOrEqual(5);
  });

  it("writeDraft over an existing canonical doc writes the candidate draft, submit builds hunks, and commit creates a new version", async () => {
    const { createSession, commitPatches, processAgentStream } = await import("../bridge/index.js");
    const state = createSession("candidate-write");
    const baseDoc = legacySectionsToPm([p("旧版正文")] as never);
    const generatedDoc = legacySectionsToPm([p("第一版正文")] as never);
    state.doc = baseDoc;
    state.legacySections = pmToLegacySections(baseDoc) as unknown as LegacySection[];
    state.docVersion = 1;
    state.docState = { kind: "editing" };
    state.docDraftCandidateDoc = generatedDoc;
    state.docDraftCandidateSections = pmToLegacySections(generatedDoc) as unknown as LegacySection[];
    await seedDocument({ docId: state.docId, sessionId: state.sessionId, docVersion: 1, doc: baseDoc });

    const frames = await collectFrames(
      processAgentStream(
        streamOf(writeDraftCall("wd-1"), writeDraftResult("wd-1")),
        {
          state,
          agentMessageId: "agent-msg",
          streamId: "stream-write",
          runId: "run-write",
        },
      ),
    );

    expect(frames.some((frame) => frame.kind === "documentSnapshotWritten")).toBe(false);
    const diffFrame = frames.find((frame) => frame.kind === "docDiffReady");
    expect(diffFrame?.kind).toBe("docDiffReady");
    if (diffFrame?.kind === "docDiffReady") {
      expect(diffFrame.data.baseVersion).toBe(1);
      expect(diffFrame.data.suggestions.length).toBeGreaterThan(0);
    }
    expect(state.docVersion).toBe(1);
    expect(state.suggestions.size).toBeGreaterThan(0);
    const pendingDraft = await documentDraftRepo.load(state.docId);
    expect(pendingDraft).toMatchObject({
      docId: state.docId,
      threadId: state.sessionId,
      baseVersion: 1,
      baseHash: getPmContentHash(baseDoc),
      status: "pending_review",
    });
    expect(docText(pendingDraft?.draftPmDoc)).toBe("第一版正文");

    const commitFrames = await collectFrames(commitPatches(state, [...state.suggestions.keys()]));

    expect(commitFrames.some((frame) => frame.kind === "documentSnapshotWritten")).toBe(true);
    expect(state.docVersion).toBe(2);
    expect(docText(state.doc)).toBe("第一版正文");
    expect(state.lastContentEditedAt)
      .toBe((await findOpByDocumentVersion(state.docId, state.docVersion))?.createdAt);
    await expect(documentDraftRepo.load(state.docId)).resolves.toBeNull();
  });

  it("已有两处候选后 idle timeout 以成功提示收口，不发 draftingFailed", async () => {
    const { createSession, processAgentStream } = await import("../bridge/index.js");
    const { IDLE_TIMEOUT_ABORT_REASON } = await import("../agent-run/streamErrors.js");
    const state = createSession("candidate-idle-partial-success");
    const baseDoc = pmDoc([
      paragraph("block-a", "第一段旧文"),
      paragraph("block-b", "第二段旧文"),
    ]);
    const candidateDoc = pmDoc([
      paragraph("block-a", "第一段新文"),
      paragraph("block-b", "第二段新文"),
    ]);
    state.doc = baseDoc;
    state.legacySections = pmToLegacySections(baseDoc) as unknown as LegacySection[];
    state.docVersion = 1;
    state.docState = { kind: "editing" };
    state.docDraftCandidateDoc = candidateDoc;
    state.docDraftCandidateSections = pmToLegacySections(candidateDoc) as unknown as LegacySection[];
    await seedDocument({
      docId: state.docId,
      sessionId: state.sessionId,
      threadId: state.threadId,
      docVersion: state.docVersion,
      doc: baseDoc,
    });
    const abortController = new AbortController();

    async function* partialSuccessThenIdle(): AsyncGenerator<unknown> {
      yield writeDraftCall("wd-idle-partial");
      yield writeDraftResult("wd-idle-partial");
      yield { type: "step-finish", payload: { finishReason: "tool-calls" } };
      yield {
        type: "error",
        payload: {
          idleTimeout: true,
          error: new Error("agent stream idle timeout"),
        },
      };
      abortController.abort(IDLE_TIMEOUT_ABORT_REASON);
    }

    const frames = await collectFrames(
      processAgentStream(partialSuccessThenIdle(), {
        state,
        agentMessageId: "agent-msg",
        streamId: "stream-idle-partial-success",
        runId: "run-idle-partial-success",
        abortController,
      }),
    );
    const textBodies = frames.flatMap((frame) =>
      frame.kind === "chatMessageAppended" && frame.data.part.kind === "text"
        ? [frame.data.part.data.body]
        : [],
    );

    expect(state.suggestions.size).toBe(2);
    expect(frames.some((frame) =>
      frame.kind === "chatMessageAppended" &&
      frame.data.part.kind === "patchSummary" &&
      frame.data.part.data.count === 2
    )).toBe(true);
    expect(textBodies).toContain("已生成2处修改，请查看。");
    expect(frames.some(
      (frame) => frame.kind === "stream" && frame.data.kind === "draftingFailed",
    )).toBe(false);
  });

  it("editDraft table incremental candidate enters pendingReview and can be accepted", async () => {
    const { createSession, commitPatches, processAgentStream } = await import("../bridge/index.js");
    const state = createSession("candidate-table-accept");
    const baseDoc = pmDoc([
      {
        type: "table",
        attrs: { blockId: "table-a" },
        content: [
          {
            type: "tableRow",
            content: [
              { type: "tableHeader", content: [paragraph("table-a-h1-p", "列A，表头。")] },
              { type: "tableHeader", content: [paragraph("table-a-h2-p", "列B")] },
            ],
          },
          {
            type: "tableRow",
            content: [
              { type: "tableCell", content: [paragraph("table-a-r1-c1-p", "a1，原样。")] },
              { type: "tableCell", content: [paragraph("table-a-r1-c2-p", "b1")] },
            ],
          },
        ],
      } as PmBlockNode,
    ]);
    const ops = [{
      action: "insertTableRow",
      ref: "table-a",
      at: "end",
      cells: [
        { blocks: [{ type: "paragraph", runs: [{ text: "a2，新增。" }] }] },
        { blocks: [{ type: "paragraph", runs: [{ text: "b2" }] }] },
      ],
    }] as const;
    const applied = applyBlockEdits(baseDoc, ops);
    expect(applied.ok).toBe(true);
    const draftDoc = materializeDraftBlockIds(applied.doc!);
    state.doc = baseDoc;
    state.legacySections = pmToLegacySections(baseDoc) as unknown as LegacySection[];
    state.docVersion = 1;
    state.docState = { kind: "editing" };
    state.docDraftCandidateDoc = draftDoc;
    state.docDraftCandidateSections = pmToLegacySections(draftDoc) as unknown as LegacySection[];
    await seedDocument({ docId: state.docId, sessionId: state.sessionId, docVersion: 1, doc: baseDoc });

    const args = {
      ops: [{
        action: "insertTableRow",
        ref: "table-a",
        at: "end",
        cells: "<td>a2，新增。</td><td>b2</td>",
      }],
    };
    const frames = await collectFrames(
      processAgentStream(
        streamOf(
          editDraftCall("ed-table-accept", args),
          editDraftResult("ed-table-accept", args, { ok: true, applied: ["table-a"], changed: true, hunkCount: 1 }),
        ),
        {
          state,
          agentMessageId: "agent-msg",
          streamId: "stream-table-accept",
          runId: "run-table-accept",
        },
      ),
    );

    expect(frames.some((frame) => frame.kind === "documentSnapshotWritten")).toBe(false);
    expect(frames.find((frame) => frame.kind === "docDiffReady")?.kind).toBe("docDiffReady");
    expect(state.suggestions.size).toBe(1);

    await collectFrames(commitPatches(state, [...state.suggestions.keys()]));

    expect(tableTexts(state.doc)).toEqual([
      ["列A，表头。", "列B"],
      ["a1，原样。", "b1"],
      ["a2，新增。", "b2"],
    ]);
    await expect(documentDraftRepo.load(state.docId)).resolves.toBeNull();
  });

  it("生成→updateDoc 手动编辑→tableSelection editDraft→commit 保留用户正文并应用补丁", async () => {
    const {
      commitDocumentOp,
      commitPatches,
      createSession,
      invalidateDraftStateAfterCanonicalWrite,
      runAgentTurn,
    } = await import("../bridge/index.js");
    const state = createSession("candidate-table-user-truth");
    const generatedDoc = pmDoc([{
      type: "table",
      attrs: { blockId: "table-a" },
      content: [
        {
          type: "tableRow",
          content: [
            { type: "tableHeader", content: [paragraph("table-a-h1", "列A")] },
            { type: "tableHeader", content: [paragraph("table-a-h2", "列B")] },
            { type: "tableHeader", content: [paragraph("table-a-h3", "列C")] },
          ],
        },
        {
          type: "tableRow",
          content: [
            { type: "tableCell", content: [paragraph("table-a-r1-c1", "a1")] },
            { type: "tableCell", content: [paragraph("table-a-r1-c2", "b1")] },
            { type: "tableCell", content: [paragraph("table-a-r1-c3", "c1")] },
          ],
        },
      ],
    } as PmBlockNode]);
    state.doc = generatedDoc;
    state.legacySections = pmToLegacySections(generatedDoc) as unknown as LegacySection[];
    state.docVersion = 1;
    state.docState = { kind: "editing" };
    await seedDocument({ docId: state.docId, sessionId: state.sessionId, docVersion: 1, doc: generatedDoc });

    // 模拟历史残留候选；updateDoc 成功后必须同时失效内存与 document_drafts 基线。
    state.docDraftBaseDoc = generatedDoc;
    state.docDraftBaseVersion = 1;
    state.docDraftCandidateDoc = generatedDoc;
    await documentDraftRepo.saveCandidate({
      docId: state.docId,
      threadId: state.sessionId,
      baseVersion: 1,
      baseHash: getPmContentHash(generatedDoc),
      draftPmDoc: generatedDoc,
      sourceStreamId: "turn-1",
      sourceToolCallId: "write-1",
    });

    const manualDoc = structuredClone(generatedDoc);
    const manualTable = manualDoc.content[0];
    if (manualTable?.type !== "table") throw new Error("fixture table missing");
    const manualParagraph = manualTable.content[1]?.content[0]?.content[0];
    if (manualParagraph?.type !== "paragraph") throw new Error("fixture paragraph missing");
    const manualText = manualParagraph.content?.[0];
    if (manualText?.type !== "text") throw new Error("fixture text missing");
    manualText.text = "用户手改保留";
    const manualCommit = await commitDocumentOp({
      docId: state.docId,
      threadId: state.sessionId,
      resourceId: state.resourceId,
      expectedDocumentSnapshot: 1,
      clientMutationId: "manual-edit-1",
      opKind: "replace_doc",
      actorType: "user",
      summary: "用户编辑保存",
      apply: () => ({ nextDoc: manualDoc }),
    });
    if (manualCommit.status !== "committed") throw new Error(`manual update failed: ${manualCommit.status}`);
    state.doc = manualCommit.doc;
    state.legacySections = pmToLegacySections(manualCommit.doc) as unknown as LegacySection[];
    state.docVersion = manualCommit.docVersion;
    await invalidateDraftStateAfterCanonicalWrite(state);
    expect(state.docDraftBaseDoc).toBeNull();
    expect(state.docDraftCandidateDoc).toBeNull();
    await expect(documentDraftRepo.load(state.docId)).resolves.toBeNull();

    const selection = { axis: "column" as const, startIndex: 1, endIndex: 1 };
    const selectedTexts = pmTableSelectionCellTexts(state.doc, "table-a", selection);
    if (!selectedTexts) throw new Error("fixture selection missing");
    const chips = [{
      kind: { kind: "selection" },
      resourceRef: { id: "table-a", domain: { kind: "docSpan" } },
      prefix: null,
      label: selectedTexts.join("\n"),
      suffix: "表格·第2列",
      tableSelection: {
        ...selection,
        signature: tableSelectionTextSignature(selectedTexts),
      },
    } satisfies ChatChip];

    const args = {
      ops: [{ action: "replaceText" as const, find: "b1", replace: "AI 补丁", withinRef: "table-a" }],
    };
    agentStream.mockImplementationOnce(async (_messages: unknown, options: Record<string, unknown>) => {
      const toolsets = options.toolsets as {
        sessionScoped: {
          editDraft: {
            execute: (input: typeof args, context: Record<string, unknown>) => Promise<Record<string, unknown>>;
          };
        };
      };
      const editResult = await toolsets.sessionScoped.editDraft.execute(args, {});
      expect(editResult.ok).toBe(true);
      return {
        fullStream: streamOf(
          editDraftCall("ed-user-truth", args),
          editDraftResult("ed-user-truth", args, editResult),
        ),
        toolCalls: Promise.resolve([]),
      } as never;
    });

    const turnFrames = await collectFrames(
      runAgentTurn(state, "修改选中的第二列", [], chips),
    );
    expect(agentStream).toHaveBeenCalledTimes(1);
    expect(turnFrames.some((frame) => frame.kind === "docDiffReady")).toBe(true);
    await collectFrames(commitPatches(state, [...state.suggestions.keys()]));

    expect(tableTexts(state.doc)).toEqual([
      ["列A", "列B", "列C"],
      ["用户手改保留", "AI 补丁", "c1"],
    ]);
  });

  it("editDraft table incremental candidate enters pendingReview and can be rejected", async () => {
    const { createSession, commitPatches, processAgentStream, updatePatchVerdict } = await import("../bridge/index.js");
    const state = createSession("candidate-table-reject");
    const baseDoc = pmDoc([
      {
        type: "table",
        attrs: { blockId: "table-a" },
        content: [
          {
            type: "tableRow",
            content: [
              { type: "tableHeader", content: [paragraph("table-a-h1-p", "列A")] },
              { type: "tableHeader", content: [paragraph("table-a-h2-p", "列B")] },
            ],
          },
          {
            type: "tableRow",
            content: [
              { type: "tableCell", content: [paragraph("table-a-r1-c1-p", "a1，原样。")] },
              { type: "tableCell", content: [paragraph("table-a-r1-c2-p", "b1")] },
            ],
          },
        ],
      } as PmBlockNode,
    ]);
    const ops = [{
      action: "insertTableColumn",
      ref: "table-a",
      at: "end",
      cells: [
        { blocks: [{ type: "paragraph", runs: [{ text: "列C" }] }] },
        { blocks: [{ type: "paragraph", runs: [{ text: "c1" }] }] },
      ],
    }] as const;
    const applied = applyBlockEdits(baseDoc, ops);
    expect(applied.ok).toBe(true);
    const draftDoc = materializeDraftBlockIds(applied.doc!);
    state.doc = baseDoc;
    state.legacySections = pmToLegacySections(baseDoc) as unknown as LegacySection[];
    state.docVersion = 1;
    state.docState = { kind: "editing" };
    state.docDraftCandidateDoc = draftDoc;
    state.docDraftCandidateSections = pmToLegacySections(draftDoc) as unknown as LegacySection[];
    await seedDocument({ docId: state.docId, sessionId: state.sessionId, docVersion: 1, doc: baseDoc });

    const args = {
      ops: [{
        action: "insertTableColumn",
        ref: "table-a",
        at: "end",
        cells: "<th>列C</th><td>c1</td>",
      }],
    };
    await collectFrames(
      processAgentStream(
        streamOf(
          editDraftCall("ed-table-reject", args),
          editDraftResult("ed-table-reject", args, { ok: true, applied: ["table-a"], changed: true, hunkCount: 1 }),
        ),
        {
          state,
          agentMessageId: "agent-msg",
          streamId: "stream-table-reject",
          runId: "run-table-reject",
        },
      ),
    );
    expect(state.suggestions.size).toBe(1);
    const [id] = [...state.suggestions.keys()];
    expect(id).toBeTruthy();
    for await (const _frame of updatePatchVerdict(state, id!, "rejected")) {
      // consume generator
    }

    await collectFrames(commitPatches(state, [id!]));

    expect(tableTexts(state.doc)).toEqual([
      ["列A", "列B"],
      ["a1，原样。", "b1"],
    ]);
    await expect(documentDraftRepo.load(state.docId)).resolves.toBeNull();
  });

  it("R3-10 abort before settle discards completed draft candidate instead of entering pendingReview", async () => {
    const { createSession, processAgentStream } = await import("../bridge/index.js");
    const state = createSession("candidate-abort-before-settle");
    const baseDoc = legacySectionsToPm([p("旧版正文")] as never);
    const generatedDoc = legacySectionsToPm([p("停止后不应落地")] as never);
    state.doc = baseDoc;
    state.legacySections = pmToLegacySections(baseDoc) as unknown as LegacySection[];
    state.docVersion = 1;
    state.docState = { kind: "editing" };
    state.docDraftCandidateDoc = generatedDoc;
    state.docDraftCandidateSections = pmToLegacySections(generatedDoc) as unknown as LegacySection[];
    await seedDocument({ docId: state.docId, sessionId: state.sessionId, docVersion: 1, doc: baseDoc });

    const abortController = new AbortController();
    abortController.abort();
    const frames = await collectFrames(
      processAgentStream(
        streamOf(writeDraftCall("wd-aborted"), writeDraftResult("wd-aborted")),
        {
          state,
          agentMessageId: "agent-msg",
          streamId: "stream-aborted",
          runId: "run-aborted",
          abortController,
        },
      ),
    );

    expect(frames.some((frame) => frame.kind === "docDiffReady")).toBe(false);
    expect(frames.some((frame) => frame.kind === "documentSnapshotWritten")).toBe(false);
    expect(state.docState).toEqual({ kind: "editing" });
    expect(state.suggestions.size).toBe(0);
    expect(docText(state.doc)).toBe("旧版正文");
    await expect(documentDraftRepo.load(state.docId)).resolves.toBeNull();
  });

  it("commits markAdd hunks through applyDiffHunks so bold marks reach the canonical doc", async () => {
    const { createSession, commitPatches, processAgentStream } = await import("../bridge/index.js");
    const state = createSession("candidate-mark");
    const bold: PmMark = { type: "bold" };
    const baseDoc = pmDoc([
      paragraph("block-mark", [text("尖尖的顶子露在"), text("树"), text("梢上")]),
    ]);
    const draftDoc = pmDoc([
      paragraph("block-mark", [text("尖尖的顶子露在"), text("树", [bold]), text("梢上")]),
    ]);
    state.doc = baseDoc;
    state.legacySections = pmToLegacySections(baseDoc) as unknown as LegacySection[];
    state.docVersion = 1;
    state.docState = { kind: "editing" };
    state.docDraftCandidateDoc = draftDoc;
    state.docDraftCandidateSections = pmToLegacySections(draftDoc) as unknown as LegacySection[];
    await seedDocument({ docId: state.docId, sessionId: state.sessionId, docVersion: 1, doc: baseDoc });

    await collectFrames(
      processAgentStream(
        streamOf(writeDraftCall("wd-bold"), writeDraftResult("wd-bold")),
        {
          state,
          agentMessageId: "agent-msg",
          streamId: "stream-mark",
          runId: "run-mark",
        },
      ),
    );

    const suggestion = [...state.suggestions.values()][0];
    expect(suggestion?.diffHunk).toMatchObject({
      op: "markAdd",
      beforeText: "树",
      afterText: "树",
      marks: [bold],
    });

    await collectFrames(commitPatches(state, [...state.suggestions.keys()]));

    const block = state.doc?.content[0];
    expect(block?.type).toBe("paragraph");
    const markedNode = block && "content" in block ? block.content?.[1] : null;
    expect(markedNode).toMatchObject({ type: "text", text: "树", marks: [bold] });
  });

});
