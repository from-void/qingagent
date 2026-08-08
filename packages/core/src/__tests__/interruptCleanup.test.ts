import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolCallSpec, BridgeFrame } from "@qingagent/contract-ts";
import { legacySectionsToPm } from "@qingagent/pm-schema";
import { qingagentAgent } from "../agents/qingagent.js";
import { ConfirmService } from "../confirm/confirmService.js";

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

async function collectFrames(gen: AsyncGenerator<BridgeFrame>): Promise<BridgeFrame[]> {
  const frames: BridgeFrame[] = [];
  for await (const frame of gen) {
    frames.push(frame);
  }
  return frames;
}

function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => queueMicrotask(resolve));
}

function seedDoc(state: import("../bridge/index.js").SessionState): void {
  state.doc = legacySectionsToPm([{ kind: "p", data: { text: "正文" } }] as never);
}

function writeDraftToolCall(
  id: string,
  status: ToolCallSpec["status"],
): ToolCallSpec {
  return {
    id,
    name: "writeDraft",
    render: { kind: "chatInline" },
    status,
    body: { kind: "generic", data: { argsJson: "{\"title\":\"中断前草稿\"}" } },
    result: null,
  };
}

function runningWriteDraft(id: string): ToolCallSpec {
  return writeDraftToolCall(id, {
    kind: "running",
    data: { progressPct: 40, etaSec: null },
  });
}

function runningCommand(id: string): ToolCallSpec {
  return {
    id,
    name: "mastra_workspace_execute_command",
    render: { kind: "chatInline" },
    status: { kind: "running", data: { progressPct: null, etaSec: null } },
    body: {
      kind: "commandCard",
      data: {
        title: "运行命令",
        icon: "⚙️",
        command: "sleep 20",
        exitCode: 0,
        outputTail: "",
        phase: "running",
      },
    },
    result: null,
  };
}

function runningBackgroundCommand(id: string, pid = "4242"): ToolCallSpec {
  return {
    ...runningCommand(id),
    body: {
      kind: "commandCard",
      data: {
        title: "运行命令",
        icon: "⚙️",
        command: "sleep 300",
        exitCode: 0,
        outputTail: `后台任务已启动（PID ${pid}）`,
        phase: "running",
        pid,
        ownerToolCallId: id,
        background: true,
      },
    },
    result: { kind: "genericText", data: `Started background process (PID: ${pid})` },
  };
}

function setSingleToolCall(
  state: import("../bridge/index.js").SessionState,
  spec: ToolCallSpec,
): void {
  state.chatHistory = [
    {
      id: "agent-msg",
      role: { kind: "agent" },
      ts: "2026-01-01T00:00:00.000Z",
      parts: [{ kind: "toolCall", data: spec }],
      chips: null,
    },
  ];
}

function firstToolStatus(
  state: import("../bridge/index.js").SessionState,
): ToolCallSpec["status"]["kind"] | null {
  const part = state.chatHistory[0]?.parts[0];
  return part?.kind === "toolCall" ? part.data.status.kind : null;
}

function findToolCallSpec(
  state: import("../bridge/index.js").SessionState,
  id: string,
): ToolCallSpec | null {
  for (const message of state.chatHistory) {
    for (const part of message.parts) {
      if (part.kind === "toolCall" && part.data.id === id) {
        return part.data;
      }
    }
  }
  return null;
}

function qingagentStreamMock(): {
  mockImplementationOnce: (impl: (...args: unknown[]) => Promise<unknown>) => void;
  mockReset: () => void;
} {
  return qingagentAgent.stream as unknown as {
    mockImplementationOnce: (impl: (...args: unknown[]) => Promise<unknown>) => void;
    mockReset: () => void;
  };
}

beforeEach(() => {
  qingagentStreamMock().mockReset();
});

