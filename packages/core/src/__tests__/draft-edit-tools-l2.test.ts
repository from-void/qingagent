import { describe, expect, it, vi } from "vitest";
import { stepCountIs, streamText, tool } from "ai-v5";
import { z } from "zod";
import type { BridgeFrame } from "@qingagent/contract-ts";
import { pmToLegacySections, type PmDoc } from "@qingagent/pm-schema";

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

function pmDoc(text: string, blockId = "block-a"): PmDoc {
  return {
    type: "doc",
    attrs: { schemaVersion: 1 },
    content: [{
      type: "paragraph",
      attrs: { blockId },
      content: [{ type: "text", text }],
    }],
  };
}

function pmHeadingDoc(text: string, blockId = "title-block"): PmDoc {
  return {
    type: "doc",
    attrs: { schemaVersion: 1 },
    content: [{
      type: "heading",
      attrs: { blockId, level: 1 },
      content: [{ type: "text", text }],
    }],
  };
}

async function* streamOf(...chunks: any[]): AsyncGenerator<any> {
  for (const chunk of chunks) yield chunk;
}

async function collectFrames(gen: AsyncGenerator<BridgeFrame>): Promise<BridgeFrame[]> {
  const frames: BridgeFrame[] = [];
  for await (const frame of gen) frames.push(frame);
  return frames;
}

function streamParts(parts: unknown[]): ReadableStream<unknown> {
  return new ReadableStream({
    start(controller) {
      for (const part of parts) controller.enqueue(part);
      controller.close();
    },
  });
}

function fakeEditDraftLoopModel(observedPrompts: unknown[][]) {
  let step = 0;
  return {
    specificationVersion: "v2",
    provider: "qingagent-l2",
    modelId: "fake-editDraft-loop",
    supportedUrls: {},
    async doStream(options: { prompt: unknown[] }) {
      observedPrompts.push(options.prompt);
      step += 1;
      if (step === 1) {
        return {
          rawCall: { rawPrompt: options.prompt, rawSettings: {} },
          rawResponse: { headers: {} },
          stream: streamParts([
            {
              type: "tool-call",
              toolCallId: "edit-1",
              toolName: "editDraft",
              input: JSON.stringify({
                ops: [{ action: "replaceText", find: "旧文", replace: "新文" }],
              }),
            },
            {
              type: "finish",
              finishReason: "tool-calls",
              usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            },
          ]),
        };
      }

      const toolMessages = options.prompt.filter((message: any) => message?.role === "tool");
      const latestToolResult = toolMessages.at(-1) as any;
      const output = latestToolResult?.content?.[0]?.output;
      const result = output?.type === "json" ? output.value : output;
      const located = result?.ok === true && Array.isArray(result?.applied) && result.applied.includes("block-a");
      return {
        rawCall: { rawPrompt: options.prompt, rawSettings: {} },
        rawResponse: { headers: {} },
        stream: streamParts([
          { type: "text-start", id: "text-1" },
          { type: "text-delta", id: "text-1", delta: located ? "L2_EDITDRAFT_RESULT_VISIBLE" : "L2_EDITDRAFT_RESULT_MISSING" },
          { type: "text-end", id: "text-1" },
          {
            type: "finish",
            finishReason: "stop",
            usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          },
        ]),
      };
    },
  };
}

