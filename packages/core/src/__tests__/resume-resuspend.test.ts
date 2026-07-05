import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AskUserQuestion, BridgeFrame, ToolCallSpec } from "@qingagent/contract-ts";
import { legacySectionsToPm } from "@qingagent/pm-schema";
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
      type: "tool-call-suspended";
      payload: {
        toolName: "askUser";
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
      payload: { toolName: "askUser"; toolCallId: string; args: Record<string, never> };
    }
  | {
      type: "tool-result";
      payload: {
        toolName: "askUser";
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

function askUserSuspend(toolCallId: string, withQuestion = false): StreamChunk {
  return {
    type: "tool-call-suspended",
    payload: {
      toolName: "askUser",
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

// 二轮 quickClarification 的 tool-call(args 带 purpose),验证它豁免硬闸、仍发 UI 帧
function quickClarificationToolCall(toolCallId: string): StreamChunk {
  return {
    type: "tool-call",
    payload: { toolName: "askUser", toolCallId, args: { purpose: "quickClarification" } },
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
      f.data.part.data?.name === "askUser"
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
    state.legacySections = [{ kind: "p", data: { text: "已有正文" } }];
    state.doc = legacySectionsToPm(state.legacySections as never);
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
  });

  it("preserves a true duplicate suspend with the same toolCallId", async () => {
    const { createSession, processAgentStream } = await import("../bridge/index.js");
    const state = createSession("duplicate-reask");
    state.runId = "r1";
    state.toolCallId = "tc1";

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

  it("writes the final askUser questions into chatHistory before yielding the visible update", async () => {
    const { createSession, processAgentStream } = await import("../bridge/index.js");
    const state = createSession("askuser-final-spec-before-yield");

    const gen = processAgentStream(
      streamOf(quickClarificationToolCall("tc-qc"), askUserSuspend("tc-qc", true)),
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

  it("二轮 quickClarification 豁免硬闸,仍发出 UI 帧(对比 initialBrief 被抑制)", async () => {
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
          quickClarificationToolCall("tc-qc"),
          askUserSuspend("tc-qc", true),
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

  it("runAgentTurn clears stale runId when the stream throws (no permanent wedge)", async () => {
    const { createSession, runAgentTurn } = await import("../bridge/index.js");
    const { qingagentAgent } = await import("../agents/qingagent.js");
    const state = createSession("throwing-turn");
    state.runId = "stale";
    state.toolCallId = "stale-tc";

    vi.mocked(qingagentAgent.stream).mockResolvedValueOnce({
      runId: "run-1",
      fullStream: throwingStream(writeDraftToolCall("write-tc")),
    } as unknown as Awaited<ReturnType<typeof qingagentAgent.stream>>);

    const frames = await collectFrames(runAgentTurn(state, "写一篇测试文档"));

    expect(
      frames.some(
        (frame) =>
          frame.kind === "stream" &&
          frame.data.kind === "draftingFailed" &&
          frame.data.data.reason === "ECONNRESET",
      ),
    ).toBe(true);
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
