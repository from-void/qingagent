import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BridgeFrame, ChatMessage, ToolCallSpec } from "@qingagent/contract-ts";
import type { Material } from "../types/material.js";

// 工具卡协议硬不变式:同一个 agent message 内,同一 toolCallId 只能有一个 toolCall part。
// 参数流占位、正式 tool-call、progress、tool-result/suspend 只能原位更新这张卡。

vi.mock("../mastra.js", () => ({
  mastra: {
    getLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
    getMemory: () => null,
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

type StreamChunk = Record<string, unknown>;
const STREAM_TEST_TIMEOUT = { timeout: 15_000 };

async function* streamOf(...chunks: StreamChunk[]): AsyncGenerator<StreamChunk> {
  for (const chunk of chunks) yield chunk;
}

async function collect(gen: AsyncGenerator<BridgeFrame>): Promise<BridgeFrame[]> {
  const frames: BridgeFrame[] = [];
  for await (const frame of gen) frames.push(frame);
  return frames;
}

function toolCallInputStart(toolCallId: string, toolName: string): StreamChunk {
  return {
    type: "tool-call-input-streaming-start",
    payload: { toolCallId, toolName },
  };
}

function readImageCall(toolCallId: string, args = readImageArgs()): StreamChunk {
  return {
    type: "tool-call",
    payload: { toolName: "readImage", toolCallId, args },
  };
}

function readImageProgress(toolCallId: string, excerpt: string): StreamChunk {
  return {
    type: "tool-output",
    payload: {
      toolCallId,
      output: {
        type: "readimage-progress",
        progress: { excerpt },
      },
    },
  };
}

function readImageResult(toolCallId: string, result: Record<string, unknown>, args = readImageArgs()): StreamChunk {
  return {
    type: "tool-result",
    payload: { toolName: "readImage", toolCallId, args, result },
  };
}

function askUserCall(toolCallId: string): StreamChunk {
  return {
    type: "tool-call",
    payload: { toolName: "askUser", toolCallId, args: { purpose: "initialBrief" } },
  };
}

function askUserSuspend(toolCallId: string): StreamChunk {
  return {
    type: "tool-call-suspended",
    payload: {
      toolName: "askUser",
      toolCallId,
      args: { purpose: "initialBrief" },
      suspendPayload: {
        id: `ask-${toolCallId}`,
        purpose: "initialBrief",
        source: null,
        rationale: "需要确认写作方向",
        questions: [
          {
            id: "q1",
            label: "写什么方向?",
            kind: "single",
            options: [{ value: "a", label: "方向 A", description: null, preview: null }],
            placeholder: null,
          },
        ],
      },
    },
  };
}

function askUserResult(toolCallId: string): StreamChunk {
  return {
    type: "tool-result",
    payload: {
      toolName: "askUser",
      toolCallId,
      args: {},
      result: {
        q1: { chosen: ["a"], freeText: null, numericValue: null },
      },
    },
  };
}

function readImageArgs(): Record<string, unknown> {
  return { image: "uploaded-image-id", prompt: "识别图片内容" };
}

function appendedToolCallFrames(frames: BridgeFrame[], toolCallId: string): BridgeFrame[] {
  return frames.filter(
    (frame) =>
      frame.kind === "chatMessageAppended" &&
      frame.data.part.kind === "toolCall" &&
      frame.data.part.data.id === toolCallId,
  );
}

function toolCallUpdatedSpecs(frames: BridgeFrame[], toolCallId: string): ToolCallSpec[] {
  return frames.flatMap((frame) => {
    if (frame.kind !== "toolCallUpdated" || frame.data.toolCallId !== toolCallId) return [];
    return [frame.data.spec];
  });
}

function toolCallParts(messages: ChatMessage[], toolCallId: string): ToolCallSpec[] {
  return messages.flatMap((message) =>
    message.parts.flatMap((part) =>
      part.kind === "toolCall" && part.data.id === toolCallId ? [part.data] : [],
    ),
  );
}

async function runChunks(chunks: StreamChunk[], sessionId: string) {
  const { createSession, processAgentStream } = await import("../bridge/index.js");
  const state = createSession(sessionId);
  const frames = await collect(
    processAgentStream(streamOf(...chunks), {
      state,
      agentMessageId: "agent-msg",
      streamId: `stream-${sessionId}`,
      runId: `run-${sessionId}`,
    }),
  );
  return { state, frames };
}

function imageMaterial(id: string): Material {
  return {
    id,
    filename: `${id}.png`,
    mimeType: "image/png",
    text: "图片素材正文",
    summary: null,
    fileId: `file-${id}`,
    metadata: { pages: null, wordCount: 6, title: null, parseState: "ready" },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

describe("toolCall part 去重", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("readImage 占位→执行→failed 终态只保留一张识别图片卡", STREAM_TEST_TIMEOUT, async () => {
    const toolCallId = "call_read_image_failed";
    const { state, frames } = await runChunks(
      [
        toolCallInputStart(toolCallId, "readImage"),
        readImageCall(toolCallId),
        readImageResult(toolCallId, {
          ok: false,
          error: "还未配置图像识别模型,请先配置视觉模型。",
        }),
      ],
      "read-image-failed-dedupe",
    );

    expect(appendedToolCallFrames(frames, toolCallId)).toHaveLength(1);
    const parts = toolCallParts(state.chatHistory, toolCallId);
    expect(parts).toHaveLength(1);
    expect(parts[0]?.name).toBe("readImage");
    expect(parts[0]?.body.kind).toBe("readImageCard");
    expect(parts[0]?.status.kind).toBe("failed");
    expect(parts[0]?.result).toEqual({
      kind: "genericText",
      data: "还未配置图像识别模型,请先配置视觉模型。",
    });
  });

  it("readImage done 终态只更新原卡,不追加第二个 toolCall part", STREAM_TEST_TIMEOUT, async () => {
    const toolCallId = "call_read_image_done";
    const { state, frames } = await runChunks(
      [
        toolCallInputStart(toolCallId, "readImage"),
        readImageCall(toolCallId),
        readImageResult(toolCallId, {
          ok: true,
          text: "图片里是一份手写提纲。",
        }),
      ],
      "read-image-done-dedupe",
    );

    expect(appendedToolCallFrames(frames, toolCallId)).toHaveLength(1);
    const parts = toolCallParts(state.chatHistory, toolCallId);
    expect(parts).toHaveLength(1);
    expect(parts[0]?.status.kind).toBe("done");
    expect(parts[0]?.result).toEqual({ kind: "genericText", data: "图片里是一份手写提纲。" });
  });

  it("readImage progress + result 更新只刷新同一张卡", STREAM_TEST_TIMEOUT, async () => {
    const toolCallId = "call_read_image_progress_result";
    const { state, frames } = await runChunks(
      [
        toolCallInputStart(toolCallId, "readImage"),
        readImageCall(toolCallId),
        readImageProgress(toolCallId, "正在识别图中文字"),
        readImageResult(toolCallId, {
          ok: true,
          text: "最终识别结果",
        }),
      ],
      "read-image-progress-result-dedupe",
    );

    expect(appendedToolCallFrames(frames, toolCallId)).toHaveLength(1);
    expect(toolCallParts(state.chatHistory, toolCallId)).toHaveLength(1);
    const updates = toolCallUpdatedSpecs(frames, toolCallId);
    expect(updates.some((spec) => spec.body.kind === "readImageCard" && spec.body.data.excerpt === "正在识别图中文字")).toBe(true);
    expect(updates.at(-1)?.status.kind).toBe("done");
    expect(updates.at(-1)?.result).toEqual({ kind: "genericText", data: "最终识别结果" });
  });

  it("readImage 成功识别素材后写回 visionSummary 并截断 500 字", STREAM_TEST_TIMEOUT, async () => {
    const { createSession, processAgentStream } = await import("../bridge/index.js");
    const state = createSession("read-image-material-writeback");
    state.materials.set("mat-image", imageMaterial("mat-image"));
    const longText = "识别结果".repeat(100);

    await collect(
      processAgentStream(
        streamOf(
          toolCallInputStart("call_read_image_material", "readImage"),
          readImageCall("call_read_image_material"),
          readImageResult("call_read_image_material", {
            ok: true,
            text: longText,
            materialId: "mat-image",
          }),
        ),
        {
          state,
          agentMessageId: "agent-msg",
          streamId: "stream-read-image-material-writeback",
          runId: "run-read-image-material-writeback",
        },
      ),
    );

    expect(state.materials.get("mat-image")?.visionSummary).toBe(longText.slice(0, 500));
  });

  it("readImage materialId 为空或素材不存在时不写回 visionSummary", STREAM_TEST_TIMEOUT, async () => {
    const { createSession, processAgentStream } = await import("../bridge/index.js");
    const state = createSession("read-image-material-noop");
    state.materials.set("mat-image", imageMaterial("mat-image"));

    await collect(
      processAgentStream(
        streamOf(
          toolCallInputStart("call_read_image_null_material", "readImage"),
          readImageCall("call_read_image_null_material"),
          readImageResult("call_read_image_null_material", {
            ok: true,
            text: "识别结果",
            materialId: null,
          }),
          toolCallInputStart("call_read_image_missing_material", "readImage"),
          readImageCall("call_read_image_missing_material"),
          readImageResult("call_read_image_missing_material", {
            ok: true,
            text: "识别结果",
            materialId: "missing-material",
          }),
        ),
        {
          state,
          agentMessageId: "agent-msg",
          streamId: "stream-read-image-material-noop",
          runId: "run-read-image-material-noop",
        },
      ),
    );

    expect(state.materials.get("mat-image")?.visionSummary).toBeUndefined();
  });

  it("askUser 占位→tool-call→suspend 仍只 append 一张问卷卡", STREAM_TEST_TIMEOUT, async () => {
    const toolCallId = "call_ask_suspend";
    const { state, frames } = await runChunks(
      [
        toolCallInputStart(toolCallId, "askUser"),
        askUserCall(toolCallId),
        askUserSuspend(toolCallId),
      ],
      "ask-user-suspend-dedupe",
    );

    expect(appendedToolCallFrames(frames, toolCallId)).toHaveLength(1);
    const parts = toolCallParts(state.chatHistory, toolCallId);
    expect(parts).toHaveLength(1);
    expect(parts[0]?.name).toBe("askUser");
    expect(parts[0]?.body.kind).toBe("askUser");
    expect(parts[0]?.status.kind).toBe("pending");
  });

  it("askUser resume 的 tool-result 只收口原问卷卡,不在新 agent message 追加同 id part", STREAM_TEST_TIMEOUT, async () => {
    const { createSession, processAgentStream } = await import("../bridge/index.js");
    const state = createSession("ask-user-resume-dedupe");
    const toolCallId = "call_ask_resume";

    const firstFrames = await collect(
      processAgentStream(
        streamOf(
          toolCallInputStart(toolCallId, "askUser"),
          askUserCall(toolCallId),
          askUserSuspend(toolCallId),
        ),
        {
          state,
          agentMessageId: "agent-msg",
          streamId: "stream-ask-user-resume-first",
          runId: "run-ask-user-resume-first",
        },
      ),
    );
    const resumeFrames = await collect(
      processAgentStream(streamOf(askUserResult(toolCallId)), {
        state,
        agentMessageId: "agent-msg-resume",
        streamId: "stream-ask-user-resume-second",
        runId: "run-ask-user-resume-second",
      }),
    );

    expect(appendedToolCallFrames(firstFrames, toolCallId)).toHaveLength(1);
    expect(appendedToolCallFrames(resumeFrames, toolCallId)).toHaveLength(0);
    const parts = toolCallParts(state.chatHistory, toolCallId);
    expect(parts).toHaveLength(1);
    expect(parts[0]?.status.kind).toBe("done");
    expect(parts[0]?.result?.kind).toBe("askUserAnswers");
  });
});
