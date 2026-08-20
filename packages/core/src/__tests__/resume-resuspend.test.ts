import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AskUserQuestion, BridgeFrame, ToolCallSpec } from "@qingagent/contract-ts";
import { pmDocFromText } from "./pmTestUtils.js";
import { RequestContext } from "@mastra/core/request-context";

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
}));

vi.mock("../agents/qingagent.js", () => ({
  getQingagentSkills: vi.fn(async () => ({
    maybeRefresh: vi.fn(async () => {}),
    has: vi.fn(async () => false),
  })),
  qingagentAgent: {
    stream: vi.fn(),
  },
}));

type StreamChunk =
  | {
      type: "tool-call-input-streaming-start";
      payload: {
        toolName: "askUser" | "planDraft" | "askUserQuestion";
        toolCallId: string;
      };
    }
  | {
      type: "tool-output";
      payload: {
        toolCallId: string;
        output: { type: "askuser-progress"; questions: ReturnType<typeof oneQuestion> };
      };
    }
  | {
      type: "tool-call-suspended";
      payload: {
        toolName: "askUser" | "planDraft" | "askUserQuestion";
        toolCallId: string;
        suspendPayload: {
          id: string;
          mode: "fullpage";
          source: null;
          rationale: null;
          questions: Array<{
            id: string;
            label: string;
            kind: "single" | "multi" | "text";
            options: Array<{ value: string; label: string; description: null; preview: null }>;
            placeholder: null;
          }>;
        };
        args: Record<string, never>;
      };
    }
  | {
      type: "tool-call";
      payload: { toolName: "askUser" | "planDraft" | "askUserQuestion"; toolCallId: string; args: Record<string, never> };
    }
  | {
      type: "tool-result";
      payload: {
        toolName: "askUser" | "planDraft" | "askUserQuestion";
        toolCallId: string;
        args: Record<string, never>;
        result: Record<string, unknown>;
      };
    }
  | {
      type: "tool-call";
      payload: { toolName: "writeDraft"; toolCallId: string; args: Record<string, unknown> };
    };

// 一道最小可渲染的问题，使 buildAskUserToolCallSpec 产出非空问卷
function oneQuestion() {
  return [
    {
      id: "q1",
      label: "选一个方向",
      kind: "single" as const,
      options: [{ value: "a", label: "A", description: null, preview: null }],
      placeholder: null,
    },
  ];
}

function oneRenderedQuestion(): AskUserQuestion[] {
  return [
    {
      id: "q1",
      label: "选一个方向",
      kind: { kind: "single" },
      options: [{ value: "a", label: "A", description: null, preview: null }],
      placeholder: null,
    },
  ];
}

function askUserSuspend(
  toolCallId: string,
  withQuestion = false,
  toolName: "askUser" | "planDraft" | "askUserQuestion" = "askUser",
): StreamChunk {
  return {
    type: "tool-call-suspended",
    payload: {
      toolName,
      toolCallId,
      suspendPayload: {
        id: `ask-${toolCallId}`,
        mode: "fullpage",
        source: null,
        rationale: null,
        questions: withQuestion ? oneQuestion() : [],
      },
      args: {},
    },
  };
}

function askUserToolCall(toolCallId: string): StreamChunk {
  return {
    type: "tool-call",
    payload: { toolName: "askUser", toolCallId, args: {} },
  };
}

function appendPendingAskUserToolCall(
  state: { chatHistory: any[] },
  toolCallId: string,
  questions = oneRenderedQuestion(),
): void {
  const spec: ToolCallSpec = {
    id: toolCallId,
    name: "askUser",
    render: { kind: "rightForm" },
    status: { kind: "pending" },
    body: {
      kind: "askUser",
      data: {
        id: `ask-${toolCallId}`,
        mode: { kind: "overlay" },
        purpose: { kind: "quickClarification" },
        source: null,
        rationale: null,
        questions,
      },
    },
    result: null,
  };
  state.chatHistory.push({
    id: `msg-${toolCallId}`,
    role: { kind: "agent" },
    ts: "2026-06-04T00:00:00.000Z",
    chips: null,
    parts: [{ kind: "toolCall", data: spec }],
  });
}