describe("abortAndCleanupTurn", () => {
  it("流消费者在首帧后关闭时立即结算 turn 所有权", async () => {
    const { createSession, runAgentTurn } = await import("../bridge/index.js");
    const state = createSession("consumer-close-after-start");
    const generator = runAgentTurn(state, "开始处理");

    const first = await generator.next();
    expect(first.value).toMatchObject({
      kind: "stream",
      data: { kind: "start" },
    });
    expect(state.streamId).not.toBeNull();
    expect(state._abortController).not.toBeNull();
    expect(state._activeTurnPromise).not.toBeNull();
    expect(state._turnOwner).not.toBeNull();

    await generator.return(undefined);

    expect(state.streamId).toBeNull();
    expect(state._abortController).toBeNull();
    expect(state._activeTurnPromise).toBeNull();
    expect(state._turnOwner).toBeNull();
    await generator.return(undefined);
  });

  it.each([
    ["仍有运行卡", true],
    ["旧进程已退出且无运行卡", false],
  ])("新消息抢占%s时不追加写死的用户可见正文", async (_label, withRunningCard) => {
    const {
      abortAndCleanupTurn,
      createSession,
    } = await import("../bridge/index.js");
    const state = createSession(`preempt-notice-${withRunningCard}`);
    state._activeAgentMessageId = "old-agent-message";
    state.chatHistory.push({
      id: "old-agent-message",
      role: { kind: "agent" },
      ts: "2026-01-01T00:00:00.000Z",
      parts: withRunningCard
        ? [{ kind: "toolCall", data: runningCommand("old-wait") }]
        : [],
      chips: null,
    });

    const frames = await collectFrames(
      abortAndCleanupTurn(state, {
        emitStreamEnd: false,
        reason: "preemptedByNewMessage",
      }),
    );

    expect(frames.some((frame) => frame.kind === "chatMessageAdded")).toBe(false);
    expect(frames.some((frame) => frame.kind === "chatMessageAppended")).toBe(false);
    if (withRunningCard) {
      expect(state.messages).toEqual([
        expect.objectContaining({
          role: "system",
          content: expect.stringContaining("上一轮被用户的新消息接替"),
        }),
      ]);
      expect(String(state.messages[0]?.content)).toContain("结果未送达");
      expect(String(state.messages[0]?.content)).toContain("不是工具或其背后服务失败");
    } else {
      expect(state.messages).toEqual([]);
    }
    const oldMessage = state.chatHistory.find((message) => message.id === "old-agent-message");
    expect(oldMessage?.parts.some((part) => part.kind === "text")).toBe(false);
    expect(state._activeAgentMessageId).toBeNull();
  });

  it("新消息抢占保留已交付后台 owner 与原 PID，不调用会话止付", async () => {
    const { abortAndCleanupTurn, createSession } = await import("../bridge/index.js");
    const state = createSession("preempt-background-survives");
    const terminateBackgroundCommands = vi.fn(async () => []);
    setSingleToolCall(state, runningBackgroundCommand("background-owner", "4242"));
    state._backgroundCommandOwnerByPid?.set("4242", "background-owner");

    await collectFrames(abortAndCleanupTurn(state, {
      emitStreamEnd: false,
      reason: "preemptedByNewMessage",
      terminateBackgroundCommands,
    }));

    expect(terminateBackgroundCommands).not.toHaveBeenCalled();
    expect(findToolCallSpec(state, "background-owner")).toMatchObject({
      status: { kind: "running" },
      body: {
        kind: "commandCard",
        data: { pid: "4242", background: true },
      },
    });
    expect(state._backgroundCommandOwnerByPid?.get("4242")).toBe("background-owner");
  });

  it("后台 spawn 已成功但结果未送达时，抢占注记给出原 PID 与轮询出口", async () => {
    const { abortAndCleanupTurn, createSession } = await import("../bridge/index.js");
    const state = createSession("preempt-background-result-undelivered");
    const spec = runningCommand("background-spawn");
    setSingleToolCall(state, spec);
    state._activeAgentMessageId = "agent-msg";
    state._backgroundCommandOwnerByPid?.set("5151", "background-spawn");

    await collectFrames(abortAndCleanupTurn(state, {
      emitStreamEnd: false,
      reason: "preemptedByNewMessage",
    }));

    expect(findToolCallSpec(state, "background-spawn")?.status.kind).toBe("running");
    expect(state.messages).toHaveLength(1);
    const note = String(state.messages[0]?.content);
    expect(note).toContain("mastra_workspace_execute_command");
    expect(note).toContain("后台 PID:5151");
    expect(note).toContain("进程仍在运行");
    expect(note).toContain("可用原 PID 5151 继续轮询");
    expect(note).toContain("不表示登录态失效");
  });

  it("aborts, waits for the active turn finally, terminalizes in-flight tools, and projects idle", async () => {
    const { abortAndCleanupTurn, createSession } = await import("../bridge/index.js");
    const state = createSession("abort-cleanup");
    const controller = new AbortController();
    const events: string[] = [];
    let resolveTurn!: () => void;

    state.streamId = "old-stream";
    state._abortController = controller;
    state._activeTurnPromise = new Promise<void>((resolve) => {
      resolveTurn = () => {
        events.push("old-finally");
        state.streamId = null;
        resolve();
      };
    });
    state.docDraftBaseDoc = legacySectionsToPm([{ kind: "p", data: { text: "base" } }] as never);
    state.docDraftBaseVersion = 3;
    state.docDraftCandidateDoc = legacySectionsToPm([{ kind: "p", data: { text: "partial" } }] as never);
    state._lastEmittedWireKind = "drafting";
    state.chatHistory = [
      {
        id: "agent-msg",
        role: { kind: "agent" },
        ts: "2026-01-01T00:00:00.000Z",
        parts: [{ kind: "toolCall", data: runningWriteDraft("draft-1") }],
        chips: null,
      },
    ];

    const framesPromise = collectFrames(abortAndCleanupTurn(state));
    await flushMicrotasks();

    expect(controller.signal.aborted).toBe(true);
    expect(state.chatHistory[0]?.parts[0]?.kind).toBe("toolCall");
    const beforeResolve = state.chatHistory[0]?.parts[0];
    expect(beforeResolve?.kind === "toolCall" ? beforeResolve.data.status.kind : null).toBe(
      "running",
    );
    expect(state.docDraftCandidateDoc).not.toBeNull();

    resolveTurn();
    const frames = await framesPromise;

    expect(events).toEqual(["old-finally"]);
    expect(state.streamId).toBeNull();
    expect(state._abortController).toBeNull();
    expect(state._activeTurnPromise).toBeNull();
    expect(state.docDraftBaseDoc).toBeNull();
    expect(state.docDraftBaseVersion).toBeNull();
    expect(state.docDraftCandidateDoc).toBeNull();

    const toolFrame = frames.find((frame) => frame.kind === "toolCallUpdated");
    expect(toolFrame).toMatchObject({
      kind: "toolCallUpdated",
      data: {
        toolCallId: "draft-1",
        spec: {
          status: { kind: "aborted" },
        },
      },
    });
    expect(frames).toContainEqual({
      kind: "docStateChanged",
      data: { state: { kind: "empty" }, activeOverlay: null, agentBusy: false },
    });
    expect(frames.at(-1)).toEqual({
      kind: "stream",
      data: {
        kind: "end",
        data: { streamId: "old-stream", reason: { kind: "cancelled" } },
      },
    });
  });

  it("中止当前 turn 时精确取消其 pending confirm 并先发 resolved", async () => {
    const { abortAndCleanupTurn, createSession } = await import("../bridge/index.js");
    const state = createSession("abort-pending-confirm");
    state.streamId = "stream-confirm";
    state._activeAgentMessageId = "agent-confirm";
    setSingleToolCall(state, runningCommand("tool-confirm"));
    state.chatHistory[0]!.id = "agent-confirm";
    const pending = {
      confirmId: "confirm-current",
      runId: "run-current",
      toolCallId: "tool-confirm",
      toolName: "mastra_workspace_execute_command",
      commandDigest: "digest-current",
      spec: {
        id: "confirm-current",
        kind: "command" as const,
        title: "运行命令",
        say: "需要确认",
        commandPreview: "sleep 20",
        footHint: "仅本次",
        primaryLabel: "执行",
        secondaryLabel: "取消",
      },
      requestedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      status: "pending" as const,
    };
    const unrelated = {
      ...pending,
      confirmId: "confirm-unrelated",
      runId: "run-unrelated",
      toolCallId: "tool-unrelated",
      commandDigest: "digest-unrelated",
      spec: { ...pending.spec, id: "confirm-unrelated" },
    };
    state.pendingConfirms.set(pending.toolCallId, pending);
    state.pendingConfirms.set(unrelated.toolCallId, unrelated);
    const persistReasons: string[] = [];
    const service = new ConfirmService({
      appendAudit: async () => undefined,
      persist: async (_current, persistReason) => {
        persistReasons.push(persistReason);
      },
    });

    const frames = await collectFrames(abortAndCleanupTurn(state, {
      confirmService: service,
    }));

    expect(state.pendingConfirms.has(pending.toolCallId)).toBe(false);
    expect(state.pendingConfirms.get(unrelated.toolCallId)).toBe(unrelated);
    expect(persistReasons).toEqual(["confirm:aborted:terminal", "confirm:aborted"]);
    const resolvedIndex = frames.findIndex(
      (frame) =>
        frame.kind === "confirmResolved" &&
        frame.data.toolCallId === pending.toolCallId &&
        frame.data.resolution === "aborted",
    );
    const toolUpdateIndex = frames.findIndex(
      (frame) =>
        frame.kind === "toolCallUpdated" &&
        frame.data.toolCallId === pending.toolCallId,
    );
    expect(resolvedIndex).toBeGreaterThanOrEqual(0);
    expect(toolUpdateIndex).toBeGreaterThan(resolvedIndex);
    expect(firstToolStatus(state)).toBe("aborted");
  });

  it("全局停止在活动消息已清空后仍取消 pending confirm 并拒绝迟到接受", async () => {
    const { abortAndCleanupTurn, createSession } = await import("../bridge/index.js");
    const state = createSession("global-stop-pending-confirm");
    state._activeAgentMessageId = null;
    setSingleToolCall(state, runningCommand("tool-global-confirm"));
    const pending = {
      confirmId: "confirm-global",
      runId: "run-global",
      toolCallId: "tool-global-confirm",
      toolName: "mastra_workspace_execute_command",
      commandDigest: "digest-global",
      spec: {
        id: "confirm-global",
        kind: "command" as const,
        title: "运行命令",
        say: "需要确认",
        commandPreview: "sleep 20",
        footHint: "仅本次",
        primaryLabel: "执行",
        secondaryLabel: "取消",
      },
      requestedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      status: "pending" as const,
    };
    state.pendingConfirms.set(pending.toolCallId, pending);
    const persistReasons: string[] = [];
    const service = new ConfirmService({
      appendAudit: async () => undefined,
      persist: async (_current, persistReason) => {
        persistReasons.push(persistReason);
      },
    });

    const frames = await collectFrames(abortAndCleanupTurn(state, {
      reason: "globalStop",
      confirmService: service,
    }));

    expect(state.pendingConfirms.has(pending.toolCallId)).toBe(false);
    expect(persistReasons).toEqual(["confirm:aborted:terminal", "confirm:aborted"]);
    // 中止收口必须带如实说明:用户与模型都不能只拿到一句笼统"已中止"。
    expect(frames).toContainEqual(
      service.resolvedFrame(
        pending,
        "aborted",
        "已停止，这张确认卡一并收回，命令没有执行。需要的话我可以重新发起。",
      ),
    );
    await expect(service.beginDecision(state, {
      sessionId: state.sessionId,
      toolCallId: pending.toolCallId,
      decisionId: "late-accept",
      decision: {
        id: pending.confirmId,
        accepted: true,
      },
      hasSecretValue: false,
    })).rejects.toMatchObject({
      code: "not_found",
      message: "没有可处理的确认请求",
    });
  });

  it("R2-22 active turn 不 resolve 时也会超时孤儿化并投影 idle", async () => {
    const { abortAndCleanupTurn, createSession } = await import("../bridge/index.js");
    const state = createSession("abort-cleanup-timeout");
    const controller = new AbortController();

    state.streamId = "hung-stream";
    state._abortController = controller;
    state._activeTurnPromise = new Promise<void>(() => undefined);
    state.docDraftBaseDoc = legacySectionsToPm([{ kind: "p", data: { text: "base" } }] as never);
    state.docDraftCandidateDoc = legacySectionsToPm([{ kind: "p", data: { text: "partial" } }] as never);

    const frames = await collectFrames(abortAndCleanupTurn(state, { activeTurnTimeoutMs: 1 }));

    expect(controller.signal.aborted).toBe(true);
    expect(state.streamId).toBeNull();
    expect(state._abortController).toBeNull();
    expect(state._activeTurnPromise).toBeNull();
    expect(frames).toContainEqual({
      kind: "docStateChanged",
      data: { state: { kind: "empty" }, activeOverlay: null, agentBusy: false },
    });
    expect(frames.at(-1)).toEqual({
      kind: "stream",
      data: {
        kind: "end",
        data: { streamId: "hung-stream", reason: { kind: "cancelled" } },
      },
    });
  });

  it("运行命令取消并切回会话时 status 与 commandCard 都持久收敛为 aborted", async () => {
    const { abortAndCleanupTurn, createSession } = await import("../bridge/index.js");
    const state = createSession("abort-running-command-card");
    state.streamId = "stream-running-command";
    state._abortController = new AbortController();
    setSingleToolCall(state, runningCommand("command-sleep"));

    const frames = await collectFrames(abortAndCleanupTurn(state));
    const persisted = findToolCallSpec(state, "command-sleep");

    expect(persisted).toMatchObject({
      status: { kind: "aborted" },
      body: {
        kind: "commandCard",
        data: expect.objectContaining({
          phase: "failed",
          terminalKind: "aborted",
        }),
      },
    });
    expect(frames).toContainEqual(expect.objectContaining({
      kind: "toolCallUpdated",
      data: expect.objectContaining({
        toolCallId: "command-sleep",
        spec: expect.objectContaining({
          status: expect.objectContaining({ kind: "aborted" }),
          body: expect.objectContaining({
            kind: "commandCard",
            data: expect.objectContaining({ phase: "failed" }),
          }),
        }),
      }),
    }));
  });

  it("全局急停调用会话止付并保留其后台 owner 权威终态", async () => {
    const { abortAndCleanupTurn, createSession } = await import("../bridge/index.js");
    const { settleBackgroundCommand } = await import(
      "../agent-run/backgroundCommandSettlement.js"
    );
    const state = createSession("global-stop-background");
    state.streamId = "stream-global-stop";
    state._abortController = new AbortController();
    state._backgroundCommandOwnerByPid?.set("7373", "background-owner");
    state.chatHistory = [{
      id: "agent-global-stop",
      role: { kind: "agent" },
      ts: "2026-01-01T00:00:00.000Z",
      chips: null,
      parts: [
        { kind: "toolCall", data: runningBackgroundCommand("background-owner", "7373") },
        {
          kind: "toolCall",
          data: {
            id: "background-read",
            name: "mastra_workspace_get_process_output",
            render: { kind: "chatInline" },
            status: { kind: "running", data: { progressPct: null, etaSec: null } },
            body: { kind: "generic", data: { argsJson: "{\"pid\":\"7373\",\"wait\":true}" } },
            result: null,
          },
        },
      ],
    }];

    const terminateBackgroundCommands = vi.fn(async () => {
      const settlement = settleBackgroundCommand(
        state,
        "7373",
        { kind: "killed", signal: "用户停止" },
      );
      return settlement ? [settlement] : [];
    });

    await collectFrames(abortAndCleanupTurn(state, {
      emitStreamEnd: false,
      reason: "globalStop",
      terminateBackgroundCommands,
    }));

    expect(terminateBackgroundCommands).toHaveBeenCalledWith(state, "userStop");
    const owner = findToolCallSpec(state, "background-owner");
    expect(owner).toMatchObject({
      status: {
        kind: "failed",
        data: { retriable: false, reason: "已终止（用户停止）" },
      },
      body: {
        kind: "commandCard",
        data: { terminalKind: "killed", pid: "7373" },
      },
    });
    expect(findToolCallSpec(state, "background-read")).toMatchObject({
      status: { kind: "aborted" },
      body: {
        kind: "generic",
        data: { terminalKind: "aborted" },
      },
    });
  });

  it("真实 runAgentTurn 中止路径不会先把 running 工具卡补成 done", async () => {
    const { abortAndCleanupTurn, createSession, runAgentTurn } = await import("../bridge/index.js");
    const state = createSession("abort-run-agent-tool");
    let toolCallProcessed!: () => void;
    const toolCallSeen = new Promise<void>((resolve) => {
      toolCallProcessed = resolve;
    });

    qingagentStreamMock().mockImplementationOnce(async (...args: unknown[]) => {
      const options = args[1] as { abortSignal?: AbortSignal };
      const abortSignal = options.abortSignal;
      async function* fullStream(): AsyncGenerator<unknown> {
        yield { type: "text-delta", payload: { text: "中断前正文" } };
        yield {
          type: "tool-call",
          payload: {
            toolName: "parseFile",
            toolCallId: "tc-real-abort",
            args: { filename: "a.txt" },
          },
        };
        toolCallProcessed();
        if (!abortSignal?.aborted) {
          await new Promise<void>((resolve) =>
            abortSignal?.addEventListener("abort", () => resolve(), { once: true }),
          );
        }
      }
      return {
        runId: "run-real-abort",
        fullStream: fullStream(),
      } as unknown as Awaited<ReturnType<typeof qingagentAgent.stream>>;
    });

    const turnFramesPromise = collectFrames(runAgentTurn(state, "解析这个文件"));
    await toolCallSeen;
    expect(findToolCallSpec(state, "tc-real-abort")?.status.kind).toBe("running");

    const cleanupFramesPromise = collectFrames(
      abortAndCleanupTurn(state, { emitStreamEnd: false }),
    );
    const [turnFrames, cleanupFrames] = await Promise.all([
      turnFramesPromise,
      cleanupFramesPromise,
    ]);

    expect(
      turnFrames.some(
        (frame) =>
          frame.kind === "toolCallUpdated" &&
          frame.data.toolCallId === "tc-real-abort" &&
          frame.data.spec.status.kind === "done",
      ),
    ).toBe(false);
    expect(cleanupFrames).toContainEqual({
      kind: "toolCallUpdated",
      data: {
        messageId: expect.any(String),
        toolCallId: "tc-real-abort",
        spec: expect.objectContaining({
          status: { kind: "aborted" },
        }),
      },
    });
    expect(findToolCallSpec(state, "tc-real-abort")?.status).toEqual({ kind: "aborted" });
  });

  it("真实 runAgentTurn 中止后 fullStream 抛 AbortError 时仍不发失败帧也不补 done", async () => {
    const { abortAndCleanupTurn, createSession, runAgentTurn } = await import("../bridge/index.js");
    const state = createSession("abort-run-agent-tool-reject");
    let toolCallProcessed!: () => void;
    const toolCallSeen = new Promise<void>((resolve) => {
      toolCallProcessed = resolve;
    });

    qingagentStreamMock().mockImplementationOnce(async (...args: unknown[]) => {
      const options = args[1] as { abortSignal?: AbortSignal };
      const abortSignal = options.abortSignal;
      async function* fullStream(): AsyncGenerator<unknown> {
        yield { type: "text-delta", payload: { text: "中断前正文" } };
        yield {
          type: "tool-call",
          payload: {
            toolName: "parseFile",
            toolCallId: "tc-real-abort-reject",
            args: { filename: "a.txt" },
          },
        };
        toolCallProcessed();
        if (!abortSignal?.aborted) {
          await new Promise<void>((resolve) =>
            abortSignal?.addEventListener("abort", () => resolve(), { once: true }),
          );
        }
        const error = new Error("The operation was aborted");
        error.name = "AbortError";
        throw error;
      }
      return {
        runId: "run-real-abort-reject",
        fullStream: fullStream(),
      } as unknown as Awaited<ReturnType<typeof qingagentAgent.stream>>;
    });

    const turnFramesPromise = collectFrames(runAgentTurn(state, "解析这个文件"));
    await toolCallSeen;
    expect(findToolCallSpec(state, "tc-real-abort-reject")?.status.kind).toBe("running");

    const cleanupFramesPromise = collectFrames(
      abortAndCleanupTurn(state, { emitStreamEnd: false }),
    );
    const [turnFrames, cleanupFrames] = await Promise.all([
      turnFramesPromise,
      cleanupFramesPromise,
    ]);

    expect(
      turnFrames.some((frame) => frame.kind === "stream" && frame.data.kind === "draftingFailed"),
    ).toBe(false);
    expect(
      turnFrames.some(
        (frame) =>
          frame.kind === "toolCallUpdated" &&
          frame.data.toolCallId === "tc-real-abort-reject" &&
          frame.data.spec.status.kind === "done",
      ),
    ).toBe(false);
    expect(cleanupFrames).toContainEqual({
      kind: "toolCallUpdated",
      data: {
        messageId: expect.any(String),
        toolCallId: "tc-real-abort-reject",
        spec: expect.objectContaining({
          status: { kind: "aborted" },
        }),
      },
    });
    expect(findToolCallSpec(state, "tc-real-abort-reject")?.status).toEqual({ kind: "aborted" });
  });

  it("真实 runAgentTurn 用户中止时同一 streamId 只发一个 cancelled 终态", async () => {
    const { abortAndCleanupTurn, createSession, runAgentTurn } = await import("../bridge/index.js");
    const state = createSession("abort-single-stream-end");
    let firstChunkProcessed!: () => void;
    const firstChunkSeen = new Promise<void>((resolve) => {
      firstChunkProcessed = resolve;
    });

    qingagentStreamMock().mockImplementationOnce(async (...args: unknown[]) => {
      const options = args[1] as { abortSignal?: AbortSignal };
      const abortSignal = options.abortSignal;
      async function* fullStream(): AsyncGenerator<unknown> {
        yield { type: "text-delta", payload: { text: "中断前正文" } };
        firstChunkProcessed();
        if (!abortSignal?.aborted) {
          await new Promise<void>((resolve) =>
            abortSignal?.addEventListener("abort", () => resolve(), { once: true }),
          );
        }
      }
      return {
        runId: "run-single-stream-end",
        fullStream: fullStream(),
      } as unknown as Awaited<ReturnType<typeof qingagentAgent.stream>>;
    });

    const turnFramesPromise = collectFrames(runAgentTurn(state, "开始处理"));
    await firstChunkSeen;
    const abortedStreamId = state.streamId;
    expect(abortedStreamId).not.toBeNull();

    const cleanupFramesPromise = collectFrames(abortAndCleanupTurn(state));
    const [turnFrames, cleanupFrames] = await Promise.all([
      turnFramesPromise,
      cleanupFramesPromise,
    ]);
    const endFrames = [...turnFrames, ...cleanupFrames].filter(
      (frame) =>
        frame.kind === "stream" &&
        frame.data.kind === "end" &&
        frame.data.data.streamId === abortedStreamId,
    );

    expect(endFrames).toEqual([
      {
        kind: "stream",
        data: {
          kind: "end",
          data: {
            streamId: abortedStreamId,
            reason: { kind: "cancelled" },
          },
        },
      },
    ]);
  });
});

