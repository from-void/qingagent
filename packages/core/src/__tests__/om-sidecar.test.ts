import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BridgeFrame } from "@qingagent/contract-ts";
import type { CoreMessage } from "ai";
import { createSession } from "../session/sessionState.js";
import {
  buildOmCompressedProjection,
  buildOmMessageAssignments,
  makeOmMessageId,
  mergeObservedMessageIds,
  nextOmTurnIndex,
  pendingOmDbMessages,
  prepareOmContextForTurn,
} from "../session/omSidecar.js";
import { buildWorkingMemoryPromptMessage } from "../llm/workingMemoryPrompt.js";
import {
  buildOmObservationsContent,
  OM_OBSERVATIONS_MARKER,
  wrapModelWithOmObservations,
} from "../llm/omObservationsPrompt.js";
import {
  wrapModelWithTodoAwareness,
} from "../llm/todoAwarenessPrompt.js";
import { TODO_AWARENESS_MARKER } from "../agent-run/todoAwareness.js";

const mockState = vi.hoisted(() => ({
  agentStreamCalls: [] as Array<{
    messages: CoreMessage[];
    options: Record<string, unknown>;
  }>,
  prepareOmContextForTurnOverride: null as null | ((...args: unknown[]) => Promise<unknown>),
  scheduleOmSidecarAfterTurn: vi.fn(),
}));

async function* streamOfText(text: string): AsyncGenerator<unknown> {
  yield { type: "text-delta", payload: { text } };
}

async function collectFrames(
  gen: AsyncGenerator<BridgeFrame>,
): Promise<BridgeFrame[]> {
  const frames: BridgeFrame[] = [];
  for await (const frame of gen) frames.push(frame);
  return frames;
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map(contentText).join("");
  if (content && typeof content === "object" && "text" in content) {
    return String((content as { text?: unknown }).text ?? "");
  }
  return JSON.stringify(content);
}

function allText(messages: CoreMessage[]): string {
  return messages.map((message) => contentText(message.content)).join("\n");
}

function turnMessages(turnCount: number): CoreMessage[] {
  return Array.from({ length: turnCount }).flatMap((_, index) => [
    { role: "user" as const, content: `用户第${index + 1}轮 ${"长文本 ".repeat(60)}` },
    { role: "assistant" as const, content: `助手第${index + 1}轮 ${"回复 ".repeat(60)}` },
  ]);
}

vi.mock("../mastra.js", () => ({
  mastra: {
    getLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
    getMemory: () => null,
  },
  getMemory: () => null,
  getObservability: () => null,
}));

vi.mock("../agents/qingagent.js", () => ({
  getQingagentSkills: vi.fn(async () => ({
    maybeRefresh: vi.fn(async () => {}),
    has: vi.fn(async () => false),
  })),
  qingagentAgent: {
    stream: vi.fn(async (messages: CoreMessage[], options: Record<string, unknown>) => {
      mockState.agentStreamCalls.push({ messages, options });
      return {
        runId: `run-${mockState.agentStreamCalls.length}`,
        fullStream: streamOfText("收到。"),
      };
    }),
  },
}));

vi.mock("../session/omSidecar.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../session/omSidecar.js")>();
  return {
    ...actual,
    prepareOmContextForTurn: vi.fn((...args: unknown[]) => {
      if (mockState.prepareOmContextForTurnOverride) {
        return mockState.prepareOmContextForTurnOverride(...args);
      }
      return actual.prepareOmContextForTurn(...(args as Parameters<typeof actual.prepareOmContextForTurn>));
    }),
    scheduleOmSidecarAfterTurn: vi.fn((...args: unknown[]) => {
      mockState.scheduleOmSidecarAfterTurn(...args);
    }),
  };
});

vi.mock("../skills/enabledStore.js", () => ({
  readDisabledSet: vi.fn(async () => new Set<string>()),
}));

vi.mock("@qingagent/doc-render/browser", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@qingagent/doc-render/browser")>()),
  getAgentBrowserTools: () => ({}),
}));

vi.mock("../tools/runPython.js", () => ({
  getPyodideTools: () => ({}),
}));