function suppressedAskUserResult(toolCallId: string): StreamChunk {
  return {
    type: "tool-result",
    payload: {
      toolName: "askUser",
      toolCallId,
      args: {},
      result: {
        suppressed: true,
        reason: "askUserAlreadyCompleted",
        instruction: "继续调用写作工具。",
      },
    },
  };
}

function askUserQuestionToolCall(toolCallId: string): StreamChunk {
  return {
    type: "tool-call",
    payload: { toolName: "askUserQuestion", toolCallId, args: {} },
  } as unknown as StreamChunk;
}

function writeDraftToolCall(toolCallId: string): StreamChunk {
  return {
    type: "tool-call",
    payload: { toolName: "writeDraft", toolCallId, args: { title: "Test", outline: "Test" } },
  };
}

async function* streamOf(...chunks: StreamChunk[]): AsyncGenerator<StreamChunk> {
  for (const chunk of chunks) {
    yield chunk;
  }
}

async function* throwingStream(...chunks: StreamChunk[]): AsyncGenerator<StreamChunk> {
  for (const chunk of chunks) {
    yield chunk;
  }
  throw new Error("ECONNRESET");
}

// 统计某 toolCallId 的 askUser toolCall 被 chatMessageAppended 追加了几次
function countAppendedToolCalls(frames: BridgeFrame[], toolCallId: string): number {
  let n = 0;
  for (const f of frames) {
    if (
      f.kind === "chatMessageAppended" &&
      f.data?.part?.kind === "toolCall" &&
      f.data.part.data?.id === toolCallId &&
      ["askUser", "planDraft", "askUserQuestion"].includes(f.data.part.data?.name)
    ) {
      n += 1;
    }
  }
  return n;
}

async function collectFrames(gen: AsyncGenerator<BridgeFrame>): Promise<BridgeFrame[]> {
  const frames: BridgeFrame[] = [];
  for await (const frame of gen) {
    frames.push(frame);
  }
  return frames;
}