describe("finalizeLingeringRunningToolCalls", () => {
  it("finalizes orphan running writeDraft without active suspension", async () => {
    const {
      createSession,
      deriveActiveOverlay,
      deriveAgentBusy,
      deriveContentState,
      deriveEditorState,
      finalizeLingeringRunningToolCalls,
    } = await import("../bridge/index.js");
    const state = createSession("finalize-orphan-write-draft");
    seedDoc(state);
    setSingleToolCall(state, runningWriteDraft("draft-running"));

    expect(deriveActiveOverlay(state)).toBeNull();

    const updates = finalizeLingeringRunningToolCalls(state);

    expect(updates).toMatchObject([
      {
        messageId: "agent-msg",
        toolCallId: "draft-running",
        spec: { status: { kind: "done" } },
      },
    ]);
    expect(firstToolStatus(state)).toBe("done");
    expect(deriveActiveOverlay(state)).toBeNull();
    expect(deriveEditorState(
      deriveContentState(state),
      deriveAgentBusy(state),
      deriveActiveOverlay(state),
    )).not.toBe("locked");
  });

  it("finalizes orphan running writeDraft while preserving active askUser suspension", async () => {
    const {
      createSession,
      deriveActiveOverlay,
      finalizeLingeringRunningToolCalls,
      recordSuspension,
    } = await import("../bridge/index.js");
    const state = createSession("finalize-ask-user-with-running-draft");
    state.chatHistory = [
      {
        id: "agent-msg",
        role: { kind: "agent" },
        ts: "2026-01-01T00:00:00.000Z",
        chips: null,
        parts: [
          {
            kind: "toolCall",
            data: {
              id: "ask-1",
              name: "askUser",
              render: { kind: "rightForm" },
              status: { kind: "pending" },
              body: { kind: "generic", data: { argsJson: "{}" } },
              result: null,
            },
          },
          { kind: "toolCall", data: runningWriteDraft("draft-orphan") },
        ],
      },
    ];
    recordSuspension(state, {
      streamId: "stream-1",
      runId: "run-1",
      toolCallId: "ask-1",
      toolName: "askUser",
    });

    const updates = finalizeLingeringRunningToolCalls(state);

    expect(updates).toMatchObject([
      {
        messageId: "agent-msg",
        toolCallId: "draft-orphan",
        spec: { status: { kind: "done" } },
      },
    ]);
    expect(deriveActiveOverlay(state)).toBe("askUser");
    const parts = state.chatHistory[0]?.parts ?? [];
    expect(parts[0]?.kind === "toolCall" ? parts[0].data.status.kind : null).toBe("pending");
    expect(parts[1]?.kind === "toolCall" ? parts[1].data.status.kind : null).toBe("done");
  });

  it("keeps finalizing running tool calls to done", async () => {
    const { createSession, finalizeLingeringRunningToolCalls } = await import(
      "../bridge/index.js"
    );
    const state = createSession("finalize-running");
    setSingleToolCall(state, runningWriteDraft("draft-running"));

    const updates = finalizeLingeringRunningToolCalls(state);

    expect(updates).toMatchObject([
      {
        messageId: "agent-msg",
        toolCallId: "draft-running",
        spec: { status: { kind: "done" } },
      },
    ]);
    expect(firstToolStatus(state)).toBe("done");
  });
});

