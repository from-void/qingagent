import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DocGenerationEvent, LegacySection, BridgeFrame } from "@qingagent/contract-ts";
import type { PmDoc } from "@qingagent/pm-schema";
import { buildDocVersionAwarenessContent } from "../llm/docVersionAwarenessPrompt.js";

vi.mock("../mastra.js", () => ({
  mastra: {
    getLogger: () => ({
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
    getMemory: () => null,
  },
  getObservability: () => null,
}));

vi.mock("../agents/qingagent.js", () => ({
  getQingagentSkills: vi.fn(async () => ({
    maybeRefresh: vi.fn(async () => {}),
    has: vi.fn(async () => false),
  })),
  qingagentAgent: {
    stream: vi.fn(),
    resumeStream: vi.fn(),
  },
}));

type StreamChunk =
  | {
      type: "tool-call";
      payload: {
        toolName: "writeDraft";
        toolCallId: string;
        args: Record<string, unknown>;
      };
    }
  | {
      type: "tool-output";
      payload: {
        toolCallId: string;
        output: {
          type: "doc-generation-event";
          event: DocGenerationEvent;
        };
      };
    }
  | {
      type: "tool-result";
      payload: {
        toolName: "writeDraft";
        toolCallId: string;
        args: Record<string, unknown>;
        result:
          | {
              ok: true;
              blockCount: number;
              wordCount: number;
            }
          | {
              ok: false;
              error: string;
            };
      };
    };

async function* streamOf(...chunks: StreamChunk[]): AsyncGenerator<StreamChunk> {
  for (const chunk of chunks) yield chunk;
}

async function collectFramesWithReturn<T>(
  gen: AsyncGenerator<BridgeFrame, T>,
): Promise<{ frames: BridgeFrame[]; result: T }> {
  const frames: BridgeFrame[] = [];
  while (true) {
    const next = await gen.next();
    if (next.done) return { frames, result: next.value };
    frames.push(next.value);
  }
}

async function collectFrames(gen: AsyncGenerator<BridgeFrame>): Promise<BridgeFrame[]> {
  return (await collectFramesWithReturn(gen)).frames;
}

const legacySections: LegacySection[] = [
  { kind: "p", data: { text: "加粗正文" } },
];

const pmDoc: PmDoc = {
  type: "doc",
  attrs: { schemaVersion: 1 },
  content: [
    {
      type: "paragraph",
      attrs: { blockId: "block-1" },
      content: [
        {
          type: "text",
          text: "加粗正文",
          marks: [{ type: "bold" }],
        },
      ],
    },
  ],
};

const pmNode = pmDoc.content[0]!;

function writeDraftCall(): StreamChunk {
  return {
    type: "tool-call",
    payload: { toolName: "writeDraft", toolCallId: "wd-1", args: { title: "测试", outline: "大纲" } },
  };
}

function generationEvent(event: DocGenerationEvent): StreamChunk {
  return {
    type: "tool-output",
    payload: {
      toolCallId: "wd-1",
      output: { type: "doc-generation-event", event },
    },
  };
}

function writeDraftResult(): StreamChunk {
  return {
    type: "tool-result",
    payload: {
      toolName: "writeDraft",
      toolCallId: "wd-1",
      args: { title: "测试", outline: "大纲" },
      result: { ok: true, blockCount: 1, wordCount: 4 },
    },
  };
}

function writeDraftFailedResult(): StreamChunk {
  return {
    type: "tool-result",
    payload: {
      toolName: "writeDraft",
      toolCallId: "wd-1",
      args: { title: "测试", outline: "大纲" },
      result: { ok: false, error: "生成失败" },
    },
  };
}

function eventSequence(): DocGenerationEvent[] {
  return [
    {
      kind: "generation_started",
      data: { generationId: "g1", seq: 1, prevSeq: null, sessionId: "s", baseVersion: 0 },
    },
    {
      kind: "block_started",
      data: { generationId: "g1", seq: 2, prevSeq: 1, blockId: "block-1", index: 0, blockType: "paragraph" },
    },
    {
      kind: "inline_appended",
      data: {
        generationId: "g1",
        seq: 3,
        prevSeq: 2,
        blockId: "block-1",
        index: 0,
        appendOffset: 0,
        run: { text: "加粗正文", marks: [{ type: "bold" }] },
      },
    },
    {
      kind: "block_finished",
      data: {
        generationId: "g1",
        seq: 4,
        prevSeq: 3,
        blockId: "block-1",
        index: 0,
        block: { type: "paragraph", runs: [{ text: "加粗正文", marks: [{ type: "bold" }] }] },
        pmNode,
        hash: "pmv1-block",
      },
    },
  ];
}

function failedEvent(): DocGenerationEvent {
  return {
    kind: "generation_failed",
    data: { generationId: "g1", seq: 2, prevSeq: 1, reason: "生成失败" },
  };
}

describe("docGenerationEvent stream protocol", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("forwards block/run events and finishes with PM canonical instead of documentSnapshotWritten", async () => {
    const { createSession, processAgentStream } = await import("../bridge/index.js");
    const state = createSession("d1-events");
    state.docDraftCandidateDoc = pmDoc;
    state.docDraftCandidateSections = legacySections;

    const { frames, result } = await collectFramesWithReturn(
      processAgentStream(
        streamOf(
          writeDraftCall(),
          ...eventSequence().map(generationEvent),
          writeDraftResult(),
        ),
        {
          state,
          agentMessageId: "agent-msg",
          streamId: "stream-d1",
          runId: "run-d1",
        },
      ),
    );

    const events = frames.filter((frame) => frame.kind === "docGenerationEvent");
    expect(events.map((frame) => frame.kind === "docGenerationEvent" ? frame.data.kind : null)).toEqual([
      "generation_started",
      "block_started",
      "inline_appended",
      "block_finished",
      "candidate_snapshot",
      "generation_finished",
    ]);
    expect(frames.some((frame) => frame.kind === "documentSnapshotWritten")).toBe(false);
    const finished = events.at(-1);
    expect(finished?.kind).toBe("docGenerationEvent");
    if (finished?.kind !== "docGenerationEvent" || finished.data.kind !== "generation_finished") {
      throw new Error("expected generation_finished");
    }
    expect(finished.data.data.generationId).toBe("g1");
    expect(finished.data.data.prevSeq).toBe(5);
    expect(finished.data.data.finalVersion).toBe(1);
    expect(finished.data.data.doc.content[0]?.type).toBe("paragraph");
    const text = finished.data.data.doc.content[0]?.type === "paragraph"
      ? finished.data.data.doc.content[0].content?.[0]
      : null;
    expect(text?.type === "text" ? text.marks : []).toEqual([{ type: "bold" }]);
    expect(state.docVersion).toBe(1);
    expect(state.modelKnownDocVersion).toBe(1);
    expect(buildDocVersionAwarenessContent(state)).toBeNull();
    expect(state.doc?.content[0]).toEqual(pmNode);
    expect(result.finalDocument).toEqual({
      version: finished.data.data.finalVersion,
      contentHash: finished.data.data.contentHash,
      doc: finished.data.data.doc,
    });
  });

  it("does not duplicate generation_failed when the tool has already streamed it", async () => {
    const { createSession, processAgentStream } = await import("../bridge/index.js");
    const state = createSession("d1-events-failed");
    const started = eventSequence()[0]!;

    const frames = await collectFrames(
      processAgentStream(
        streamOf(
          writeDraftCall(),
          generationEvent(started),
          generationEvent(failedEvent()),
          writeDraftFailedResult(),
        ),
        {
          state,
          agentMessageId: "agent-msg",
          streamId: "stream-d1-failed",
          runId: "run-d1-failed",
        },
      ),
    );

    const failedEvents = frames.filter(
      (frame) => frame.kind === "docGenerationEvent" && frame.data.kind === "generation_failed",
    );
    expect(failedEvents).toHaveLength(1);
    const failedFrame = failedEvents[0];
    if (failedFrame?.kind !== "docGenerationEvent" || failedFrame.data.kind !== "generation_failed") {
      throw new Error("expected generation_failed");
    }
    expect(failedFrame.data.data.reason).toBe("生成失败");
  });
});
