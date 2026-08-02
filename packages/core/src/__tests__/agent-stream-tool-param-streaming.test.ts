import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BridgeFrame, ToolCallSpec } from "@qingagent/contract-ts";

const schedulePersistMock = vi.hoisted(() => vi.fn(
  async (_state: unknown, _reason?: string): Promise<void> => undefined,
));

// 桥层回归:AI SDK/Mastra fullStream 的工具参数流式 chunk 只提前渲染白名单工具占位卡,
// 整块 tool-call 到达后复用同一 toolCallId 更新,不能重复 append。

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

vi.mock("../session/threadPersistence.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../session/threadPersistence.js")>(),
  schedulePersist: schedulePersistMock,
}));

async function* streamOf(...chunks: unknown[]): AsyncGenerator<unknown> {
  for (const chunk of chunks) yield chunk;
}

async function collectFramesAndReturn<TReturn>(
  gen: AsyncGenerator<BridgeFrame, TReturn>,
): Promise<{ frames: BridgeFrame[]; result: TReturn }> {
  const frames: BridgeFrame[] = [];
  for (;;) {
    const next = await gen.next();
    if (next.done) return { frames, result: next.value };
    frames.push(next.value);
  }
}

function streamingStart(toolName: string, toolCallId: string) {
  return {
    type: "tool-call-input-streaming-start",
    payload: { toolName, toolCallId },
  };
}

function toolCall(toolName: string, toolCallId: string, args: Record<string, unknown>) {
  return {
    type: "tool-call",
    payload: { toolName, toolCallId, args },
  };
}

function transientErrorChunk(message: string) {
  return {
    type: "error",
    payload: { error: new Error(message) },
  };
}

function appendedToolCalls(frames: BridgeFrame[], toolCallId?: string): ToolCallSpec[] {
  return frames.flatMap((frame) => {
    if (frame.kind !== "chatMessageAppended") return [];
    const part = frame.data.part;
    if (part.kind !== "toolCall") return [];
    if (toolCallId && part.data.id !== toolCallId) return [];
    return [part.data];
  });
}

function updatedToolCalls(frames: BridgeFrame[], toolCallId: string): ToolCallSpec[] {
  return frames.flatMap((frame) => {
    if (frame.kind !== "toolCallUpdated") return [];
    if (frame.data.toolCallId !== toolCallId) return [];
    return [frame.data.spec];
  });
}

function chatHistoryToolCalls(state: { chatHistory: Array<{ parts: Array<{ kind: string; data: unknown }> }> }) {
  return state.chatHistory.flatMap((message) =>
    message.parts.flatMap((part) => (part.kind === "toolCall" ? [part.data as ToolCallSpec] : [])),
  );
}