describe("流式参数占位的自然收尾", () => {
  it("wechat_auth_start 只有 streaming-start 后 EOF 时，在 streamEnd 前下发 failed 终态", async () => {
    const { createSession, runAgentTurn } = await import("../bridge/index.js");
    const state = createSession("wechat-auth-streaming-placeholder-eof");

    qingagentStreamMock().mockImplementationOnce(async () => {
      async function* fullStream(): AsyncGenerator<unknown> {
        yield {
          type: "tool-call-input-streaming-start",
          payload: { toolName: "wechat_auth_start", toolCallId: "wechat-auth-orphan" },
        };
      }
      return {
        runId: "run-wechat-auth-orphan",
        fullStream: fullStream(),
      } as unknown as Awaited<ReturnType<typeof qingagentAgent.stream>>;
    });

    const frames = await collectFrames(runAgentTurn(state, "帮我扫码登录微信后台"));
    const terminalIndex = frames.findIndex(
      (frame) =>
        frame.kind === "toolCallUpdated" &&
        frame.data.toolCallId === "wechat-auth-orphan" &&
        frame.data.spec.status.kind === "failed",
    );
    const streamEndIndex = frames.findIndex(
      (frame) => frame.kind === "stream" && frame.data.kind === "end",
    );

    expect(terminalIndex).toBeGreaterThanOrEqual(0);
    expect(streamEndIndex).toBeGreaterThan(terminalIndex);
    expect(findToolCallSpec(state, "wechat-auth-orphan")).toMatchObject({
      status: {
        kind: "failed",
        data: { retriable: true, reason: "本轮未产出结果" },
      },
    });
  });
});