describe("OM sidecar 稳定映射与投影", () => {
  const originalSidecar = process.env.QINGAGENT_OM_SIDECAR;
  const originalCompress = process.env.QINGAGENT_OM_COMPRESS;

  beforeEach(() => {
    mockState.agentStreamCalls.length = 0;
    mockState.prepareOmContextForTurnOverride = null;
    mockState.scheduleOmSidecarAfterTurn.mockClear();
    vi.clearAllMocks();
    delete process.env.QINGAGENT_OM_SIDECAR;
    delete process.env.QINGAGENT_OM_COMPRESS;
  });

  afterEach(() => {
    if (originalSidecar === undefined) delete process.env.QINGAGENT_OM_SIDECAR;
    else process.env.QINGAGENT_OM_SIDECAR = originalSidecar;
    if (originalCompress === undefined) delete process.env.QINGAGENT_OM_COMPRESS;
    else process.env.QINGAGENT_OM_COMPRESS = originalCompress;
  });

  it("把 CoreMessage 确定性映射为 MastraDBMessage，跳过 WM 内部上下文并续游标", () => {
    const wm = buildWorkingMemoryPromptMessage("# 用户长期记忆\n- 偏好: 简洁")!;
    const messages: CoreMessage[] = [
      wm,
      { role: "user", content: "第一轮" },
      { role: "assistant", content: "第一轮回复" },
      { role: "user", content: "第二轮" },
    ];
    const chatHistory = [
      { id: "u1", role: { kind: "user" as const }, ts: "2026-07-05T01:00:00.000Z", parts: [{ kind: "text" as const, data: { body: "第一轮" } }], chips: null },
      { id: "a1", role: { kind: "agent" as const }, ts: "2026-07-05T01:00:01.000Z", parts: [{ kind: "text" as const, data: { body: "第一轮回复" } }], chips: null },
      { id: "u2", role: { kind: "user" as const }, ts: "2026-07-05T01:00:02.000Z", parts: [{ kind: "text" as const, data: { body: "第二轮" } }], chips: null },
    ];

    const pending = pendingOmDbMessages({
      sessionId: "s",
      threadId: "thread-s",
      resourceId: "qingagent-user",
      messages,
      chatHistory,
      cursor: { turnIndex: 1, seqInTurn: 1 },
    });

    expect(pending.ids).toEqual(["s-1-2", "s-2-1"]);
    expect(pending.lastCursor).toEqual({ turnIndex: 2, seqInTurn: 1 });
    expect(pending.dbMessages.map((message) => message.id)).toEqual(["s-1-2", "s-2-1"]);
    expect(pending.dbMessages[0]).toMatchObject({
      role: "assistant",
      threadId: "thread-s",
      resourceId: "qingagent-user",
    });
    expect(pending.dbMessages[0]!.createdAt.toISOString()).toBe("2026-07-05T01:00:01.000Z");
    expect(JSON.stringify(pending.dbMessages)).not.toContain("长期记忆快照");
  });

  it("缺少 UI 可见消息时间时沿上一条时间单调递增，不回退到旧固定时间", () => {
    const assignments = buildOmMessageAssignments({
      sessionId: "s",
      messages: [
        { role: "user", content: "第一轮" },
        { role: "assistant", content: "工具过程 transcript" },
        { role: "assistant", content: "第一轮最终回复" },
      ],
      chatHistory: [
        { id: "u1", role: { kind: "user" as const }, ts: "2026-07-05T01:00:00.000Z", parts: [], chips: null },
        { id: "a1", role: { kind: "agent" as const }, ts: "2026-07-05T01:00:01.000Z", parts: [], chips: null },
      ],
    });

    expect(assignments.map((assignment) => assignment.createdAt.toISOString())).toEqual([
      "2026-07-05T01:00:00.000Z",
      "2026-07-05T01:00:01.000Z",
      "2026-07-05T01:00:01.001Z",
    ]);
  });

  it("当前回合映射使用冻结 turnCounter，不被上一轮额外 user 形态消息推高", () => {
    const messages: CoreMessage[] = [
      { role: "user", content: "第一轮" },
      { role: "assistant", content: "第一轮回复" },
      { role: "user", content: "问卷答案作为上一轮后续写入" },
      { role: "user", content: "第二轮" },
      { role: "assistant", content: "第二轮回复" },
    ];

    const pending = pendingOmDbMessages({
      sessionId: "s",
      threadId: "thread-s",
      resourceId: "qingagent-user",
      messages,
      cursor: { turnIndex: 1, seqInTurn: 2 },
      currentTurn: { turnIndex: 2, startMessageIndex: 3 },
    });

    expect(pending.ids).toEqual(["s-1-3", "s-2-1", "s-2-2"]);
    expect(pending.lastCursor).toEqual({ turnIndex: 2, seqInTurn: 2 });

    const projection = buildOmCompressedProjection({
      sessionId: "s",
      messages,
      observations: "- 第一轮含问卷答案，第二轮是最新真实回合",
      observedMessageIds: ["s-1-1", "s-1-2", "s-1-3"],
      thresholdTokens: 1,
      recentTurns: 1,
      latestTurnIndex: 2,
    });
    expect(projection.removedMessageIds).toEqual(["s-1-1", "s-1-2", "s-1-3"]);
    const text = allText(projection.messages);
    expect(text).not.toContain("问卷答案作为上一轮后续写入");
    expect(text).toContain("第二轮");
  });

  it("askUser 答案消息并入原轮次，不作为离线投影的新 turn 起点", () => {
    const messages: CoreMessage[] = [
      { role: "user", content: "第一轮" },
      { role: "assistant", content: "第一轮回复" },
      { role: "user", content: "[askUserAnswers:ask-1]\n- 方向:答案A" },
      { role: "user", content: "第二轮" },
      { role: "assistant", content: "第二轮回复" },
    ];

    const pending = pendingOmDbMessages({
      sessionId: "s",
      threadId: "thread-s",
      resourceId: "qingagent-user",
      messages,
      cursor: { turnIndex: 1, seqInTurn: 2 },
      currentTurn: { turnIndex: 2, startMessageIndex: 3 },
    });

    expect(pending.ids).toEqual(["s-1-3", "s-2-1", "s-2-2"]);

    const projection = buildOmCompressedProjection({
      sessionId: "s",
      messages,
      observations: "- 第一轮问卷答案已观察",
      observedMessageIds: ["s-1-1", "s-1-2", "s-1-3"],
      thresholdTokens: 1,
      recentTurns: 1,
      latestTurnIndex: 2,
    });

    expect(projection.removedMessageIds).toEqual(["s-1-1", "s-1-2", "s-1-3"]);
    const text = allText(projection.messages);
    expect(text).not.toContain("[askUserAnswers:ask-1]");
    expect(text).toContain("第二轮");
  });

  it("askUser resume 后再进入下一普通轮时，既有 OM ID 不漂移", () => {
    const messages: CoreMessage[] = [
      { role: "user", content: "第一轮" },
      { role: "assistant", content: "问卷" },
      { role: "user", content: "[askUserAnswers:ask-1]\n- 方向:答案A" },
      { role: "assistant", content: "第一轮收尾" },
      { role: "user", content: "第二轮" },
      { role: "assistant", content: "第二轮回复" },
    ];

    const resumeAssignments = buildOmMessageAssignments({
      sessionId: "s",
      messages: messages.slice(0, 4),
    });
    const laterAssignments = buildOmMessageAssignments({
      sessionId: "s",
      messages,
      currentTurn: { turnIndex: 2, startMessageIndex: 4 },
    });

    expect(resumeAssignments.map((assignment) => assignment.id)).toEqual([
      "s-1-1",
      "s-1-2",
      "s-1-3",
      "s-1-4",
    ]);
    expect(laterAssignments.slice(0, 4).map((assignment) => assignment.id)).toEqual(
      resumeAssignments.map((assignment) => assignment.id),
    );
    expect(laterAssignments.slice(4).map((assignment) => assignment.id)).toEqual([
      "s-2-1",
      "s-2-2",
    ]);
  });

  it("压缩投影只移除已观察旧消息，未观察旧消息和最近轮次原文永不丢", () => {
    const messages = turnMessages(4);
    const observed = [
      makeOmMessageId("s", 1, 1),
      makeOmMessageId("s", 1, 2),
      makeOmMessageId("s", 3, 1),
      makeOmMessageId("s", 3, 2),
      makeOmMessageId("s", 4, 1),
      makeOmMessageId("s", 4, 2),
    ];

    const projection = buildOmCompressedProjection({
      sessionId: "s",
      messages,
      observations: "- 用户早期讨论过 A\n- 用户第三轮确认了 C",
      observedMessageIds: observed,
      thresholdTokens: 1,
      recentTurns: 1,
    });

    expect(projection.compressed).toBe(true);
    expect(projection.removedMessageIds).toEqual([
      "s-1-1",
      "s-1-2",
      "s-3-1",
      "s-3-2",
    ]);
    const text = allText(projection.messages);
    expect(text).toContain(OM_OBSERVATIONS_MARKER);
    expect(text).not.toContain("用户第1轮");
    expect(text).not.toContain("助手第3轮");
    expect(text).toContain("用户第2轮");
    expect(text).toContain("助手第2轮");
    expect(text).toContain("用户第4轮");
    expect(text).toContain("助手第4轮");
    expect(messages).toHaveLength(8);
  });

  it("observedMessageIds 累计集合保持插入顺序并去重", () => {
    expect(mergeObservedMessageIds(
      ["s-1-1", "s-1-2"],
      ["s-1-2", "s-2-1"],
      null,
      ["", "s-2-2"],
    )).toEqual(["s-1-1", "s-1-2", "s-2-1", "s-2-2"]);
  });

  it("重新开启 OM 时 turnCounter 按真实历史和 cursor 自愈，避免 ID 回绕", () => {
    const state = createSession("om-turn-self-heal");
    state.turnCounter = 2;
    state.omSidecarCursor = { turnIndex: 3, seqInTurn: 2 };
    state.messages.push(
      { role: "user", content: "第一轮" },
      { role: "assistant", content: "第一轮回复" },
      { role: "user", content: "[askUserAnswers:ask-1]\n- 选择:继续" },
      { role: "user", content: "第二轮" },
      { role: "assistant", content: "第二轮回复" },
      { role: "user", content: "第三轮" },
      { role: "assistant", content: "第三轮回复" },
      { role: "user", content: "第四轮" },
    );

    expect(nextOmTurnIndex(state)).toBe(5);

    state.omSidecarCursor = { turnIndex: 8, seqInTurn: 1 };
    expect(nextOmTurnIndex(state)).toBe(9);
  });

  it("压缩投影头部使用完整观察日志，不套用尾注 2000 字裁剪", () => {
    const messages = turnMessages(3);
    const earlyFact = `早期事实-${"A".repeat(2200)}`;
    const latestFact = "最新观察";
    const projection = buildOmCompressedProjection({
      sessionId: "s",
      messages,
      observations: `- ${earlyFact}\n- ${latestFact}`,
      observedMessageIds: [
        makeOmMessageId("s", 1, 1),
        makeOmMessageId("s", 1, 2),
      ],
      thresholdTokens: 1,
      recentTurns: 1,
    });

    const text = allText(projection.messages);
    expect(projection.compressed).toBe(true);
    expect(text).toContain(earlyFact);
    expect(text).toContain(latestFact);
  });

  it("压缩 latch 是单向闸，记录暂不可用时也不恢复尾部长期观察注入", async () => {
    process.env.QINGAGENT_OM_SIDECAR = "1";
    process.env.QINGAGENT_OM_COMPRESS = "1";
    const state = createSession("om-compression-latch");
    state.omCompressionActive = true;
    state.messages.push(...turnMessages(2));

    const context = await prepareOmContextForTurn(state);

    expect(context.compressed).toBe(true);
    expect(context.messagesForModel).toBe(state.messages);
    expect(context.tailObservationPrompt).toBeNull();
    expect(state.omCompressionSnapshot).toEqual({
      epoch: 1,
      observations: "",
      removedMessageIds: [],
    });
    expect(state.omCompressionEpoch).toBe(1);

    const projection = buildOmCompressedProjection({
      sessionId: "s",
      messages: turnMessages(1),
      observations: "- 已进入长期观察态",
      observedMessageIds: [makeOmMessageId("s", 1, 1)],
      compressionAlreadyActive: true,
      thresholdTokens: Number.MAX_SAFE_INTEGER,
      recentTurns: 10,
    });
    expect(projection.compressed).toBe(true);
    expect(projection.removedMessageIds).toEqual([]);
  });

  it("todoAwareness 与长期观察 wrapper 固定按任务清单在前、长期观察在后追加", async () => {
    const seenPrompts: unknown[] = [];
    const baseModel = {
      async doGenerate(options: { prompt?: unknown }) {
        seenPrompts.push(options.prompt);
        return { content: [], finishReason: "stop", usage: {}, warnings: [] };
      },
      async doStream(options: { prompt?: unknown }) {
        seenPrompts.push(options.prompt);
        return {
          stream: new ReadableStream({
            start(controller) {
              controller.close();
            },
          }),
        };
      },
    };
    const wrapped = wrapModelWithTodoAwareness(
      wrapModelWithOmObservations(
        baseModel,
        `${OM_OBSERVATIONS_MARKER}\n- 用户长期偏好简洁。`,
      ),
      `${TODO_AWARENESS_MARKER} 当前清单:1.[待办]写测试。`,
    );

    await wrapped.doGenerate({ prompt: [{ role: "user", content: "继续" }] });

    const prompt = seenPrompts[0] as CoreMessage[];
    expect(prompt.at(-2)).toMatchObject({ role: "user" });
    expect(contentText(prompt.at(-2)!.content)).toContain(TODO_AWARENESS_MARKER);
    expect(prompt.at(-1)).toMatchObject({ role: "user" });
    expect(prompt.at(-1)!.content).toEqual([
      expect.objectContaining({ type: "text" }),
    ]);
    expect(contentText(prompt.at(-1)!.content)).toContain(OM_OBSERVATIONS_MARKER);
  });

  it("长期观察尾注按整条观察裁剪，不截断半条观察", () => {
    const longObservation = `- ${"很长的观察".repeat(50)}`;
    const content = buildOmObservationsContent(`- 旧观察\n${longObservation}`, 80)!;

    expect(content).toContain(longObservation);
    expect(content).not.toContain("- 旧观察");
  });

  it("两个 OM flag 显式关闭时不注入长期观察，模型输入仍使用原 state.messages 引用", async () => {
    process.env.QINGAGENT_OM_SIDECAR = "0";
    process.env.QINGAGENT_OM_COMPRESS = "0";
    const { runAgentTurn } = await import("../agent-run/runAgentTurn.js");
    const state = createSession("om-flags-off");

    await collectFrames(runAgentTurn(state, "你好"));

    expect(mockState.agentStreamCalls).toHaveLength(1);
    expect(mockState.agentStreamCalls[0]!.messages).toBe(state.messages);
    expect(allText(mockState.agentStreamCalls[0]!.messages)).not.toContain(OM_OBSERVATIONS_MARKER);
    expect(state.omSidecarCursor).toBeNull();
    expect(state.omCompressionActive).toBe(false);
    expect(state.turnCounter).toBe(0);
  });

  it("压缩态主 agent 不启用 Mastra memory，避免投影消息落入主 Memory", async () => {
    process.env.QINGAGENT_OM_SIDECAR = "1";
    process.env.QINGAGENT_OM_COMPRESS = "1";
    const { runAgentTurn } = await import("../agent-run/runAgentTurn.js");
    const state = createSession("om-compressed-no-main-memory");
    state.omCompressionActive = true;

    await collectFrames(runAgentTurn(state, "继续"));

    expect(mockState.agentStreamCalls).toHaveLength(1);
    expect(mockState.agentStreamCalls[0]!.options.memory).toBeUndefined();
    expect(
      (mockState.agentStreamCalls[0]!.options.requestContext as { get: (key: string) => unknown })
        .get("messages"),
    ).toBe(mockState.agentStreamCalls[0]!.messages);
    expect(state.turnCounter).toBe(1);
  });

  it("非压缩态 sidecar 不启用主 Memory，且工具上下文能看到长期观察", async () => {
    process.env.QINGAGENT_OM_SIDECAR = "1";
    const { runAgentTurn } = await import("../agent-run/runAgentTurn.js");
    const state = createSession("om-noncompressed-tool-observations");
    const tailObservationPrompt = `${OM_OBSERVATIONS_MARKER}\n- 用户偏好短句。`;
    mockState.prepareOmContextForTurnOverride = vi.fn(async () => ({
      messagesForModel: state.messages,
      tailObservationPrompt,
      compressed: false,
      fullTokenEstimate: 1000,
      projectedTokenEstimate: 1000,
      removedMessageIds: [],
      observations: "- 用户偏好短句。",
    }));

    await collectFrames(runAgentTurn(state, "继续"));

    expect(mockState.agentStreamCalls).toHaveLength(1);
    const call = mockState.agentStreamCalls[0]!;
    const requestContext = call.options.requestContext as { get: (key: string) => unknown };
    const toolMessages = requestContext.get("messages") as CoreMessage[];
    expect(call.options.memory).toBeUndefined();
    expect(call.messages).toBe(state.messages);
    expect(allText(call.messages)).not.toContain(OM_OBSERVATIONS_MARKER);
    expect(toolMessages).not.toBe(state.messages);
    expect(allText(toolMessages)).toContain(tailObservationPrompt);
    expect(state.turnCounter).toBe(1);
  });

  it("OM 上下文准备失败时 fail-open，不跳过主回合收尾清理", async () => {
    process.env.QINGAGENT_OM_SIDECAR = "1";
    mockState.prepareOmContextForTurnOverride = vi.fn(async () => {
      throw new Error("projection failed");
    });
    const { runAgentTurn } = await import("../agent-run/runAgentTurn.js");
    const state = createSession("om-prepare-fail-open");

    const frames = await collectFrames(runAgentTurn(state, "继续"));

    expect(mockState.agentStreamCalls).toHaveLength(1);
    expect(mockState.agentStreamCalls[0]!.messages).toBe(state.messages);
    expect(
      (mockState.agentStreamCalls[0]!.options.requestContext as { get: (key: string) => unknown })
        .get("messages"),
    ).toBe(state.messages);
    expect(frames.some((frame) => frame.kind === "stream" && frame.data.kind === "end")).toBe(true);
    expect(state.streamId).toBeNull();
    expect(state._activeTurnPromise).toBeNull();
    expect(state.turnCounter).toBe(1);
  });

  it("20 轮历史前缀在 OM 显式关闭时逐字节不变", async () => {
    process.env.QINGAGENT_OM_SIDECAR = "0";
    process.env.QINGAGENT_OM_COMPRESS = "0";
    const { runAgentTurn } = await import("../agent-run/runAgentTurn.js");
    const state = createSession("om-prefix-stable");
    state.messages.push(...turnMessages(20));
    const prefixBefore = JSON.stringify(state.messages);

    await collectFrames(runAgentTurn(state, "第二十一轮"));

    expect(JSON.stringify(state.messages.slice(0, 40))).toBe(prefixBefore);
    expect(state.turnCounter).toBe(0);
  });

  it("OM 与压缩缺省开启，默认阈值固定为 500k", async () => {
    const {
      isOmCompressionEnabled,
      isOmSidecarEnabled,
      omCompressionThresholdTokens,
    } = await import("../session/omSidecar.js");
    expect(isOmSidecarEnabled({})).toBe(true);
    expect(isOmCompressionEnabled({})).toBe(true);
    expect(omCompressionThresholdTokens({})).toBe(500_000);
  });

  it("同一压缩 epoch 的头部观察块字节稳定，后续消息只追加不重算", async () => {
    const state = createSession("om-frozen-epoch");
    state.messages.push(...turnMessages(3));
    state.turnCounter = 3;
    state.omCompressionActive = true;
    state.omCompressionEpoch = 1;
    state.omCompressionSnapshot = {
      epoch: 1,
      observations: "- 冻结观察块",
      removedMessageIds: [makeOmMessageId(state.sessionId, 1, 1), makeOmMessageId(state.sessionId, 1, 2)],
    };
    const first = await prepareOmContextForTurn(state);
    const firstHead = JSON.stringify(first.messagesForModel.slice(0, 2));
    state.messages.push({ role: "user", content: "第四轮" });
    state.turnCounter = 4;
    const second = await prepareOmContextForTurn(state);

    expect(JSON.stringify(second.messagesForModel.slice(0, 2))).toBe(firstHead);
    expect(allText(second.messagesForModel)).toContain("第四轮");
    expect(state.omCompressionEpoch).toBe(1);
  });
});