describe("processAgentStream tool-call 参数流式占位", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("问卷参数生成占位在首帧可见前即耐久化，保证进程重启后有卡可终态化", async () => {
    const { createSession, processAgentStream } = await import("../bridge/index.js");
    const state = createSession("askuser-generating-persisted");
    let persistedToolCall: ToolCallSpec | null = null;
    schedulePersistMock.mockImplementationOnce(async (persistedState: unknown) => {
      persistedToolCall = structuredClone(
        chatHistoryToolCalls(persistedState as {
          chatHistory: Array<{ parts: Array<{ kind: string; data: unknown }> }>;
        }).find((spec) => spec.id === "ask-generating") ?? null,
      );
    });

    const stream = processAgentStream(
      streamOf(streamingStart("planDraft", "ask-generating")), {
        state,
        agentMessageId: "agent-ask-generating",
        streamId: "stream-ask-generating",
        runId: "run-ask-generating",
      },
    );
    const first = await stream.next();

    expect(schedulePersistMock).toHaveBeenCalledWith(
      state,
      "askUser:generating_placeholder",
    );
    expect(first).toMatchObject({
      done: false,
      value: {
        kind: "chatMessageAppended",
        data: { part: { kind: "toolCall", data: { id: "ask-generating" } } },
      },
    });
    expect(persistedToolCall).toMatchObject({
      id: "ask-generating",
      name: "planDraft",
      status: { kind: "running" },
      body: {
        kind: "askUser",
        data: { mode: { kind: "fullpage" }, questions: [] },
      },
    });
    for await (const _frame of stream) {
      // 关闭剩余流，首帧前的持久化断言已在上方完成。
    }
  });

  it("provider 不发 streaming-start 时完整问卷 tool-call 也在首帧前耐久化", async () => {
    const { createSession, processAgentStream } = await import("../bridge/index.js");
    const state = createSession("askuser-tool-call-persisted");
    const stream = processAgentStream(
      streamOf(toolCall("planDraft", "ask-tool-call", { purpose: "initialBrief" })),
      {
        state,
        agentMessageId: "agent-ask-tool-call",
        streamId: "stream-ask-tool-call",
        runId: "run-ask-tool-call",
      },
    );

    const first = await stream.next();

    expect(schedulePersistMock).toHaveBeenCalledWith(
      state,
      "askUser:generating_tool_call",
    );
    expect(first).toMatchObject({
      done: false,
      value: {
        kind: "chatMessageAppended",
        data: {
          part: {
            kind: "toolCall",
            data: {
              id: "ask-tool-call",
              name: "planDraft",
              status: { kind: "running" },
              body: { kind: "askUser" },
            },
          },
        },
      },
    });
    for await (const _frame of stream) {
      // 关闭剩余流，首帧前的持久化断言已在上方完成。
    }
  });

  it("白名单工具 streaming-start 会 append 一张 running generic 空参数占位卡", async () => {
    const { createSession, processAgentStream } = await import("../bridge/index.js");
    const state = createSession("param-stream-placeholder");

    const { frames, result } = await collectFramesAndReturn(
      processAgentStream(streamOf(streamingStart("writeDraft", "tc-stream-1")), {
        state,
        agentMessageId: "agent-msg",
        streamId: "stream-param-1",
        runId: "run-param-1",
      }),
    );

    const toolCalls = appendedToolCalls(frames, "tc-stream-1");
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0]).toMatchObject({
      id: "tc-stream-1",
      name: "writeDraft",
      render: { kind: "chatInline" },
      status: { kind: "running", data: { progressPct: null, etaSec: null } },
      body: { kind: "generic", data: { argsJson: "" } },
      result: null,
    });
    expect(result.producedVisibleFrame).toBe(true);
    expect(result.sawToolCall).toBe(false);
    expect(result.sawSideEffectToolCall).toBe(false);
  });

  it("覆盖所有工具:轻量工具 readDraft 的 streaming-start 同样产生占位卡", async () => {
    const { createSession, processAgentStream } = await import("../bridge/index.js");
    const state = createSession("param-stream-all-tools");

    const { frames, result } = await collectFramesAndReturn(
      processAgentStream(streamOf(streamingStart("readDraft", "tc-read-1")), {
        state,
        agentMessageId: "agent-msg",
        streamId: "stream-param-2",
        runId: "run-param-2",
      }),
    );

    const toolCalls = appendedToolCalls(frames, "tc-read-1");
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0]).toMatchObject({
      id: "tc-read-1",
      name: "readDraft",
      status: { kind: "running", data: { progressPct: null, etaSec: null } },
      body: { kind: "generic", data: { argsJson: "" } },
    });
    expect(result.producedVisibleFrame).toBe(true);
    expect(result.sawToolCall).toBe(false);
    expect(result.sawSideEffectToolCall).toBe(false);
  });

  it("占位后同 id 整块 tool-call 只更新原卡,不会重复 append", async () => {
    const { createSession, processAgentStream } = await import("../bridge/index.js");
    const state = createSession("param-stream-dedupe");

    const { frames, result } = await collectFramesAndReturn(
      processAgentStream(
        streamOf(
          streamingStart("writeDraft", "tc-write-1"),
          toolCall("writeDraft", "tc-write-1", { title: "完整标题", outline: "完整大纲" }),
        ),
        {
          state,
          agentMessageId: "agent-msg",
          streamId: "stream-param-3",
          runId: "run-param-3",
        },
      ),
    );

    expect(appendedToolCalls(frames, "tc-write-1")).toHaveLength(1);
    const updates = updatedToolCalls(frames, "tc-write-1");
    expect(updates).toHaveLength(1);
    const finalSpec = chatHistoryToolCalls(state).find((spec) => spec.id === "tc-write-1");
    expect(finalSpec?.name).toBe("writeDraft");
    expect(finalSpec?.status.kind).toBe("running");
    expect(finalSpec?.body.kind).toBe("generic");
    if (finalSpec?.body.kind === "generic") {
      expect(finalSpec.body.data.argsJson).toContain("完整标题");
      expect(finalSpec.body.data.argsJson).toContain("完整大纲");
    }
    expect(result.sawToolCall).toBe(true);
    expect(result.sawSideEffectToolCall).toBe(true);
  });

  it("tool-call-delta 是 no-op,不会标记工具调用或副作用工具调用", async () => {
    const { createSession, processAgentStream } = await import("../bridge/index.js");
    const state = createSession("param-stream-delta-noop");

    const { frames, result } = await collectFramesAndReturn(
      processAgentStream(
        streamOf(
          {
            type: "tool-call-delta",
            payload: {
              toolName: "writeDraft",
              toolCallId: "tc-delta-1",
              argsTextDelta: "{\"title\"",
            },
          },
          transientErrorChunk("other side closed"),
        ),
        {
          state,
          agentMessageId: "agent-msg",
          streamId: "stream-param-4",
          runId: "run-param-4",
        },
      ),
    );

    expect(frames).toHaveLength(0);
    expect(result.producedVisibleFrame).toBe(false);
    expect(result.sawToolCall).toBe(false);
    expect(result.sawSideEffectToolCall).toBe(false);
    expect(result.transientErrorChunk).toBeTruthy();
  });

  it("create_annotation_groups 参数闭合一组即发预览，终局 tool-call 清空", async () => {
    const { createSession, processAgentStream } = await import("../bridge/index.js");
    const { legacySectionsToPm } = await import("@qingagent/pm-schema");
    const state = createSession("annotation-preview-stream");
    state.doc = legacySectionsToPm([{ kind: "p", data: { text: "需要检查的原句" } }] as never);

    const { frames } = await collectFramesAndReturn(
      processAgentStream(streamOf(
        streamingStart("create_annotation_groups", "tc-annotation"),
        {
          type: "tool-call-delta",
          payload: {
            toolCallId: "tc-annotation",
            argsTextDelta: '{"groups":[{"summary":"事实核查","note":"稍后终局校验","origin":"source-check","anchors":[{"find":"需要检查的原句"}]}]}',
          },
        },
        toolCall("create_annotation_groups", "tc-annotation", {
          groups: [{ summary: "事实核查", note: "稍后终局校验", origin: "source-check", anchors: [{ find: "需要检查的原句" }] }],
        }),
      ), {
        state,
        agentMessageId: "agent-msg",
        streamId: "stream-annotation-preview",
        runId: "run-annotation-preview",
      }),
    );

    expect(frames).toContainEqual({
      kind: "annotationPreview",
      data: expect.objectContaining({
        previewId: "annotation-preview-tc-annotation-1",
        summary: "事实核查",
        anchors: [expect.objectContaining({ quote: "需要检查的原句" })],
      }),
    });
    const previewIndex = frames.findIndex((frame) => frame.kind === "annotationPreview");
    const clearIndex = frames.findIndex((frame) => frame.kind === "annotationPreviewCleared");
    expect(clearIndex).toBeGreaterThan(previewIndex);
  });

  it("隐私审查的参数流式预览不展示原始敏感值", async () => {
    const { createSession, processAgentStream } = await import("../bridge/index.js");
    const { legacySectionsToPm } = await import("@qingagent/pm-schema");
    const state = createSession("privacy-annotation-preview");
    state.doc = legacySectionsToPm([{ kind: "p", data: { text: "联系电话 13912345678" } }] as never);
    const requestContext = new Map<string, unknown>([[
      "reviewContext",
      { type: "privacy", templateName: "对外发布", prompt: "检查隐私" },
    ]]);
    const args = {
      groups: [{
        summary: "手机号 13912345678",
        note: "完整值不应显示",
        origin: "privacy",
        anchors: [{ find: "13912345678" }],
      }],
    };

    const { frames } = await collectFramesAndReturn(
      processAgentStream(streamOf(
        streamingStart("create_annotation_groups", "tc-privacy-annotation"),
        {
          type: "tool-call-delta",
          payload: {
            toolCallId: "tc-privacy-annotation",
            argsTextDelta: JSON.stringify(args),
          },
        },
        toolCall("create_annotation_groups", "tc-privacy-annotation", args),
      ), {
        state,
        agentMessageId: "agent-msg",
        streamId: "stream-privacy-annotation-preview",
        runId: "run-privacy-annotation-preview",
        requestContext: requestContext as never,
      }),
    );

    const visibleFrames = JSON.stringify(frames);
    expect(frames).toContainEqual({
      kind: "annotationPreview",
      data: expect.objectContaining({
        summary: "手机号 139****5678",
        anchors: [expect.objectContaining({
          quote: "139****5678",
          textHash: expect.stringMatching(/^span:/u),
        })],
      }),
    });
    expect(visibleFrames).not.toContain("13912345678");
  });
});