describe("processAgentStream resume re-suspend handling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("runAgentTurn projects agentBusy at turn start before model tools run", async () => {
    const { createSession, runAgentTurn } = await import("../bridge/index.js");
    const { qingagentAgent } = await import("../agents/qingagent.js");
    const state = createSession("turn-start-busy");
    state.doc = pmDocFromText("已有正文");
    state.docState = { kind: "editing" };

    vi.mocked(qingagentAgent.stream).mockResolvedValueOnce({
      runId: "run-1",
      fullStream: streamOf(),
    } as unknown as Awaited<ReturnType<typeof qingagentAgent.stream>>);

    const gen = runAgentTurn(state, "继续润色");
    const start = await gen.next();
    const firstProjection = await gen.next();

    expect(start.value).toMatchObject({
      kind: "stream",
      data: { kind: "start" },
    });
    expect(firstProjection.value).toEqual({
      kind: "docStateChanged",
      data: {
        state: { kind: "editing" },
        activeOverlay: null,
        agentBusy: true,
        externalEditing: false,
      },
    });
    expect(qingagentAgent.stream).not.toHaveBeenCalled();

    const remaining = await collectFrames(gen);
    const finalProjection = remaining
      .filter((frame) => frame.kind === "docStateChanged")
      .at(-1);

    expect(finalProjection).toEqual({
      kind: "docStateChanged",
      data: {
        state: { kind: "editing" },
        activeOverlay: null,
        agentBusy: false,
        externalEditing: false,
      },
    });
  }, 10_000);

  it("honors a RESUME askUser suspend with a new toolCallId and re-keys the pending run", async () => {
    const { createSession, processAgentStream } = await import("../bridge/index.js");
    const state = createSession("resume-reask");
    state.runId = "old-run";
    state.toolCallId = "old-tc";

    await collectFrames(
      processAgentStream(streamOf(askUserSuspend("new-tc")), {
        state,
        agentMessageId: "agent-msg",
        streamId: "stream-1",
        runId: "new-run",
      }),
    );

    expect(state.runId).toBe("new-run");
    expect(state.toolCallId).toBe("new-tc");
  }, 20_000);

  it("preserves a true duplicate suspend with the same toolCallId", async () => {
    const { createSession, processAgentStream } = await import("../bridge/index.js");
    const state = createSession("duplicate-reask");
    state.runId = "r1";
    state.toolCallId = "tc1";
    state.docDraftCandidateDoc = pmDocFromText("重复挂起不得清空的候选");

    await collectFrames(
      processAgentStream(streamOf(askUserSuspend("tc1")), {
        state,
        agentMessageId: "agent-msg",
        streamId: "stream-2",
        runId: "new-run",
      }),
    );

    expect(state.runId).toBe("r1");
    expect(state.toolCallId).toBe("tc1");
    expect(state.docDraftCandidateDoc).not.toBeNull();
  });

  it("abandons the third consecutive askUser suspend and emits draftingFailed", async () => {
    const { createSession, processAgentStream } = await import("../bridge/index.js");
    const state = createSession("bounded-reask");
    state.runId = "old-run";
    state.toolCallId = "old-tc";
    state.previousDocState = { kind: "empty" };
    state._askUserSuspendCount = 2;

    const frames = await collectFrames(
      processAgentStream(streamOf(askUserSuspend("new-tc")), {
        state,
        agentMessageId: "agent-msg",
        streamId: "stream-3",
        runId: "new-run",
      }),
    );

    expect(state.runId).toBeNull();
    expect(state.toolCallId).toBeNull();
    expect(state._suspendedThisTurn).not.toBe(true);
    expect(state._askUserSuspendCount).toBe(0);
    expect(frames).toContainEqual({
      kind: "stream",
      data: {
        kind: "draftingFailed",
        data: {
          streamId: "stream-3",
          reason: "Agent 反复请求澄清而未继续生成，请重试或换个说法",
          retriable: true,
        },
      },
    });
  });

  it("normal single-askUser flow (tool-call then same-id suspend) emits the form only once", async () => {
    const { createSession, processAgentStream } = await import("../bridge/index.js");
    const state = createSession("normal-askuser");

    const frames = await collectFrames(
      processAgentStream(
        streamOf(askUserToolCall("tc1"), askUserSuspend("tc1", true)),
        {
          state,
          agentMessageId: "agent-msg",
          streamId: "stream-normal",
          runId: "run-1",
        },
      ),
    );

    // tool-call emits the early placeholder; the matching suspend must UPDATE
    // it (toolCallUpdated), not append a second toolCall part. Regression
    // guard for the askUserProgressToolCallId double-emit bug.
    expect(countAppendedToolCalls(frames, "tc1")).toBe(1);
    expect(
      frames.some((f) => f.kind === "toolCallUpdated" && f.data?.toolCallId === "tc1"),
    ).toBe(true);
    // Single first-suspend → run is honored and stays resumable.
    expect(state.runId).toBe("run-1");
    expect(state.toolCallId).toBe("tc1");
  });

  it.each([
    ["askUser", "fullpage"],
    ["planDraft", "fullpage"],
    ["askUserQuestion", "overlay"],
  ] as const)("%s 挂起进入共享通道并固定为 %s", async (toolName, expectedMode) => {
    const { createSession, processAgentStream } = await import("../bridge/index.js");
    const state = createSession(`questionnaire-${toolName}`);
    const toolCall = {
      type: "tool-call" as const,
      payload: { toolName, toolCallId: `${toolName}-tc`, args: {} },
    } as StreamChunk;

    await collectFrames(processAgentStream(
      streamOf(toolCall, askUserSuspend(`${toolName}-tc`, true, toolName)),
      {
        state,
        agentMessageId: "agent-msg",
        streamId: `stream-${toolName}`,
        runId: `run-${toolName}`,
      },
    ));

    expect(state._suspensionOwner?.toolName).toBe(toolName);
    const spec = state.chatHistory.flatMap((message) => message.parts)
      .find((part) => part.kind === "toolCall" && part.data.id === `${toolName}-tc`);
    expect(spec?.kind).toBe("toolCall");
    if (spec?.kind === "toolCall" && spec.data.body.kind === "askUser") {
      expect(spec.data.name).toBe(toolName);
      expect(spec.data.body.data.mode.kind).toBe(expectedMode);
    }
  });

  it("非问卷 suspend 会清零共享连续计数且不建立 owner", async () => {
    const { createSession, processAgentStream } = await import("../bridge/index.js");
    const state = createSession("non-questionnaire-suspend");
    state._askUserSuspendCount = 2;
    await collectFrames(processAgentStream(streamOf({
      type: "tool-call-suspended",
      payload: {
        toolName: "customApproval",
        toolCallId: "other-tc",
        suspendPayload: {},
        args: {},
      },
    } as unknown as StreamChunk), {
      state,
      agentMessageId: "agent-msg",
      streamId: "stream-other",
      runId: "run-other",
    }));
    expect(state._askUserSuspendCount).toBe(0);
    expect(state._suspensionOwner).toBeNull();
  });

  it("看门狗额度由 askUserQuestion 与 planDraft 合计共享", async () => {
    const { clearSuspension, createSession, processAgentStream } = await import("../bridge/index.js");
    const state = createSession("mixed-questionnaire-count");
    state._askUserSuspendCount = 1;
    await collectFrames(processAgentStream(streamOf(
      askUserQuestionToolCall("direct-count"),
      askUserSuspend("direct-count", true, "askUserQuestion"),
    ), {
      state,
      agentMessageId: "agent-direct",
      streamId: "stream-direct-count",
      runId: "run-direct-count",
    }));
    expect(state._askUserSuspendCount).toBe(2);
    clearSuspension(state);

    const frames = await collectFrames(processAgentStream(streamOf(
      {
        type: "tool-call",
        payload: { toolName: "planDraft", toolCallId: "plan-count", args: {} },
      } as StreamChunk,
      askUserSuspend("plan-count", true, "planDraft"),
    ), {
      state,
      agentMessageId: "agent-plan",
      streamId: "stream-plan-count",
      runId: "run-plan-count",
    }));
    expect(state._askUserSuspendCount).toBe(0);
    expect(frames.some((frame) =>
      frame.kind === "stream" && frame.data.kind === "draftingFailed"
    )).toBe(true);
  });

  it("0 题 rejected 终态化失败卡并清掉 overlay，不进入通用问卷结果分支", async () => {
    const { createSession, processAgentStream } = await import("../bridge/index.js");
    const state = createSession("direct-rejected");
    const frames = await collectFrames(processAgentStream(streamOf(
      {
        type: "tool-call-input-streaming-start",
        payload: { toolName: "askUserQuestion", toolCallId: "direct-rejected-tc" },
      },
      askUserQuestionToolCall("direct-rejected-tc"),
      {
        type: "tool-result",
        payload: {
          toolName: "askUserQuestion",
          toolCallId: "direct-rejected-tc",
          args: {},
          result: {
            rejected: true,
            reason: "没有可展示的有效问题",
            retryInstruction: "请重试",
          },
        },
      } as StreamChunk,
    ), {
      state,
      agentMessageId: "agent-msg",
      streamId: "stream-rejected",
      runId: "run-rejected",
    }));

    const failedUpdates = frames.filter((frame) =>
      frame.kind === "toolCallUpdated" &&
      frame.data.toolCallId === "direct-rejected-tc" &&
      frame.data.spec.status.kind === "failed",
    );
    expect(failedUpdates).toHaveLength(1);
    const appended = frames.filter((frame) =>
      frame.kind === "chatMessageAppended" &&
      frame.data.part.kind === "toolCall" &&
      frame.data.part.data.id === "direct-rejected-tc"
    );
    expect(appended).toHaveLength(1);
    expect(appended[0]).toMatchObject({
      data: { part: { data: {
        name: "askUserQuestion",
        status: { kind: "running" },
        body: { kind: "askUser", data: { mode: { kind: "overlay" }, questions: [] } },
      } } },
    });
    expect(state.chatHistory.flatMap((message) => message.parts).some((part) =>
      part.kind === "toolCall" &&
      part.data.id === "direct-rejected-tc" &&
      part.data.status.kind === "running"
    )).toBe(false);
    expect(state._askUserCompleted).not.toBe(true);
    expect(state._suspensionOwner).toBeNull();
    expect(frames.at(-1)).not.toMatchObject({
      kind: "docStateChanged",
      data: { activeOverlay: "askUser" },
    });
  });

  it("askUserQuestion streaming-start 占位在 suspend 到达后原位替换成可操作问卷", async () => {
    const { createSession, processAgentStream } = await import("../bridge/index.js");
    const state = createSession("direct-streaming-suspend");
    const frames = await collectFrames(processAgentStream(streamOf(
      {
        type: "tool-call-input-streaming-start",
        payload: { toolName: "askUserQuestion", toolCallId: "direct-streaming-tc" },
      },
      askUserQuestionToolCall("direct-streaming-tc"),
      askUserSuspend("direct-streaming-tc", true, "askUserQuestion"),
    ), {
      state,
      agentMessageId: "agent-msg",
      streamId: "stream-direct-streaming",
      runId: "run-direct-streaming",
    }));

    const appended = frames.filter((frame) =>
      frame.kind === "chatMessageAppended" &&
      frame.data.part.kind === "toolCall" &&
      frame.data.part.data.id === "direct-streaming-tc"
    );
    expect(appended).toHaveLength(1);
    expect(appended[0]).toMatchObject({
      data: { part: { data: {
        name: "askUserQuestion",
        status: { kind: "running" },
        body: { kind: "askUser", data: { mode: { kind: "overlay" }, questions: [] } },
      } } },
    });
    const suspended = frames.filter((frame) =>
      frame.kind === "toolCallUpdated" &&
      frame.data.toolCallId === "direct-streaming-tc" &&
      frame.data.spec.status.kind === "pending"
    );
    expect(suspended).toHaveLength(1);
    expect(suspended[0]).toMatchObject({
      data: { spec: {
        name: "askUserQuestion",
        body: { kind: "askUser", data: { mode: { kind: "overlay" }, questions: oneRenderedQuestion() } },
      } },
    });
  });

  it("planDraft 占位、progress、suspend 三阶段保持工具名与 fullpage 一致", async () => {
    const { createSession, processAgentStream } = await import("../bridge/index.js");
    const state = createSession("plan-three-stages");
    const frames = await collectFrames(processAgentStream(streamOf(
      {
        type: "tool-call-input-streaming-start",
        payload: { toolName: "planDraft", toolCallId: "plan-three" },
      },
      {
        type: "tool-call",
        payload: { toolName: "planDraft", toolCallId: "plan-three", args: {} },
      },
      {
        type: "tool-output",
        payload: {
          toolCallId: "plan-three",
          output: { type: "askuser-progress", questions: oneQuestion() },
        },
      },
      askUserSuspend("plan-three", true, "planDraft"),
    ), {
      state,
      agentMessageId: "agent-msg",
      streamId: "stream-plan-three",
      runId: "run-plan-three",
    }));

    const specs = frames.flatMap((frame) => {
      if (frame.kind === "chatMessageAppended" && frame.data.part.kind === "toolCall") {
        return [frame.data.part.data];
      }
      if (frame.kind === "toolCallUpdated" && frame.data.toolCallId === "plan-three") {
        return [frame.data.spec];
      }
      return [];
    }).filter((spec) => spec.id === "plan-three");
    expect(specs.length).toBeGreaterThanOrEqual(4);
    expect(specs.every((spec) => spec.name === "planDraft")).toBe(true);
    expect(specs.every((spec) =>
      spec.body.kind === "askUser" && spec.body.data.mode.kind === "fullpage"
    )).toBe(true);
  });

  it("writes the final askUser questions into chatHistory before yielding the visible update", async () => {
    const { createSession, processAgentStream } = await import("../bridge/index.js");
    const state = createSession("askuser-final-spec-before-yield");

    const gen = processAgentStream(
      streamOf(
        askUserQuestionToolCall("tc-qc"),
        askUserSuspend("tc-qc", true, "askUserQuestion"),
      ),
      {
        state,
        agentMessageId: "agent-msg",
        streamId: "stream-qc-final",
        runId: "run-1",
      },
    );

    let finalFrame: BridgeFrame | null = null;
    for (;;) {
      const next = await gen.next();
      if (next.done) throw new Error("processAgentStream ended before final askUser update");
      const frame = next.value;
      if (
        frame.kind === "toolCallUpdated" &&
        frame.data.toolCallId === "tc-qc" &&
        frame.data.spec.status.kind === "pending"
      ) {
        finalFrame = frame;
        break;
      }
    }

    const restoredSpec = state.chatHistory
      .flatMap((message) => message.parts)
      .find((part) => part.kind === "toolCall" && part.data.id === "tc-qc");

    expect(finalFrame?.kind).toBe("toolCallUpdated");
    expect(restoredSpec?.kind).toBe("toolCall");
    if (restoredSpec?.kind !== "toolCall") return;
    expect(restoredSpec.data.body.kind).toBe("askUser");
    if (restoredSpec.data.body.kind !== "askUser") return;
    expect(restoredSpec.data.status.kind).toBe("pending");
    expect(restoredSpec.data.body.data.questions).toHaveLength(1);
    await gen.return(undefined as never);
  });

  it("suppresses second-round askUser before emitting any UI frame", async () => {
    const { createSession, processAgentStream } = await import("../bridge/index.js");
    const state = createSession("suppressed-second-askuser");
    state._askUserCompleted = true;
    state._directionChangeAskedSinceLastWrite = true;
    const requestContext = new RequestContext([
      ["askUserAlreadyCompleted", true],
    ]);

    const frames = await collectFrames(
      processAgentStream(
        streamOf(
          askUserToolCall("tc-suppressed"),
          suppressedAskUserResult("tc-suppressed"),
        ),
        {
          state,
          agentMessageId: "agent-msg",
          streamId: "stream-suppressed",
          runId: "run-1",
          requestContext: requestContext as any,
        },
      ),
    );

    expect(countAppendedToolCalls(frames, "tc-suppressed")).toBe(0);
    expect(
      frames.some(
        (f) => f.kind === "toolCallUpdated" && f.data.toolCallId === "tc-suppressed",
      ),
    ).toBe(false);
    expect(
      frames.some(
        (f) => f.kind === "docStateChanged" && f.data.activeOverlay === "askUser",
      ),
    ).toBe(false);
    expect(
      state.chatHistory.some((m) =>
        m.parts.some(
          (p) =>
            p.kind === "toolCall" &&
            p.data.name === "askUser" &&
            p.data.id === "tc-suppressed",
        ),
      ),
    ).toBe(false);
  });

  it("askUserQuestion 豁免写作方向硬闸,仍发出 overlay UI 帧", async () => {
    const { createSession, processAgentStream } = await import("../bridge/index.js");
    const state = createSession("quickclar-second-round");
    // 模拟"首轮问卷已答完"的硬闸状态
    state._askUserCompleted = true;
    const requestContext = new RequestContext([
      ["askUserAlreadyCompleted", true],
    ]);

    const frames = await collectFrames(
      processAgentStream(
        streamOf(
          askUserQuestionToolCall("tc-qc"),
          askUserSuspend("tc-qc", true, "askUserQuestion"),
        ),
        {
          state,
          agentMessageId: "agent-msg",
          streamId: "stream-qc",
          runId: "run-1",
          requestContext: requestContext as any,
        },
      ),
    );

    // 放行:tool-call 占位被追加(抑制场景是 0),且投影出 askUser overlay
    expect(countAppendedToolCalls(frames, "tc-qc")).toBeGreaterThan(0);
    expect(
      frames.some(
        (f) => f.kind === "docStateChanged" && f.data.activeOverlay === "askUser",
      ),
    ).toBe(true);
  });

  it("runAgentTurn 抛错时清理 runId、脱敏失败帧并补齐空助手消息", async () => {
    const { createSession, runAgentTurn } = await import("../bridge/index.js");
    const { qingagentAgent } = await import("../agents/qingagent.js");
    const state = createSession("throwing-turn");
    state.runId = "stale";
    state.toolCallId = "stale-tc";

    vi.mocked(qingagentAgent.stream).mockResolvedValueOnce({
      runId: "run-1",
      fullStream: throwingStream(),
    } as unknown as Awaited<ReturnType<typeof qingagentAgent.stream>>);

    const frames = await collectFrames(runAgentTurn(state, "写一篇测试文档"));

    expect(
      frames.some(
        (frame) =>
          frame.kind === "stream" &&
          frame.data.kind === "draftingFailed" &&
          frame.data.data.reason === "本轮处理失败，请稍后重试。",
      ),
    ).toBe(true);
    expect(JSON.stringify(frames)).not.toContain("ECONNRESET");
    const agentMessage = state.chatHistory.find(
      (message) => message.role.kind === "agent",
    );
    expect(agentMessage?.parts).toContainEqual({
      kind: "text",
      data: { body: "本轮处理失败，请稍后重试。" },
    });
    expect(JSON.stringify(state.chatHistory)).not.toContain("ECONNRESET");
    expect(state.runId).toBeNull();
    expect(state.toolCallId).toBeNull();
  });

  it("genuine askUser suspend leaves runId SET (resume works)", async () => {
    const { createSession, runAgentTurn } = await import("../bridge/index.js");
    const { qingagentAgent } = await import("../agents/qingagent.js");
    const state = createSession("genuine-askuser");

    vi.mocked(qingagentAgent.stream).mockResolvedValueOnce({
      runId: "run-1",
      fullStream: streamOf(askUserToolCall("tc1"), askUserSuspend("tc1", true)),
    } as unknown as Awaited<ReturnType<typeof qingagentAgent.stream>>);

    await collectFrames(runAgentTurn(state, "帮我写一篇文章"));

    expect(state.runId).toBe("run-1");
    expect(state.toolCallId).toBe("tc1");
    expect(state._suspendedThisTurn).toBe(true);
  });

  it("runAgentTurn preserves a genuine suspension if another request resets the shared flag before finally", async () => {
    const { createSession, runAgentTurn } = await import("../bridge/index.js");
    const { qingagentAgent } = await import("../agents/qingagent.js");
    const state = createSession("suspend-flag-race");

    vi.mocked(qingagentAgent.stream).mockResolvedValueOnce({
      runId: "run-1",
      fullStream: streamOf(askUserToolCall("tc1"), askUserSuspend("tc1", true)),
    } as unknown as Awaited<ReturnType<typeof qingagentAgent.stream>>);

    const gen = runAgentTurn(state, "帮我写一篇文章");
    for (let i = 0; i < 20 && state.runId !== "run-1"; i++) {
      const next = await gen.next();
      expect(next.done).not.toBe(true);
    }
    expect(state.runId).toBe("run-1");
    expect(state.toolCallId).toBe("tc1");

    // This simulates the old handleResume top-of-function reset interleaving
    // before the original runAgentTurn generator reaches its finally block.
    state._suspendedThisTurn = false;

    for (;;) {
      const next = await gen.next();
      if (next.done) break;
    }

    expect(state.runId).toBe("run-1");
    expect(state.toolCallId).toBe("tc1");
  });

  it("processAgentStream preserves a suspension owned by another overlapping stream", async () => {
    const { createSession, processAgentStream, recordSuspension } = await import(
      "../bridge/index.js"
    );
    const state = createSession("overlap-preserve");
    state._askUserSuspendCount = 1;
    appendPendingAskUserToolCall(state, "T2");
    recordSuspension(state, {
      streamId: "B",
      runId: "R2",
      toolCallId: "T2",
      toolName: "askUser",
    });

    await collectFrames(
      processAgentStream(streamOf(), {
        state,
        agentMessageId: "agent-msg",
        streamId: "A",
        runId: "R1",
      }),
    );

    expect(state.runId).toBe("R2");
    expect(state.toolCallId).toBe("T2");
    expect(state._suspensionOwner).toEqual({
      streamId: "B",
      runId: "R2",
      toolCallId: "T2",
      toolName: "askUser",
    });
    expect(state._askUserSuspendCount).toBe(1);
  });

  it("processAgentStream clears stale suspension ids when no active suspension exists", async () => {
    const { createSession, processAgentStream } = await import("../bridge/index.js");
    const state = createSession("overlap-clear-stale");
    state.runId = "stale-run";
    state.toolCallId = "stale-tc";
    state._askUserSuspendCount = 1;

    await collectFrames(
      processAgentStream(streamOf(), {
        state,
        agentMessageId: "agent-msg",
        streamId: "A",
        runId: "R1",
      }),
    );

    expect(state.runId).toBeNull();
    expect(state.toolCallId).toBeNull();
    expect(state._suspensionOwner).toBeNull();
    expect(state._askUserSuspendCount).toBe(0);
  });
});
