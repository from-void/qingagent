import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BridgeFrame, ChatMessage, ToolCallSpec } from "@qingagent/contract-ts";
import { pmToLegacySections, type PmDoc } from "@qingagent/pm-schema";

const { logger, memory, threads } = vi.hoisted(() => {
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
  };
  return { logger, memory, threads };
});

vi.mock("../mastra.js", () => ({
  mastra: {
    getLogger: () => logger,
    getMemory: () => memory,
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

const ANSWERS = {
  "q-extra": { chosen: [], freeText: "保留一点个人经历" },
  "q-style": { chosen: ["guide"], freeText: null },
  "q-tone": { chosen: ["warm", "sharp"], freeText: "避免营销腔" },
};

function askUserSpec(id = "ask-answers"): ToolCallSpec {
  return {
    id,
    name: "askUser",
    render: { kind: "rightForm" },
    status: { kind: "running", data: { progressPct: null, etaSec: null } },
    body: {
      kind: "askUser",
      data: {
        id,
        mode: { kind: "fullpage" },
        purpose: { kind: "initialBrief" },
        source: null,
        rationale: null,
        questions: [
          {
            id: "q-style",
            label: "文章类型",
            kind: { kind: "single" },
            options: [
              { value: "memoir", label: "个人故事", description: null, preview: null },
              { value: "guide", label: "实用指南", description: null, preview: null },
            ],
            placeholder: null,
          },
          {
            id: "q-tone",
            label: "语气",
            kind: { kind: "multi" },
            options: [
              { value: "warm", label: "温暖", description: null, preview: null },
              { value: "sharp", label: "直接", description: null, preview: null },
            ],
            placeholder: null,
          },
          {
            id: "q-extra",
            label: "补充要求",
            kind: { kind: "text" },
            options: [],
            placeholder: null,
          },
        ],
      },
    },
    result: null,
  };
}

function directionChangeSpec(id = "ask-direction"): ToolCallSpec {
  const base = askUserSpec(id);
  const data = askUserData(base);
  return {
    ...base,
    body: {
      kind: "askUser",
      data: {
        ...data,
        id,
        purpose: { kind: "directionChange" },
      },
    },
  };
}

function askUserData(spec: ToolCallSpec) {
  if (spec.body.kind !== "askUser") throw new Error("expected askUser spec");
  return spec.body.data;
}

function agentMessageWithTool(spec: ToolCallSpec): ChatMessage {
  return {
    id: "msg-ask",
    role: { kind: "agent" },
    ts: "2026-01-01T00:00:00.000Z",
    parts: [{ kind: "toolCall", data: spec }],
    chips: null,
  };
}

async function* streamOf(...chunks: unknown[]): AsyncGenerator<unknown> {
  for (const chunk of chunks) yield chunk;
}

async function collectFrames(gen: AsyncGenerator<BridgeFrame>): Promise<BridgeFrame[]> {
  const frames: BridgeFrame[] = [];
  for await (const frame of gen) frames.push(frame);
  return frames;
}

function markerCount(messages: Array<{ content: unknown }>, toolCallId: string): number {
  const marker = `[askUserAnswers:${toolCallId}]`;
  return messages.filter((message) => (
    typeof message.content === "string" &&
    message.content.startsWith(marker)
  )).length;
}

function appendedAskUserToolCall(frames: BridgeFrame[], toolCallId: string): boolean {
  return frames.some((frame) =>
    frame.kind === "chatMessageAppended" &&
    frame.data.part.kind === "toolCall" &&
    frame.data.part.data.id === toolCallId &&
    frame.data.part.data.name === "askUser",
  );
}

function askUserToolCallMode(frames: BridgeFrame[], toolCallId: string): string | null {
  for (const frame of frames) {
    if (frame.kind !== "chatMessageAppended" || frame.data.part.kind !== "toolCall") continue;
    const spec = frame.data.part.data;
    if (spec.id !== toolCallId || spec.name !== "askUser" || spec.body.kind !== "askUser") continue;
    return spec.body.data.mode.kind;
  }
  return null;
}

function pmDoc(text: string, blockId = "block-a"): PmDoc {
  return {
    type: "doc",
    attrs: { schemaVersion: 1 },
    content: [{
      type: "paragraph",
      attrs: { blockId },
      content: text ? [{ type: "text", text }] : [],
    }],
  };
}

describe("askUser answer user message", () => {
  beforeEach(() => {
    threads.clear();
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it("按 spec 顺序构造确定性 user message", async () => {
    const { buildAskUserAnswerUserMessage } = await import("../agent-run/askUserAnswerMessage.js");
    const first = buildAskUserAnswerUserMessage({
      toolCallId: "ask-answers",
      spec: askUserSpec(),
      answers: ANSWERS,
    });
    const second = buildAskUserAnswerUserMessage({
      toolCallId: "ask-answers",
      spec: askUserSpec(),
      answers: ANSWERS,
    });

    expect(first).toEqual(second);
    expect(Buffer.from(String(first?.content)).equals(Buffer.from(String(second?.content)))).toBe(true);
    expect(first).toEqual({
      role: "user",
      content: [
        "[askUserAnswers:ask-answers]",
        "我已提交写作方向问卷,回答如下:",
        "- 文章类型:实用指南",
        "- 语气:温暖、直接;补充:避免营销腔",
        "- 补充要求:补充:保留一点个人经历",
        "请基于这些答案继续,不需要再次确认这些问题。",
      ].join("\n"),
    });
  });

  it("askUserQuestion 答卷使用通用问卷文案，不伪装成写作方向", async () => {
    const {
      buildAskUserAnswerUserMessage,
      buildVisibleAskUserAnswerMessage,
    } = await import("../agent-run/askUserAnswerMessage.js");
    const base = askUserSpec("direct-answer-copy");
    const directSpec: ToolCallSpec = {
      ...base,
      name: "askUserQuestion",
      body: {
        kind: "askUser",
        data: { ...askUserData(base), mode: { kind: "overlay" } },
      },
    };
    const answers = { "q-style": { chosen: ["guide"], freeText: null } };

    expect(buildAskUserAnswerUserMessage({
      toolCallId: directSpec.id,
      spec: directSpec,
      answers,
    })?.content).toContain("我已提交问卷,回答如下:");
    expect(buildAskUserAnswerUserMessage({
      toolCallId: directSpec.id,
      spec: directSpec,
      answers,
    })?.content).not.toContain("写作方向问卷");
    expect(buildVisibleAskUserAnswerMessage(directSpec.id, answers, directSpec)?.parts[0]).toMatchObject({
      kind: "askUserAnswerCard",
      data: { title: "已提交问卷" },
    });
  });

  it("e2e-loop-0704 R13 回归:enrichAskUserResumeAnswersWithLabels 把题面/选中项 label 回填进 resume 答案", async () => {
    const { enrichAskUserResumeAnswersWithLabels } = await import("../agent-run/askUserAnswerMessage.js");
    const enriched = enrichAskUserResumeAnswersWithLabels(ANSWERS, askUserSpec());

    // 选项 value("guide"/"warm")对模型不透明——必须回填题面 + 选中项 label,
    // 否则模型 resume 后读不懂答卷,会再弹一份同类问卷(R13 实锤形态)。
    expect(enriched["q-style"]).toEqual({
      chosen: ["guide"],
      freeText: null,
      questionLabel: "文章类型",
      chosenLabels: ["实用指南"],
    });
    expect(enriched["q-tone"]).toEqual({
      chosen: ["warm", "sharp"],
      freeText: "避免营销腔",
      questionLabel: "语气",
      chosenLabels: ["温暖", "直接"],
    });
    const directSpec = { ...askUserSpec("direct-enrich"), name: "askUserQuestion" };
    expect(enrichAskUserResumeAnswersWithLabels(ANSWERS, directSpec)["q-style"]).toEqual({
      chosen: ["guide"],
      freeText: null,
      questionLabel: "文章类型",
      chosenLabels: ["实用指南"],
    });
    // 纯文本题:无选项,只补题面 label,原字段原样保留。
    expect(enriched["q-extra"]).toEqual({
      chosen: [],
      freeText: "保留一点个人经历",
      questionLabel: "补充要求",
    });

    // spec 里找不到的题目 / 非对象答案:原样透传,不臆造。
    const passthrough = enrichAskUserResumeAnswersWithLabels(
      { "q-unknown": { chosen: ["x"], freeText: null }, "q-weird": "raw" },
      askUserSpec(),
    );
    expect(passthrough["q-unknown"]).toEqual({ chosen: ["x"], freeText: null });
    expect(passthrough["q-weird"]).toBe("raw");

    // 无 spec(冷恢复找不到原问卷):原对象原样返回。
    expect(enrichAskUserResumeAnswersWithLabels(ANSWERS, null)).toBe(ANSWERS);

    // spec 有选项但答案选了不存在的 value:label 回退为 value 本身,不丢答案。
    const fallback = enrichAskUserResumeAnswersWithLabels(
      { "q-style": { chosen: ["nonexistent"], freeText: null } },
      askUserSpec(),
    );
    expect(fallback["q-style"]).toEqual({
      chosen: ["nonexistent"],
      freeText: null,
      questionLabel: "文章类型",
      chosenLabels: ["nonexistent"],
    });
  });

  it("buildAskUserAnswerCardItems 统一处理未知题目、空答案、换行清洗、滑块边界和选项 label", async () => {
    const { buildAskUserAnswerCardItems } = await import("../agent-run/askUserAnswerMessage.js");
    const base = askUserSpec("ask-card-items");
    const baseData = askUserData(base);
    const spec: ToolCallSpec = {
      ...base,
      body: {
        kind: "askUser",
        data: {
          ...baseData,
          questions: [
            ...baseData.questions,
            {
              id: "q-length",
              label: "篇幅",
              kind: { kind: "slider" },
              options: [],
              placeholder: null,
              slider: { min: 1, max: 10, step: 1, unit: "字", marks: null, aboveLabel: "10字以上" },
            },
          ],
        },
      },
    };

    const items = buildAskUserAnswerCardItems(spec, {
      "q-style": { chosen: ["guide"], freeText: null },
      "q-tone": { chosen: ["warm"], freeText: "  避免营销腔\r\n保留一点锋芒  " },
      "q-extra": { chosen: [], freeText: "\r\n  只要正文  \r\n" },
      "q-length": { chosen: [], freeText: null, numericValue: 99 },
      "q-empty": { chosen: [], freeText: "\r\n" },
      "q-unknown": { chosen: ["raw-value"], freeText: "  自定义\r\n答案  " },
    });

    expect(items.map((item) => item.questionId)).toEqual([
      "q-style",
      "q-tone",
      "q-extra",
      "q-length",
      "q-unknown",
    ]);
    expect(items[0]).toMatchObject({
      questionLabel: "文章类型",
      answerText: "实用指南",
      selectedOptionLabels: ["实用指南"],
    });
    expect(items[1]).toMatchObject({
      answerText: "温暖；补充：避免营销腔\n保留一点锋芒",
      freeText: "避免营销腔\n保留一点锋芒",
    });
    expect(items[2]).toMatchObject({
      answerText: "只要正文",
      freeText: "只要正文",
    });
    expect(items[3]).toMatchObject({
      answerText: "10字以上",
      numericText: "10字以上",
    });
    expect(items[4]).toMatchObject({
      questionLabel: "q-unknown",
      answerText: "raw-value；补充：自定义\n答案",
      selectedOptionLabels: ["raw-value"],
    });
  });

  it("P2 回归:buildVisibleAskUserAnswerMessage fullpage 返回 null、overlay 仍出可见答卷卡", async () => {
    const { buildVisibleAskUserAnswerMessage } = await import(
      "../agent-run/askUserAnswerMessage.js"
    );
    const answers = { "q-style": { chosen: ["guide"], freeText: null } };

    // fullpage 开场问卷:工具调用 done 已有「已提交答案」汇总卡,不再补重复可见卡。
    const fullpageSpec = askUserSpec("ask-fullpage-visible");
    expect(fullpageSpec.body.kind).toBe("askUser");
    expect(
      buildVisibleAskUserAnswerMessage("ask-fullpage-visible", answers, fullpageSpec),
    ).toBeNull();

    // overlay 内联反问:没有汇总卡,可见答卷卡是答案唯一展示位,必须保留。
    const overlayBase = askUserSpec("ask-overlay-visible");
    const overlaySpec: ToolCallSpec = {
      ...overlayBase,
      body: {
        kind: "askUser",
        data: { ...askUserData(overlayBase), mode: { kind: "overlay" } },
      },
    };
    const overlayCard = buildVisibleAskUserAnswerMessage(
      "ask-overlay-visible",
      answers,
      overlaySpec,
    );
    expect(overlayCard?.parts[0]).toMatchObject({
      kind: "askUserAnswerCard",
      data: { toolCallId: "ask-overlay-visible" },
    });
  });

  it("内联问卷 spec 查找跳过同 id generic 占位,用真实 askUser spec 解析选项 label", async () => {
    const {
      buildVisibleAskUserAnswerMessage,
      findAskUserToolCallSpecInChatHistory,
    } = await import("../agent-run/askUserAnswerMessage.js");
    const placeholder: ToolCallSpec = {
      id: "ask-inline-placeholder",
      name: "askUser",
      render: { kind: "chatInline" },
      status: { kind: "running", data: { progressPct: null, etaSec: null } },
      body: { kind: "generic", data: { argsJson: "" } },
      result: null,
    };
    const base = askUserSpec("ask-inline-placeholder");
    const realSpec: ToolCallSpec = {
      ...base,
      body: {
        kind: "askUser",
        data: { ...askUserData(base), mode: { kind: "overlay" } },
      },
    };
    const chatHistory: ChatMessage[] = [
      {
        id: "msg-legacy-placeholder",
        role: { kind: "agent" },
        ts: "2026-01-01T00:00:00.000Z",
        parts: [
          {
            kind: "toolCall",
            data: {
              id: "ask-inline-placeholder",
              name: "askUser",
              render: { kind: "chatInline" },
              status: { kind: "running", data: { progressPct: null, etaSec: null } },
              result: null,
            } as unknown as ToolCallSpec,
          },
        ],
        chips: null,
      },
      {
        id: "msg-placeholder",
        role: { kind: "agent" },
        ts: "2026-01-01T00:00:00.000Z",
        parts: [{ kind: "toolCall", data: placeholder }],
        chips: null,
      },
      {
        id: "msg-real",
        role: { kind: "agent" },
        ts: "2026-01-01T00:00:01.000Z",
        parts: [{ kind: "toolCall", data: realSpec }],
        chips: null,
      },
    ];

    const found = findAskUserToolCallSpecInChatHistory(chatHistory, "ask-inline-placeholder");
    expect(found?.body.kind).toBe("askUser");

    const visible = buildVisibleAskUserAnswerMessage(
      "ask-inline-placeholder",
      { "q-style": { chosen: ["guide"], freeText: null } },
      found,
    );
    expect(visible?.parts[0]).toMatchObject({
      kind: "askUserAnswerCard",
      data: {
        items: [
          {
            questionId: "q-style",
            questionLabel: "文章类型",
            answerText: "实用指南",
            selectedOptionLabels: ["实用指南"],
          },
        ],
      },
    });
  });

  it("askUser tool-result backstop 会补建答案 message 且更新 chatHistory", async () => {
    const {
      createSession,
      drainSessionPersistence,
      processAgentStream,
    } = await import("../bridge/index.js");
    const state = createSession("ask-answer-backstop");
    state.chatHistory = [agentMessageWithTool(askUserSpec())];

    const frames = await collectFrames(
      processAgentStream(
        streamOf({
          type: "tool-result",
          payload: {
            toolName: "askUser",
            toolCallId: "ask-answers",
            args: {},
            result: ANSWERS,
          },
        }),
        {
          state,
          agentMessageId: "msg-resume",
          streamId: "stream-resume",
          runId: "run-resume",
        },
      ),
    );
    await drainSessionPersistence();

    const answerMessage = state.messages.find((message) =>
      typeof message.content === "string" &&
      message.content.startsWith("[askUserAnswers:ask-answers]")
    );
    expect(markerCount(state.messages, "ask-answers")).toBe(1);
    expect(String(answerMessage?.content)).toContain("- 文章类型:实用指南");
    expect(
      frames.some((frame) =>
        frame.kind === "toolCallUpdated" &&
        frame.data.toolCallId === "ask-answers" &&
        frame.data.spec.result?.kind === "askUserAnswers"
      ),
    ).toBe(true);
    const part = state.chatHistory[0]?.parts[0];
    expect(part?.kind).toBe("toolCall");
    if (part?.kind === "toolCall") {
      expect(part.data.result?.kind).toBe("askUserAnswers");
    }
    expect(state._askUserCompleted).toBe(true);
    expect(memory.updateThread).toHaveBeenCalled();
  }, 10_000);

  it("空 askUser tool-result 不标 completed 且不阻止后续 askUser", async () => {
    const {
      createSession,
      drainSessionPersistence,
      processAgentStream,
    } = await import("../bridge/index.js");
    const state = createSession("ask-answer-empty-submit");
    state._askUserAsked = true;
    state.chatHistory = [agentMessageWithTool(askUserSpec("ask-empty"))];

    const frames = await collectFrames(
      processAgentStream(
        streamOf({
          type: "tool-result",
          payload: {
            toolName: "askUser",
            toolCallId: "ask-empty",
            args: {},
            result: {
              "q-style": { chosen: [], freeText: "   ", numericValue: null },
              "q-extra": { chosen: [], freeText: null, numericValue: null },
            },
          },
        }),
        {
          state,
          agentMessageId: "msg-empty-resume",
          streamId: "stream-empty-resume",
          runId: "run-empty-resume",
        },
      ),
    );
    await drainSessionPersistence();

    expect(state._askUserCompleted).not.toBe(true);
    expect(markerCount(state.messages, "ask-empty")).toBe(0);
    expect(
      frames.some((frame) =>
        frame.kind === "toolCallUpdated" &&
        frame.data.toolCallId === "ask-empty" &&
        frame.data.spec.result?.kind === "askUserAnswers"
      ),
    ).toBe(false);

    const nextFrames = await collectFrames(
      processAgentStream(
        streamOf({
          type: "tool-call",
          payload: {
            toolName: "askUser",
            toolCallId: "ask-next",
            args: { purpose: "quickClarification" },
          },
        }),
        {
          state,
          agentMessageId: "msg-next",
          streamId: "stream-next",
          runId: "run-next",
        },
      ),
    );
    await drainSessionPersistence();

    expect(appendedAskUserToolCall(nextFrames, "ask-next")).toBe(true);
  });

  it("主落点已写 marker 时 backstop 不重复追加", async () => {
    const {
      appendAskUserAnswerMessageIfMissing,
      createSession,
      processAgentStream,
    } = await import("../bridge/index.js");
    const state = createSession("ask-answer-idempotent");
    const spec = askUserSpec();
    state.chatHistory = [agentMessageWithTool(spec)];
    expect(appendAskUserAnswerMessageIfMissing(state, spec.id, ANSWERS, spec)).toBe(true);

    await collectFrames(
      processAgentStream(
        streamOf({
          type: "tool-result",
          payload: {
            toolName: "askUser",
            toolCallId: spec.id,
            args: {},
            result: ANSWERS,
          },
        }),
        {
          state,
          agentMessageId: "msg-resume",
          streamId: "stream-resume",
          runId: "run-resume",
        },
      ),
    );

    expect(markerCount(state.messages, spec.id)).toBe(1);
    const part = state.chatHistory[0]?.parts[0];
    expect(part?.kind).toBe("toolCall");
    if (part?.kind === "toolCall") {
      expect(part.data.result?.kind).toBe("askUserAnswers");
    }
  });

  it("askUser renderMode helper 原样沿用 spec mode", async () => {
    const { askUserRenderModeFromSpec } = await import("../agent-run/toolCards.js");
    expect(askUserRenderModeFromSpec(askUserSpec("ask-mode-full"))).toBe("fullpage");
    const base = askUserSpec("ask-mode-overlay");
    const overlaySpec: ToolCallSpec = {
      ...base,
      body: {
        kind: "askUser",
        data: {
          ...askUserData(base),
          mode: { kind: "overlay" },
        },
      },
    };
    expect(askUserRenderModeFromSpec(overlaySpec)).toBe("overlay");
  });

  it("首次 directionChange 在已有文档会继续弹全屏问卷", async () => {
    const { createSession, drainSessionPersistence, processAgentStream } = await import("../bridge/index.js");
    const state = createSession("ask-direction-first");
    state.docState = { kind: "editing" };
    state.doc = pmDoc("已有正文");
    state.legacySections = pmToLegacySections(state.doc) as never;
    state._askUserCompleted = true;

    const frames = await collectFrames(
      processAgentStream(
        streamOf({
          type: "tool-call",
          payload: {
            toolName: "askUser",
            toolCallId: "ask-dir-1",
            args: { purpose: "directionChange" },
          },
        }),
        {
          state,
          agentMessageId: "msg-dir-1",
          streamId: "stream-dir-1",
          runId: "run-dir-1",
        },
      ),
    );
    await drainSessionPersistence();

    expect(askUserToolCallMode(frames, "ask-dir-1")).toBe("fullpage");
  });

  it("directionChange 答完未写入时,下一次 directionChange 按已完成问卷抑制", async () => {
    const { createSession, drainSessionPersistence, processAgentStream } = await import("../bridge/index.js");
    const state = createSession("ask-direction-repeat");
    state.docState = { kind: "editing" };
    state.doc = pmDoc("已有正文");
    state.legacySections = pmToLegacySections(state.doc) as never;
    state.chatHistory = [agentMessageWithTool(directionChangeSpec("ask-dir-done"))];

    await collectFrames(
      processAgentStream(
        streamOf({
          type: "tool-result",
          payload: {
            toolName: "askUser",
            toolCallId: "ask-dir-done",
            args: {},
            result: ANSWERS,
          },
        }),
        {
          state,
          agentMessageId: "msg-dir-done",
          streamId: "stream-dir-done",
          runId: "run-dir-done",
        },
      ),
    );

    const frames = await collectFrames(
      processAgentStream(
        streamOf({
          type: "tool-call",
          payload: {
            toolName: "askUser",
            toolCallId: "ask-dir-repeat",
            args: { purpose: "directionChange" },
          },
        }),
        {
          state,
          agentMessageId: "msg-dir-repeat",
          streamId: "stream-dir-repeat",
          runId: "run-dir-repeat",
        },
      ),
    );
    await drainSessionPersistence();

    expect(state._directionChangeAskedSinceLastWrite).toBe(true);
    expect(appendedAskUserToolCall(frames, "ask-dir-repeat")).toBe(false);
  });

  it("directionChange 答完后有有效草稿写入,下一次 directionChange 仍可弹", async () => {
    const { createSession, drainSessionPersistence, processAgentStream } = await import("../bridge/index.js");
    const state = createSession("ask-direction-after-write");
    state.docState = { kind: "editing" };
    state.doc = pmDoc("旧文");
    state.legacySections = pmToLegacySections(state.doc) as never;
    state.docVersion = 3;
    state._askUserCompleted = true;
    state._directionChangeAskedSinceLastWrite = true;
    state.docDraftBaseDoc = state.doc;
    state.docDraftBaseVersion = state.docVersion;
    state.docDraftBaseSections = state.legacySections;
    state.docDraftCandidateDoc = pmDoc("新文");
    state.docDraftCandidateSections = pmToLegacySections(state.docDraftCandidateDoc) as never;

    await collectFrames(
      processAgentStream(
        streamOf({
          type: "tool-result",
          payload: {
            toolName: "editDraft",
            toolCallId: "edit-after-dir",
            args: {},
            result: { ok: true, applied: ["block-a"], changed: true, hunkCount: 1 },
          },
        }),
        {
          state,
          agentMessageId: "msg-edit-after-dir",
          streamId: "stream-edit-after-dir",
          runId: "run-edit-after-dir",
        },
      ),
    );

    const frames = await collectFrames(
      processAgentStream(
        streamOf({
          type: "tool-call",
          payload: {
            toolName: "askUser",
            toolCallId: "ask-dir-after-write",
            args: { purpose: "directionChange" },
          },
        }),
        {
          state,
          agentMessageId: "msg-dir-after-write",
          streamId: "stream-dir-after-write",
          runId: "run-dir-after-write",
        },
      ),
    );
    await drainSessionPersistence();

    expect(state._directionChangeAskedSinceLastWrite).toBe(false);
    expect(appendedAskUserToolCall(frames, "ask-dir-after-write")).toBe(true);
  });
});