describe("draft edit tools L2 carrier", () => {
  it("streamText 多 step 会把 editDraft role:tool 结果喂给下一步模型", async () => {
    const observedPrompts: unknown[][] = [];
    const result = streamText({
      model: fakeEditDraftLoopModel(observedPrompts) as any,
      stopWhen: stepCountIs(2),
      tools: {
        editDraft: tool({
          description: "fake editDraft for carrier verification",
          inputSchema: z.object({
            ops: z.array(z.unknown()),
          }),
          execute: async () => ({
            ok: true,
            applied: ["block-a"],
            blockCount: 1,
          }),
        }),
      },
      prompt: "把旧文改成新文,然后根据工具结果继续定位。",
    });

    const chunks: any[] = [];
    for await (const chunk of result.fullStream as AsyncIterable<any>) {
      chunks.push(chunk);
      if (chunk.type === "error") {
        throw chunk.error instanceof Error ? chunk.error : new Error(String(chunk.error));
      }
    }
    const text = chunks
      .filter((chunk) => chunk.type === "text-delta")
      .map((chunk) => chunk.text)
      .join("");
    expect(text).toContain("L2_EDITDRAFT_RESULT_VISIBLE");
    expect(observedPrompts.length).toBeGreaterThanOrEqual(2);
    const toolMessages = observedPrompts[1]!.filter((message: any) => message?.role === "tool");
    expect(toolMessages.length).toBeGreaterThan(0);
    const output = (toolMessages.at(-1) as any)?.content?.[0]?.output;
    const resultPayload = output?.type === "json" ? output.value : output;
    expect(resultPayload).toMatchObject({ ok: true, applied: ["block-a"] });
  });

  it("editDraft tool-result ok 会触发 sawValidDraftMutation 并进入候选 diff review", async () => {
    const { createSession, processAgentStream } = await import("../bridge/index.js");
    const state = createSession("l2-editDraft");
    state.doc = pmDoc("旧文");
    state.legacySections = pmToLegacySections(state.doc) as any;
    state.docVersion = 3;
    state.docState = { kind: "editing" };
    state.docDraftBaseDoc = state.doc;
    state.docDraftBaseVersion = state.docVersion;
    state.docDraftBaseSections = state.legacySections;
    state.docDraftCandidateDoc = pmDoc("新文");
    state.docDraftCandidateSections = pmToLegacySections(state.docDraftCandidateDoc) as any;

    const frames = await collectFrames(processAgentStream(
      streamOf({
        type: "tool-result",
        payload: {
          toolName: "editDraft",
          toolCallId: "edit-1",
          args: {},
          result: { ok: true, applied: ["block-a"] },
        },
      }),
      {
        state,
        agentMessageId: "agent-msg",
        streamId: "stream-l2",
        runId: "run-l2",
      },
    ));

    expect(frames.some((frame) => frame.kind === "docDiffReady")).toBe(true);
    expect(state.docState).toEqual({ kind: "pendingReview" });
    expect(state.docDraftCandidateDoc?.content[0]?.attrs.blockId).toBe("block-a");
  });

  it("editDraft 完成帧使用紧凑结果摘要,保留 hunkCount 供前端显示改 N 处", async () => {
    const { createSession, processAgentStream } = await import("../bridge/index.js");
    const state = createSession("l2-editDraft-summary");
    state.doc = pmDoc("旧文");
    state.legacySections = pmToLegacySections(state.doc) as any;
    state.docVersion = 3;
    state.docState = { kind: "editing" };
    state.docDraftBaseDoc = state.doc;
    state.docDraftBaseVersion = state.docVersion;
    state.docDraftBaseSections = state.legacySections;
    state.docDraftCandidateDoc = pmDoc("新文");
    state.docDraftCandidateSections = pmToLegacySections(state.docDraftCandidateDoc) as any;

    const frames = await collectFrames(processAgentStream(
      streamOf({
        type: "tool-result",
        payload: {
          toolName: "editDraft",
          toolCallId: "edit-summary",
          args: { ops: [{ action: "replaceText", find: "旧文", replace: "新文" }] },
          result: {
            ok: true,
            applied: ["block-a", "block-b", "block-c", "block-d"],
            changed: true,
            hunkCount: 4,
            debugPayload: "x".repeat(1000),
          },
        },
      }),
      {
        state,
        agentMessageId: "agent-msg",
        streamId: "stream-l2-summary",
        runId: "run-l2-summary",
      },
    ));

    const doneSpec = frames
      .filter((frame) => frame.kind === "toolCallUpdated")
      .map((frame) => frame.kind === "toolCallUpdated" ? frame.data.spec : null)
      .find((spec) => spec?.name === "editDraft" && spec.status.kind === "done");
    expect(doneSpec?.result?.kind).toBe("genericText");
    if (doneSpec?.result?.kind !== "genericText") throw new Error("missing editDraft result summary");
    const summary = JSON.parse(doneSpec.result.data) as Record<string, unknown>;
    expect(summary).toMatchObject({
      ok: true,
      appliedCount: 4,
      changed: true,
      hunkCount: 4,
    });
    expect(doneSpec.result.data.length).toBeLessThan(200);
  });

  it("editDraft 修改标题会在 docDiffReady 透传 reviewBatch/groupMode/anchor/diffHunk", async () => {
    const { createSession, processAgentStream } = await import("../bridge/index.js");
    const state = createSession("l2-editDraft-title");
    state.doc = pmHeadingDoc("旧标题");
    state.legacySections = pmToLegacySections(state.doc) as any;
    state.docVersion = 5;
    state.docState = { kind: "editing" };
    state.docDraftBaseDoc = state.doc;
    state.docDraftBaseVersion = state.docVersion;
    state.docDraftBaseSections = state.legacySections;
    state.docDraftCandidateDoc = pmHeadingDoc("新标题");
    state.docDraftCandidateSections = pmToLegacySections(state.docDraftCandidateDoc) as any;

    const frames = await collectFrames(processAgentStream(
      streamOf({
        type: "tool-result",
        payload: {
          toolName: "editDraft",
          toolCallId: "edit-title",
          args: {},
          result: { ok: true, applied: ["title-block"] },
        },
      }),
      {
        state,
        agentMessageId: "agent-msg",
        streamId: "stream-l2-title",
        runId: "run-l2-title",
      },
    ));

    const diffFrame = frames.find((frame) => frame.kind === "docDiffReady");
    expect(diffFrame?.kind).toBe("docDiffReady");
    if (diffFrame?.kind !== "docDiffReady") throw new Error("missing docDiffReady");
    expect(diffFrame.data.baseVersion).toBe(5);
    expect(diffFrame.data.suggestions).toHaveLength(1);
    const suggestion = diffFrame.data.suggestions[0]!;
    expect(suggestion).toMatchObject({
      docId: state.docId,
      baseVersion: 5,
      status: "reviewing",
      reviewBatchId: suggestion.id,
      groupMode: "independent",
      anchor: {
        blockId: "title-block",
        quote: "旧",
      },
      preview: {
        deleteText: "旧",
        insertText: "新",
      },
    });
    expect(suggestion.diffHunk).toMatchObject({
      hunkId: suggestion.id,
      reviewBatchId: suggestion.reviewBatchId,
      groupMode: suggestion.groupMode,
      anchor: {
        blockId: "title-block",
        anchorKind: "range",
      },
    });
    expect(state.docState).toEqual({ kind: "pendingReview" });
  });
});
