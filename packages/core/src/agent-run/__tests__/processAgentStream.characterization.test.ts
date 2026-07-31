import {
  sanitizeVisibleText,
  type BridgeFrame,
  type MessagePart,
} from "@qingagent/contract-ts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSession } from "../../session/sessionState.js";

const recordUsageEventMock = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock("@qingagent/db", () => ({
  recordUsageEvent: recordUsageEventMock,
  STYLE_TEMPLATE_DTYPES: ["gzh", "xhs", "translate", "deai"] as const,
  documentDraftRepo: {
    clear: vi.fn(async () => undefined),
  },
  getConfirmGrant: vi.fn(async () => null),
  getConfirmGrantState: vi.fn(async (kind: "install" | "command") => ({
    kind,
    present: false,
    grantId: null,
    version: 0,
    revocationEpoch: 0,
    grant: null,
  })),
  appendConfirmAuditEvent: vi.fn(async () => undefined),
}));

vi.mock("../../mastra.js", () => ({
  mastra: {
    getLogger: () => ({
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
  },
  getObservability: () => null,
}));

async function* streamOf(...chunks: unknown[]): AsyncGenerator<unknown> {
  for (const chunk of chunks) yield chunk;
}

async function collectFramesAndReturn<TReturn>(
  generator: AsyncGenerator<BridgeFrame, TReturn>,
): Promise<{ frames: BridgeFrame[]; result: TReturn }> {
  const frames: BridgeFrame[] = [];
  for (;;) {
    const next = await generator.next();
    if (next.done) return { frames, result: next.value };
    frames.push(next.value);
  }
}

type ToolCallUpdatedFrame = Extract<BridgeFrame, { kind: "toolCallUpdated" }>;

function isToolCallPart(part: MessagePart): part is Extract<MessagePart, { kind: "toolCall" }> {
  return part.kind === "toolCall";
}

function isToolCallUpdatedFrame(frame: BridgeFrame): frame is ToolCallUpdatedFrame {
  return frame.kind === "toolCallUpdated";
}

function visibleTextBodies(frames: BridgeFrame[]): string[] {
  return frames.flatMap((frame) => {
    if (frame.kind === "chatMessageAppended" && frame.data.part.kind === "text") {
      return [frame.data.part.data.body];
    }
    if (
      frame.kind === "chatMessageAdded" &&
      frame.data.message.role.kind === "agent"
    ) {
      return frame.data.message.parts.flatMap((part) =>
        part.kind === "text" ? [part.data.body] : []
      );
    }
    return [];
  });
}

function addEmptyAgentMessage(
  state: ReturnType<typeof createSession>,
  messageId = "agent-message",
): void {
  state.chatHistory.push({
    id: messageId,
    role: { kind: "agent" },
    ts: "2026-01-01T00:00:00.000Z",
    parts: [],
    chips: null,
  });
}

function privacyReviewContext() {
  const values = new Map<string, unknown>([[
    "reviewContext",
    { type: "privacy", templateId: "review-privacy-default", templateName: "对外发布" },
  ]]);
  return {
    get: (key: string) => values.get(key),
    set: (key: string, value: unknown) => {
      values.set(key, value);
    },
  } as never;
}

function fetchArticleResult(index: number, overrides: Record<string, unknown> = {}) {
  return {
    ok: true,
    error: null,
    title: `文章 ${index}`,
    text: `第 ${index} 篇文章的完整正文，用于验证并行工具结果按各自 toolCallId 收口。`,
    wordCount: 31,
    images: [],
    screenshotSrc: null,
    ogImageUrl: null,
    sourceUrl: `https://example.com/article-${index}`,
    materialId: `mat-${index}`,
    via: "static",
    ...overrides,
  };
}

function parallelFetchChunks(results: unknown[]) {
  const toolCallIds = ["fetch-1", "fetch-2", "fetch-3"];
  return [
    { type: "step-start", payload: { request: { body: "{}" } } },
    ...toolCallIds.map((toolCallId, index) => ({
      type: "tool-call",
      payload: {
        toolName: "fetchArticle",
        toolCallId,
        args: { url: `https://example.com/article-${index + 1}` },
      },
    })),
    ...toolCallIds.map((toolCallId, index) => ({
      type: "tool-result",
      payload: {
        toolName: "fetchArticle",
        toolCallId,
        args: { url: `https://example.com/article-${index + 1}` },
        result: results[index],
      },
    })),
    { type: "text-delta", payload: { id: "text-1", text: "三个来源已处理。" } },
    {
      type: "step-finish",
      payload: {
        stepResult: { reason: "stop" },
        output: { usage: { inputTokens: 100, outputTokens: 10 } },
      },
    },
  ];
}

async function* annotationResultStream(
  state: ReturnType<typeof createSession>,
): AsyncGenerator<unknown> {
  state.annotationGroups = [
    {
      id: "annotation-1",
      summary: "问题一",
      note: "说明一",
      origin: "consistency",
      status: "reviewing",
      anchors: [{ blockId: "p", pmFrom: 1, pmTo: 3, quote: "甲组", textHash: "h1" }],
    },
    {
      id: "annotation-2",
      summary: "问题二",
      note: "说明二",
      origin: "consistency",
      status: "reviewing",
      anchors: [{ blockId: "p", pmFrom: 3, pmTo: 5, quote: "乙组", textHash: "h2" }],
    },
  ];
  state._annotationOriginsReplacedThisTurn?.add("consistency");
  yield { type: "text-delta", payload: { id: "text-1", text: "审查完成，已写入3处批注。" } };
}

describe("processAgentStream 行为特征", () => {
  beforeEach(() => {
    recordUsageEventMock.mockClear();
  });

  it("按原顺序追加 text/thinking 增量并共享单调 seq", async () => {
    const { processAgentStream } = await import("../processAgentStream.js");
    const state = createSession("characterize-text-reasoning");
    state.chatHistory.push({
      id: "agent-message",
      role: { kind: "agent" },
      ts: "2026-01-01T00:00:00.000Z",
      parts: [],
      chips: null,
    });

    const { frames, result } = await collectFramesAndReturn(
      processAgentStream(
        streamOf(
          { type: "text-delta", payload: { id: "text-1", text: "甲" } },
          { type: "reasoning-start", payload: { id: "reasoning-1" } },
          { type: "reasoning-delta", payload: { id: "reasoning-1", text: "思考" } },
          { type: "reasoning-end", payload: { id: "reasoning-1" } },
          { type: "text-delta", payload: { id: "text-1", text: "乙" } },
        ),
        {
          state,
          agentMessageId: "agent-message",
          streamId: "stream-text-reasoning",
          runId: "run-text-reasoning",
        },
      ),
    );

    expect(frames).toEqual([
      {
        kind: "chatMessageAppended",
        data: {
          messageId: "agent-message",
          seq: 1,
          part: { kind: "text", data: { body: "甲" } },
        },
      },
      {
        kind: "chatMessageAppended",
        data: {
          messageId: "agent-message",
          seq: 2,
          part: {
            kind: "thinking",
            data: { id: "reasoning-1", steps: ["思考"] },
          },
        },
      },
      {
        kind: "chatMessageAppended",
        data: {
          messageId: "agent-message",
          seq: 3,
          part: { kind: "text", data: { body: "乙" } },
        },
      },
    ]);
    expect(state.chatHistory[0]?.parts).toEqual(frames.map((frame) => {
      if (frame.kind !== "chatMessageAppended") throw new Error("unexpected frame");
      return frame.data.part;
    }));
    expect(state.messages).toEqual([{ role: "assistant", content: "甲乙" }]);
    expect(result).toMatchObject({
      producedVisibleFrame: true,
      sawToolCall: false,
      sawSideEffectToolCall: false,
      streamWasUserAborted: false,
    });
  });

  it("审查总结追加实际存活组数，不沿用模型自报计数", async () => {
    const { processAgentStream } = await import("../processAgentStream.js");
    const state = createSession("characterize-annotation-count");
    state.chatHistory.push({
      id: "agent-message",
      role: { kind: "agent" },
      ts: "2026-01-01T00:00:00.000Z",
      parts: [],
      chips: null,
    });

    const { frames } = await collectFramesAndReturn(
      processAgentStream(
        annotationResultStream(state),
        {
          state,
          agentMessageId: "agent-message",
          streamId: "stream-annotation-count",
          runId: "run-annotation-count",
        },
      ),
    );

    expect(frames).toContainEqual({
      kind: "annotationGroupsReady",
      data: {
        groups: state.annotationGroups,
        replacedOrigins: ["consistency"],
      },
    });
    expect(frames).toContainEqual({
      kind: "chatMessageAppended",
      data: {
        messageId: "agent-message",
        seq: 2,
        part: {
          kind: "text",
          data: { body: "\n\n批注落地结果：2处已定位。" },
        },
      },
    });
    expect(state.messages.at(-1)?.content)
      .toBe("审查完成，已写入3处批注。\n\n批注落地结果：2处已定位。");
  });

  it("隐私审查完成摘要跨 delta 整段打码后才展示和持久化", async () => {
    const { processAgentStream } = await import("../processAgentStream.js");
    const state = createSession("privacy-summary-masking");
    addEmptyAgentMessage(state);

    const { frames, result } = await collectFramesAndReturn(processAgentStream(
      streamOf(
        { type: "text-delta", payload: { id: "text", text: "手机号 13912" } },
        { type: "text-delta", payload: { id: "text", text: "345678，卡号 6222020200" } },
        { type: "text-delta", payload: { id: "text", text: "112345678，邮箱 zhangwei@example.com。" } },
      ),
      {
        state,
        agentMessageId: "agent-message",
        streamId: "privacy-summary-stream",
        runId: "privacy-summary-run",
        requestContext: privacyReviewContext(),
      },
    ));

    expect(visibleTextBodies(frames)).toEqual([
      "手机号 139****5678，卡号 6222***********5678，邮箱 zha***@example.com。",
    ]);
    expect(result.finalText).toBe("手机号 139****5678，卡号 6222***********5678，邮箱 zha***@example.com。");
    expect(state.messages.at(-1)?.content).toBe(result.finalText);
    expect(JSON.stringify({ frames, messages: state.messages, chatHistory: state.chatHistory }))
      .not.toContain("13912345678");
    expect(JSON.stringify({ frames, messages: state.messages, chatHistory: state.chatHistory }))
      .not.toContain("6222020200112345678");
    expect(JSON.stringify({ frames, messages: state.messages, chatHistory: state.chatHistory }))
      .not.toContain("zhangwei@example.com");
  });

  it("隐私批注工具参数写入卡片和模型 transcript 前先打码", async () => {
    const { processAgentStream } = await import("../processAgentStream.js");
    const state = createSession("privacy-tool-args-masking");
    const args = {
      groups: [{
        summary: "手机号 13912345678 未脱敏",
        note: "「13912345678」属于隐私泄露。",
        origin: "privacy",
        suggestion: "改为 139****5678",
        anchors: [{ find: "13912345678" }],
      }],
    };

    const { frames } = await collectFramesAndReturn(processAgentStream(
      streamOf(
        { type: "tool-call", payload: { toolName: "create_annotation_groups", toolCallId: "privacy-tool", args } },
        { type: "tool-result", payload: { toolName: "create_annotation_groups", toolCallId: "privacy-tool", args, result: { ok: true, groupCount: 1, anchorCount: 1, errors: [] } } },
        { type: "text-delta", payload: { id: "text", text: "已标记 13912345678。" } },
      ),
      {
        state,
        agentMessageId: "agent-message",
        streamId: "privacy-tool-stream",
        runId: "privacy-tool-run",
        requestContext: privacyReviewContext(),
      },
    ));

    const persistedProjection = JSON.stringify({
      frames,
      messages: state.messages,
      chatHistory: state.chatHistory,
    });
    expect(persistedProjection).toContain("139****5678");
    expect(persistedProjection).not.toContain("13912345678");
  });

  it("step-finish 只保留 span，不再重复写 provider usage 账本", async () => {
    const { processAgentStream } = await import("../processAgentStream.js");
    const state = createSession("characterize-step-usage");

    await collectFramesAndReturn(
      processAgentStream(
        streamOf(
          {
            type: "step-start",
            payload: { request: { body: "{}" } },
          },
          { type: "text-delta", payload: { id: "text-1", text: "完成" } },
          {
            type: "step-finish",
            payload: {
              stepResult: { reason: "stop" },
              output: { usage: { inputTokens: 120, outputTokens: 8 } },
              providerMetadata: {
                openai: { cachedPromptTokens: 90 },
              },
            },
          },
        ),
        {
          state,
          agentMessageId: "agent-message",
          streamId: "stream-step-usage",
          runId: "run-step-usage",
        },
      ),
    );

    expect(recordUsageEventMock).not.toHaveBeenCalled();
  });

  it("askUser 恢复流收到 null result 时仍原位收口问卷卡", async () => {
    const { processAgentStream } = await import("../processAgentStream.js");
    const state = createSession("characterize-null-questionnaire-result");
    state.chatHistory.push({
      id: "previous-agent-message",
      role: { kind: "agent" },
      ts: "2026-01-01T00:00:00.000Z",
      parts: [
        {
          kind: "toolCall",
          data: {
            id: "ask-1",
            name: "planDraft",
            render: { kind: "chatInline" },
            status: { kind: "running", data: { progressPct: null, etaSec: null } },
            body: { kind: "generic", data: { argsJson: "{}" } },
            result: null,
          },
        },
      ],
      chips: null,
    });

    const { frames, result } = await collectFramesAndReturn(
      processAgentStream(
        streamOf({
          type: "tool-result",
          payload: {
            toolName: "planDraft",
            toolCallId: "ask-1",
            args: {},
            result: null,
          },
        }),
        {
          state,
          agentMessageId: "resumed-agent-message",
          streamId: "stream-null-questionnaire-result",
          runId: "run-null-questionnaire-result",
        },
      ),
    );

    expect(frames).toEqual([
      {
        kind: "toolCallUpdated",
        data: {
          messageId: "previous-agent-message",
          toolCallId: "ask-1",
          spec: expect.objectContaining({
            id: "ask-1",
            name: "planDraft",
            status: { kind: "done" },
            result: { kind: "genericText", data: "已提交" },
          }),
        },
      },
    ]);
    expect(state.chatHistory[0]?.parts[0]).toMatchObject({
      kind: "toolCall",
      data: {
        id: "ask-1",
        status: { kind: "done" },
        result: { kind: "genericText", data: "已提交" },
      },
    });
    expect(result).toMatchObject({
      // 问卷卡更新能被独立可见性不变式识别，但不篡改既有的安全重试判据。
      producedVisibleFrame: false,
      sawToolCall: true,
      sawSideEffectToolCall: false,
      streamWasUserAborted: false,
    });
  });

  it("同一步三个同名并行工具按 toolCallId 分别收口并正常结束", async () => {
    const { processAgentStream } = await import("../processAgentStream.js");
    const state = createSession("characterize-parallel-tools");

    const { frames, result } = await collectFramesAndReturn(
      processAgentStream(
        streamOf(
          ...parallelFetchChunks([
            fetchArticleResult(1),
            fetchArticleResult(2),
            fetchArticleResult(3),
          ]),
        ),
        {
          state,
          agentMessageId: "agent-message",
          streamId: "stream-parallel-tools",
          runId: "run-parallel-tools",
        },
      ),
    );

    const toolParts = state.chatHistory
      .flatMap((message) => message.parts)
      .filter(isToolCallPart);
    expect(toolParts).toHaveLength(3);
    expect(toolParts.map((part) => part.data.id)).toEqual(["fetch-1", "fetch-2", "fetch-3"]);
    expect(toolParts.map((part) => part.data.status.kind)).toEqual(["done", "done", "done"]);
    expect(
      frames
        .filter(isToolCallUpdatedFrame)
        .filter((frame) => frame.data.spec.status.kind !== "running")
        .map((frame) => [frame.data.toolCallId, frame.data.spec.status.kind]),
    ).toEqual([
      ["fetch-1", "done"],
      ["fetch-2", "done"],
      ["fetch-3", "done"],
    ]);
    expect(state.messages.at(-1)).toEqual({ role: "assistant", content: "三个来源已处理。" });
    expect(result).toMatchObject({
      producedVisibleFrame: true,
      sawToolCall: true,
      sawSideEffectToolCall: true,
      streamWasUserAborted: false,
    });
  });

  it("三个同名并行工具中一个错误对象不会阻塞其余结果收口", async () => {
    const { processAgentStream } = await import("../processAgentStream.js");
    const state = createSession("characterize-parallel-tools-one-error");

    const { frames, result } = await collectFramesAndReturn(
      processAgentStream(
        streamOf(
          ...parallelFetchChunks([
            fetchArticleResult(1),
            fetchArticleResult(2, {
              ok: false,
              error: "Blocked loopback address",
              title: "抓取失败",
              text: "[Error] Blocked loopback address",
              wordCount: 0,
            }),
            fetchArticleResult(3),
          ]),
        ),
        {
          state,
          agentMessageId: "agent-message",
          streamId: "stream-parallel-tools-one-error",
          runId: "run-parallel-tools-one-error",
        },
      ),
    );

    const terminalById = new Map(
      state.chatHistory
        .flatMap((message) => message.parts)
        .filter(isToolCallPart)
        .map((part) => [part.data.id, part.data.status.kind]),
    );
    expect(terminalById).toEqual(new Map([
      ["fetch-1", "done"],
      ["fetch-2", "failed"],
      ["fetch-3", "done"],
    ]));
    const failedUpdate = frames
      .filter(isToolCallUpdatedFrame)
      .find(
        (frame) =>
          frame.data.toolCallId === "fetch-2" &&
          frame.data.spec.status.kind === "failed",
      );
    expect(failedUpdate?.data.spec.status).toEqual({
      kind: "failed",
      data: { retriable: false, reason: "Blocked loopback address" },
    });
    expect(state.messages.at(-1)).toEqual({ role: "assistant", content: "三个来源已处理。" });
    expect(result.streamWasUserAborted).toBe(false);
  });

  it.each([
    [
      "纯空白 text-delta",
      [{ type: "text-delta", payload: { id: "text-blank", text: " \n\t " } }],
    ],
    [
      "仅 tool heartbeat",
      [{
        type: "tool-output",
        payload: {
          toolCallId: "heartbeat-only",
          output: { type: "tool-heartbeat", data: { tool: "slow-tool" } },
        },
      }],
    ],
    [
      "仅 reasoning",
      [
        { type: "reasoning-start", payload: { id: "reasoning-only" } },
        {
          type: "reasoning-delta",
          payload: { id: "reasoning-only", text: "内部推理" },
        },
        { type: "reasoning-end", payload: { id: "reasoning-only" } },
      ],
    ],
    [
      "仅 response metadata",
      [{
        type: "response-metadata",
        payload: { id: "response-only", modelId: "test-model" },
      }],
    ],
  ])("%s 的零可见轮最终只补一条聊天提示", async (_label, chunks) => {
    const { processAgentStream } = await import("../processAgentStream.js");
    const state = createSession(`visibility-${_label}`);
    addEmptyAgentMessage(state);

    const { frames } = await collectFramesAndReturn(
      processAgentStream(
        streamOf(...chunks),
        {
          state,
          agentMessageId: "agent-message",
          streamId: `stream-${_label}`,
          runId: `run-${_label}`,
        },
      ),
    );

    const fallbackBodies = visibleTextBodies(frames).filter((body) =>
      body.includes("重试") || body.includes("换个说法")
    );
    expect(fallbackBodies).toHaveLength(1);
    const persistedText = state.chatHistory[0]?.parts.find(
      (part) => part.kind === "text",
    );
    expect(
      persistedText?.kind === "text" ? persistedText.data.body : "",
    ).toContain(fallbackBodies[0]);
  });

  it("拆成多个 delta 的内部文本按合并结果复算，并另起可见兜底消息", async () => {
    const { processAgentStream } = await import("../processAgentStream.js");
    const state = createSession("visibility-split-internal-text");
    addEmptyAgentMessage(state);
    const internalDeltas = [
      "[tool-",
      "result]\n",
      "toolName: editDraft\n",
      "toolCallId: call-1\n",
      'args: {"blockId":"block-a"}\n',
      'result: {"ok":true}',
    ];
    const mergedInternalText = internalDeltas.join("");

    expect(internalDeltas.every((delta) => sanitizeVisibleText(delta) !== null)).toBe(
      true,
    );
    expect(sanitizeVisibleText(mergedInternalText)).toBeNull();

    const { frames } = await collectFramesAndReturn(
      processAgentStream(
        streamOf(
          ...internalDeltas.map((text) => ({
            type: "text-delta",
            payload: { id: "split-internal", text },
          })),
        ),
        {
          state,
          agentMessageId: "agent-message",
          streamId: "stream-split-internal",
          runId: "run-split-internal",
        },
      ),
    );

    const rawMessage = state.chatHistory.find(
      (message) => message.id === "agent-message",
    );
    const fallbackMessages = state.chatHistory.filter(
      (message) =>
        message.id !== "agent-message" &&
        message.role.kind === "agent" &&
        message.parts.some(
          (part) =>
            part.kind === "text" &&
            part.data.body.includes("没有返回任何内容"),
        ),
    );
    expect(
      rawMessage?.parts.find((part) => part.kind === "text"),
    ).toEqual({
      kind: "text",
      data: { body: mergedInternalText },
    });
    expect(
      rawMessage?.parts.some(
        (part) =>
          part.kind === "text" &&
          sanitizeVisibleText(part.data.body) !== null,
      ),
    ).toBe(false);
    expect(fallbackMessages).toHaveLength(1);
    expect(
      fallbackMessages[0]?.parts.some(
        (part) =>
          part.kind === "text" &&
          sanitizeVisibleText(part.data.body) !== null,
      ),
    ).toBe(true);
    expect(
      frames.filter((frame) => frame.kind === "chatMessageAdded"),
    ).toHaveLength(1);
    expect(
      visibleTextBodies(frames).filter(
        (body) => sanitizeVisibleText(body)?.includes("重试"),
      ),
    ).toHaveLength(1);
    expect(state.messages.at(-1)?.content).toContain("没有返回任何内容");
    expect(state.messages.at(-1)?.content).not.toContain("[tool-result]");
  });

  it("askUser 挂起轮不追加零可见兜底", async () => {
    const { processAgentStream } = await import("../processAgentStream.js");
    const state = createSession("visibility-suspended");
    addEmptyAgentMessage(state);

    const { frames } = await collectFramesAndReturn(
      processAgentStream(
        streamOf({
          type: "tool-call-suspended",
          payload: {
            toolName: "askUser",
            toolCallId: "ask-visibility",
            args: { purpose: "quickClarification" },
            suspendPayload: {
              id: "ask-visibility",
              purpose: "quickClarification",
              source: null,
              rationale: null,
              questions: [{
                id: "q1",
                label: "需要补充什么？",
                kind: "text",
                options: [],
                placeholder: null,
              }],
            },
          },
        }),
        {
          state,
          agentMessageId: "agent-message",
          streamId: "stream-suspended",
          runId: "run-suspended",
        },
      ),
    );

    expect(visibleTextBodies(frames)).toEqual([]);
    expect(
      frames.some(
        (frame) =>
          frame.kind === "chatMessageAppended" &&
          frame.data.part.kind === "toolCall",
      ),
    ).toBe(true);
  });

  it("用户主动中止的零帧轮不追加兜底", async () => {
    const { processAgentStream } = await import("../processAgentStream.js");
    const state = createSession("visibility-user-abort");
    addEmptyAgentMessage(state);
    const abortController = new AbortController();
    abortController.abort("user_abort");

    const { frames, result } = await collectFramesAndReturn(
      processAgentStream(
        streamOf(),
        {
          state,
          agentMessageId: "agent-message",
          streamId: "stream-user-abort",
          runId: "run-user-abort",
          abortController,
        },
      ),
    );

    expect(visibleTextBodies(frames)).toEqual([]);
    expect(result.streamWasUserAborted).toBe(true);
  });

  it("正常文本与可渲染工具卡不会触发零可见兜底或重复提示", async () => {
    const { processAgentStream } = await import("../processAgentStream.js");

    const textState = createSession("visibility-normal-text");
    addEmptyAgentMessage(textState);
    const textRun = await collectFramesAndReturn(
      processAgentStream(
        streamOf(
          { type: "text-delta", payload: { id: "text", text: "答案" } },
          { type: "text-delta", payload: { id: "text", text: " " } },
          { type: "text-delta", payload: { id: "text", text: "完整" } },
        ),
        {
          state: textState,
          agentMessageId: "agent-message",
          streamId: "stream-normal-text",
          runId: "run-normal-text",
        },
      ),
    );
    expect(visibleTextBodies(textRun.frames).join("")).toBe("答案 完整");

    const cardState = createSession("visibility-normal-card");
    addEmptyAgentMessage(cardState);
    const cardRun = await collectFramesAndReturn(
      processAgentStream(
        streamOf(
          {
            type: "tool-call",
            payload: {
              toolName: "fetchArticle",
              toolCallId: "visible-card",
              args: { url: "https://example.com/visible" },
            },
          },
          {
            type: "tool-result",
            payload: {
              toolName: "fetchArticle",
              toolCallId: "visible-card",
              args: { url: "https://example.com/visible" },
              result: fetchArticleResult(1),
            },
          },
        ),
        {
          state: cardState,
          agentMessageId: "agent-message",
          streamId: "stream-normal-card",
          runId: "run-normal-card",
        },
      ),
    );

    expect(visibleTextBodies(cardRun.frames)).toEqual([]);
    expect(
      cardRun.frames.some(
        (frame) =>
          frame.kind === "chatMessageAppended" &&
          frame.data.part.kind === "toolCall",
      ),
    ).toBe(true);
  });
});
