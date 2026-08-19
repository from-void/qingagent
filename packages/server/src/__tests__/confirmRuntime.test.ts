import { describe, expect, it, vi } from "vitest";
import type {
  BridgeFrame,
  Command,
  ConfirmSpec,
  ToolCallSpec,
} from "@qingagent/contract-ts";
import {
  ConfirmDecisionError,
  ConfirmService,
  SecretLeaseStore,
} from "@qingagent/core/confirm";
import { createSession } from "@qingagent/core";
import { handleConfirmDecision, handleConfirmExpiry } from "../gateway/confirmRuntime";
import { InMemoryFrameLog } from "../gateway/frameLog";
import { SessionManager } from "../gateway/sessionManager";

async function* modelStream(): AsyncGenerator<unknown> {
  yield { type: "text-delta", payload: { id: "text", text: "已处理" } };
}

function runningTool(id: string): ToolCallSpec {
  return {
    id,
    name: "mastra_workspace_execute_command",
    render: { kind: "chatInline" },
    status: { kind: "running", data: { progressPct: null, etaSec: null } },
    body: { kind: "generic", data: { argsJson: "" } },
    result: null,
  };
}

function setupPending(spec: ConfirmSpec) {
  const state = createSession(`session-${spec.id}`);
  const toolCallId = `tool-${spec.id}`;
  state.threadId = state.sessionId;
  state.chatHistory.push({
    id: "agent-message",
    role: { kind: "agent" },
    ts: new Date().toISOString(),
    parts: [{ kind: "toolCall", data: runningTool(toolCallId) }],
    chips: null,
  });
  state.pendingConfirms.set(toolCallId, {
    confirmId: spec.id,
    runId: `run-${spec.id}`,
    toolCallId,
    toolName: "mastra_workspace_execute_command",
    commandDigest: "digest",
    spec,
    requestedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    status: "pending",
  });
  return { state, toolCallId };
}

function commandConfirmSpec(id: string): ConfirmSpec {
  return {
    id,
    kind: "command",
    title: "执行命令",
    say: "将执行一条命令",
    footHint: "仅本次执行",
    primaryLabel: "执行",
    secondaryLabel: "取消",
  };
}

async function collect(generator: AsyncGenerator<BridgeFrame>): Promise<BridgeFrame[]> {
  const frames: BridgeFrame[] = [];
  for await (const frame of generator) frames.push(frame);
  return frames;
}

describe("confirm runtime", () => {
  it("external lease 在 runtime 起轮前二查，确认状态与模型调用均保持不变", async () => {
    const spec = commandConfirmSpec("confirm-external-lease-gate");
    const { state, toolCallId } = setupPending(spec);
    state.externalBusyLease = {
      principalId: "external:test-instance",
      turnId: "turn-external-lease-gate",
      expiresAt: Date.now() + 60_000,
      startedFromEmpty: false,
      directCommitCount: 0,
    };
    const agent = {
      approveToolCall: vi.fn(),
      declineToolCall: vi.fn(),
    };
    const service = new ConfirmService({ persist: async () => undefined });

    await expect(collect(handleConfirmDecision({
      sessionId: state.sessionId,
      toolCallId,
      decisionId: "decision-external-lease-gate",
      decision: { id: spec.id, accepted: true },
      hasSecretValue: false,
    }, {
      service,
      agent: agent as never,
      getSession: async () => state,
    }))).rejects.toEqual(expect.objectContaining<Partial<ConfirmDecisionError>>({
      code: "conflict",
      message: "Agent 正在编辑，稍后再试",
    }));

    expect(state.pendingConfirms.get(toolCallId)?.status).toBe("pending");
    expect(agent.approveToolCall).not.toHaveBeenCalled();
    expect(agent.declineToolCall).not.toHaveBeenCalled();
  });

  it("accepted 精确调用 approveToolCall，option/accepted/确认文案不进入模型恢复参数", async () => {
    const optionSentinel = "OPTION_SENTINEL_7ca1";
    const confirmCopySentinel = "CONFIRM_COPY_SENTINEL_7ca1";
    const spec: ConfirmSpec = {
      id: "confirm-option",
      kind: "command",
      title: "执行命令",
      say: confirmCopySentinel,
      widget: {
        type: "options",
        options: [{ value: optionSentinel, label: "继续" }],
      },
      footHint: "仅一次",
      primaryLabel: "执行",
      secondaryLabel: "取消",
    };
    const { state, toolCallId } = setupPending(spec);
    const persisted: string[] = [];
    const service = new ConfirmService({
      persist: async (current) => {
        persisted.push(JSON.stringify([...current.pendingConfirms.values()]));
      },
    });
    let captured: Record<string, unknown> | null = null;
    const agent = {
      approveToolCall: vi.fn(async (options: Record<string, unknown>) => {
        captured = options;
        return { runId: `run-${spec.id}`, fullStream: modelStream() };
      }),
      declineToolCall: vi.fn(),
    };

    const frames = await collect(handleConfirmDecision({
      sessionId: state.sessionId,
      toolCallId,
      decisionId: "decision-option",
      decision: { id: spec.id, accepted: true, optionValue: optionSentinel },
      hasSecretValue: false,
    }, {
      service,
      agent: agent as never,
      getSession: async () => state,
    }));

    expect(agent.approveToolCall).toHaveBeenCalledTimes(1);
    expect(agent.declineToolCall).not.toHaveBeenCalled();
    const capturedOptions = captured as Record<string, unknown> | null;
    expect(capturedOptions).toMatchObject({ runId: `run-${spec.id}`, toolCallId });
    expect(capturedOptions && "accepted" in capturedOptions).toBe(false);
    expect(capturedOptions && "optionValue" in capturedOptions).toBe(false);
    const requestContext = capturedOptions?.requestContext as { get: (key: string) => unknown };
    expect(requestContext.get("accepted")).toBeUndefined();
    expect(requestContext.get("optionValue")).toBeUndefined();
    expect(requestContext.get("confirmSpec")).toBeUndefined();
    expect(JSON.stringify(capturedOptions)).not.toContain(optionSentinel);
    expect(JSON.stringify(capturedOptions)).not.toContain(confirmCopySentinel);
    expect(frames).toContainEqual(expect.objectContaining({
      kind: "confirmResolved",
      data: expect.objectContaining({ id: spec.id, toolCallId, resolution: "accepted" }),
    }));
    expect(persisted.some((value) => value.includes(optionSentinel))).toBe(true);
  });

  it("secret sentinel 不进恢复参数/Frame/持久化，rejected 精确调用 decline", async () => {
    const secretSentinel = "SECRET_SENTINEL_RUNTIME_d83a";
    const spec: ConfirmSpec = {
      id: "confirm-secret-runtime",
      kind: "connect",
      title: "连接",
      say: "请输入令牌",
      widget: { type: "secretInput", placeholder: "令牌" },
      footHint: "只用于连接",
      primaryLabel: "连接",
      secondaryLabel: "取消",
    };
    const { state, toolCallId } = setupPending(spec);
    const secrets = new SecretLeaseStore();
    const persisted: string[] = [];
    const service = new ConfirmService({
      secrets,
      persist: async (current) => {
        persisted.push(JSON.stringify([...current.pendingConfirms.values()]));
      },
    });
    service.stageSecret(state, { confirmId: spec.id, toolCallId, value: secretSentinel });
    let captured: Record<string, unknown> | null = null;
    const agent = {
      approveToolCall: vi.fn(async (options: Record<string, unknown>) => {
        captured = options;
        return { runId: `run-${spec.id}`, fullStream: modelStream() };
      }),
      declineToolCall: vi.fn(async (options: Record<string, unknown>) => {
        captured = options;
        return { runId: `run-${spec.id}`, fullStream: modelStream() };
      }),
    };
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const frames = await collect(handleConfirmDecision({
      sessionId: state.sessionId,
      toolCallId,
      decisionId: "decision-secret",
      decision: { id: spec.id, accepted: true },
      hasSecretValue: true,
    }, {
      service,
      agent: agent as never,
      getSession: async () => state,
    }));
    expect(agent.approveToolCall).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(captured)).not.toContain(secretSentinel);
    expect(JSON.stringify(frames)).not.toContain(secretSentinel);
    const frameLog = new InMemoryFrameLog();
    frames.forEach((frame) => frameLog.append(state.sessionId, frame));
    expect(JSON.stringify(frameLog.readFrom(state.sessionId, 0))).not.toContain(secretSentinel);
    expect(persisted.join("\n")).not.toContain(secretSentinel);
    expect(JSON.stringify(consoleSpy.mock.calls)).not.toContain(secretSentinel);
    expect(secrets.take(state, { confirmId: spec.id, toolCallId })).toBeNull();
    consoleSpy.mockRestore();

    const rejected = setupPending({ ...spec, id: "confirm-reject-runtime", widget: undefined });
    const rejectService = new ConfirmService({ persist: async () => undefined });
    await collect(handleConfirmDecision({
      sessionId: rejected.state.sessionId,
      toolCallId: rejected.toolCallId,
      decisionId: "decision-reject",
      decision: { id: "confirm-reject-runtime", accepted: false },
      hasSecretValue: false,
    }, {
      service: rejectService,
      agent: agent as never,
      getSession: async () => rejected.state,
    }));
    expect(agent.declineToolCall).toHaveBeenCalledWith(expect.objectContaining({
      runId: "run-confirm-reject-runtime",
      toolCallId: rejected.toolCallId,
    }));
  });

  it("在线过期只 decline 并关闭卡，绝不 approve", async () => {
    const expiredSpec: ConfirmSpec = {
      id: "confirm-expired-runtime",
      kind: "command",
      title: "执行命令",
      say: "将执行一条命令",
      footHint: "仅本次执行",
      primaryLabel: "执行",
      secondaryLabel: "取消",
    };
    const { state, toolCallId } = setupPending(expiredSpec);
    state.pendingConfirms.get(toolCallId)!.expiresAt = new Date(Date.now() - 1).toISOString();
    const service = new ConfirmService({ persist: async () => undefined });
    const agent = {
      approveToolCall: vi.fn(),
      declineToolCall: vi.fn(async () => ({
        fullStream: (async function* () {
          yield { type: "finish" };
        })(),
      })),
    };

    const frames = await collect(handleConfirmExpiry(state.sessionId, toolCallId, {
      service,
      agent: agent as never,
      getSession: async () => state,
    }));

    expect(agent.approveToolCall).not.toHaveBeenCalled();
    expect(agent.declineToolCall).toHaveBeenCalledWith(expect.objectContaining({
      runId: "run-confirm-expired-runtime",
      toolCallId,
    }));
    expect(state.pendingConfirms.has(toolCallId)).toBe(false);
    expect(frames).toContainEqual(expect.objectContaining({
      kind: "confirmResolved",
      data: expect.objectContaining({ resolution: "expired", toolCallId }),
    }));
    expect(frames).toContainEqual(expect.objectContaining({
      kind: "confirmResolved",
      data: expect.objectContaining({
        message: "这张确认卡已过期，命令没有执行。请重新确认。",
      }),
    }));
  });

  it("过期 decline 永不 resolve 时，停止可中止局部 controller，后续 send/cancel 不被 Actor 永久堵塞", async () => {
    const expiredSpec: ConfirmSpec = {
      id: "confirm-expiry-hang",
      kind: "command",
      title: "执行命令",
      say: "将执行一条命令",
      footHint: "仅本次执行",
      primaryLabel: "执行",
      secondaryLabel: "取消",
    };
    const { state, toolCallId } = setupPending(expiredSpec);
    state.pendingConfirms.get(toolCallId)!.expiresAt =
      new Date(Date.now() - 1).toISOString();
    const service = new ConfirmService({ persist: async () => undefined });
    let declineSignal: AbortSignal | undefined;
    const agent = {
      approveToolCall: vi.fn(),
      declineToolCall: vi.fn((options: { abortSignal?: AbortSignal }) => {
        declineSignal = options.abortSignal;
        return new Promise<never>(() => undefined);
      }),
    };
    const executed: Command["kind"][] = [];
    const manager = new SessionManager({
      handleCommand: async function* (command) {
        executed.push(command.kind);
        yield {
          kind: "sessionMeta",
          data: { sessionId: state.sessionId, title: command.kind },
        };
      },
      abortSession: () => state._abortController?.abort("user_abort"),
      cleanupSession: vi.fn(),
    });

    const expiry = manager.runExclusive(
      state.sessionId,
      () => handleConfirmExpiry(state.sessionId, toolCallId, {
        service,
        agent: agent as never,
        getSession: async () => state,
        expiryTimeoutMs: 10_000,
      }),
    );
    await vi.waitFor(() => expect(agent.declineToolCall).toHaveBeenCalledTimes(1));
    expect(state._abortController?.signal).toBe(declineSignal);

    const cancel = manager.submit(state.sessionId, {
      command: {
        kind: "cancelStream",
        data: { sessionId: state.sessionId },
      },
    });
    await expect(expiry).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({
        frame: expect.objectContaining({ kind: "confirmResolved" }),
      }),
    ]));
    await expect(cancel).resolves.toHaveLength(1);
    await expect(manager.submit(state.sessionId, {
      command: {
        kind: "sendMessage",
        data: {
          sessionId: state.sessionId,
          text: "继续",
          skills: [],
          chips: [],
          fileIds: [],
        },
      },
    })).resolves.toHaveLength(1);

    expect(declineSignal?.aborted).toBe(true);
    expect(executed).toEqual(["cancelStream", "sendMessage"]);
    expect(state.pendingConfirms.has(toolCallId)).toBe(false);
    expect(state._abortController).toBeNull();
    expect(state._activeTurnPromise).toBeNull();
    await manager.disposeAll();
  });

  it("过期 decline 已返回但 fullStream 永不结束时，墙钟超时仍 fail-closed 释放会话", async () => {
    const expiredSpec: ConfirmSpec = {
      id: "confirm-expiry-stream-hang",
      kind: "command",
      title: "执行命令",
      say: "将执行一条命令",
      footHint: "仅本次执行",
      primaryLabel: "执行",
      secondaryLabel: "取消",
    };
    const { state, toolCallId } = setupPending(expiredSpec);
    state.pendingConfirms.get(toolCallId)!.expiresAt =
      new Date(Date.now() - 1).toISOString();
    const service = new ConfirmService({ persist: async () => undefined });
    let declineSignal: AbortSignal | undefined;
    const agent = {
      approveToolCall: vi.fn(),
      declineToolCall: vi.fn(async (options: { abortSignal?: AbortSignal }) => {
        declineSignal = options.abortSignal;
        return {
          fullStream: {
            [Symbol.asyncIterator]() {
              return {
                next: () => new Promise<IteratorResult<unknown>>(() => undefined),
                return: async () => ({ done: true, value: undefined }),
              };
            },
          },
        };
      }),
    };

    const startedAt = Date.now();
    const frames = await collect(handleConfirmExpiry(state.sessionId, toolCallId, {
      service,
      agent: agent as never,
      getSession: async () => state,
      expiryTimeoutMs: 25,
    }));

    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(declineSignal?.aborted).toBe(true);
    expect(state.pendingConfirms.has(toolCallId)).toBe(false);
    expect(state._abortController).toBeNull();
    expect(state._activeTurnPromise).toBeNull();
    expect(frames).toContainEqual(expect.objectContaining({
      kind: "confirmResolved",
      data: expect.objectContaining({ resolution: "expired", toolCallId }),
    }));
  });

  it("确认恢复 approveToolCall 永不 resolve 时，stop 可中止且后续 send 不被 Actor 堵塞", async () => {
    const spec: ConfirmSpec = {
      id: "confirm-resume-agent-hang",
      kind: "command",
      title: "执行命令",
      say: "将执行一条命令",
      footHint: "仅本次执行",
      primaryLabel: "执行",
      secondaryLabel: "取消",
    };
    const { state, toolCallId } = setupPending(spec);
    const service = new ConfirmService({ persist: async () => undefined });
    let approveSignal: AbortSignal | undefined;
    const agent = {
      approveToolCall: vi.fn((options: { abortSignal?: AbortSignal }) => {
        approveSignal = options.abortSignal;
        return new Promise<never>(() => undefined);
      }),
      declineToolCall: vi.fn(),
    };
    const executed: Command["kind"][] = [];
    const manager = new SessionManager({
      handleCommand: async function* (command) {
        executed.push(command.kind);
        yield {
          kind: "sessionMeta",
          data: { sessionId: state.sessionId, title: command.kind },
        };
      },
      abortSession: () => state._abortController?.abort("user_abort"),
      cleanupSession: vi.fn(),
    });

    const resume = manager.runExclusive(
      state.sessionId,
      () => handleConfirmDecision({
        sessionId: state.sessionId,
        toolCallId,
        decisionId: "decision-resume-agent-hang",
        decision: { id: spec.id, accepted: true },
        hasSecretValue: false,
      }, {
        service,
        agent: agent as never,
        getSession: async () => state,
        persistSession: async () => undefined,
        resumeTimeoutMs: 10_000,
      }),
    );
    await vi.waitFor(() => expect(agent.approveToolCall).toHaveBeenCalledTimes(1));
    expect(state._abortController?.signal).toBe(approveSignal);

    const cancel = manager.submit(state.sessionId, {
      command: {
        kind: "cancelStream",
        data: { sessionId: state.sessionId },
      },
    });
    await expect(resume).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({
        frame: expect.objectContaining({
          kind: "confirmResolved",
          data: expect.objectContaining({ resolution: "failed" }),
        }),
      }),
    ]));
    await expect(cancel).resolves.toHaveLength(1);
    await expect(manager.submit(state.sessionId, {
      command: {
        kind: "sendMessage",
        data: {
          sessionId: state.sessionId,
          text: "继续",
          skills: [],
          chips: [],
          fileIds: [],
        },
      },
    })).resolves.toHaveLength(1);

    expect(approveSignal?.aborted).toBe(true);
    expect(executed).toEqual(["cancelStream", "sendMessage"]);
    expect(state.pendingConfirms.has(toolCallId)).toBe(false);
    expect(state._abortController).toBeNull();
    expect(state._activeTurnPromise).toBeNull();
    await manager.disposeAll();
  });

  it("approveToolCall 已提交但返回超时时按执行结果未知收口", async () => {
    const spec = commandConfirmSpec("confirm-resume-approve-timeout");
    const { state, toolCallId } = setupPending(spec);
    const service = new ConfirmService({ persist: async () => undefined });
    const agent = {
      approveToolCall: vi.fn(() => new Promise<never>(() => undefined)),
      declineToolCall: vi.fn(),
    };

    const frames = await collect(handleConfirmDecision({
      sessionId: state.sessionId,
      toolCallId,
      decisionId: "decision-resume-approve-timeout",
      decision: { id: spec.id, accepted: true },
      hasSecretValue: false,
    }, {
      service,
      agent: agent as never,
      getSession: async () => state,
      persistSession: async () => undefined,
      resumeTimeoutMs: 25,
    }));

    expect(agent.approveToolCall).toHaveBeenCalledTimes(1);
    expect(frames).toContainEqual(expect.objectContaining({
      kind: "confirmResolved",
      data: expect.objectContaining({
        resolution: "failed",
        message: "确认已提交，但没有收到命令结果。为避免重复操作没有自动重试，请先查看命令输出再决定是否重来。",
      }),
    }));
    expect(JSON.stringify(frames)).not.toContain("命令未执行");
  });

  it("恢复流被整体墙掐死时按超时如实收口,并把真实归因写给模型", async () => {
    const spec = commandConfirmSpec("confirm-resume-wall-timeout");
    const { state, toolCallId } = setupPending(spec);
    const service = new ConfirmService({ persist: async () => undefined });
    const agent = {
      approveToolCall: vi.fn(async () => ({
        runId: `run-${spec.id}`,
        // 命令一直不产帧:超时必须由恢复墙收口,而不是变成含糊的"已中止"。
        fullStream: (async function* () {
          await new Promise(() => undefined);
          yield { type: "finish", payload: {} };
        })(),
      })),
      declineToolCall: vi.fn(),
    };

    const frames = await collect(handleConfirmDecision({
      sessionId: state.sessionId,
      toolCallId,
      decisionId: "decision-resume-wall-timeout",
      decision: { id: spec.id, accepted: true },
      hasSecretValue: false,
    }, {
      service,
      agent: agent as never,
      getSession: async () => state,
      persistSession: async () => undefined,
      resumeTimeoutMs: 30,
    }));

    const failure = frames.find(
      (frame) => frame.kind === "confirmResolved" && frame.data.resolution === "failed",
    );
    expect(failure).toBeDefined();
    const message = failure?.kind === "confirmResolved" ? failure.data.message ?? "" : "";
    expect(message).toContain("超过本次上限");
    expect(message).toContain("后台运行");
    // 用户已经点过确认:回传模型的说明必须堵死"你没及时点确认"这类瞎猜。
    const note = state.messages.at(-1);
    expect(note?.role).toBe("system");
    const noteText = typeof note?.content === "string" ? note.content : "";
    expect(noteText).toContain("用户已经点了确认");
    expect(noteText).toContain("不要说是用户取消");
  });

  it("beginDecision 永不 resolve 时，stop 可中止前置阶段且后续命令不被 Actor 堵塞", async () => {
    const spec = commandConfirmSpec("confirm-begin-decision-hang");
    const { state, toolCallId } = setupPending(spec);
    const service = new ConfirmService({ persist: async () => undefined });
    const beginDecision = vi.spyOn(service, "beginDecision")
      .mockImplementation(() => new Promise<never>(() => undefined));
    const executed: Command["kind"][] = [];
    const manager = new SessionManager({
      handleCommand: async function* (command) {
        executed.push(command.kind);
        yield {
          kind: "sessionMeta",
          data: { sessionId: state.sessionId, title: command.kind },
        };
      },
      abortSession: () => state._abortController?.abort("user_abort"),
      cleanupSession: vi.fn(),
    });

    const decision = manager.runExclusive(
      state.sessionId,
      () => handleConfirmDecision({
        sessionId: state.sessionId,
        toolCallId,
        decisionId: "decision-begin-hang",
        decision: { id: spec.id, accepted: true },
        hasSecretValue: false,
      }, {
        service,
        getSession: async () => state,
        resumeTimeoutMs: 10_000,
      }),
    );
    await vi.waitFor(() => {
      expect(beginDecision).toHaveBeenCalledTimes(1);
      expect(state._abortController).not.toBeNull();
    });

    const cancel = manager.submit(state.sessionId, {
      command: {
        kind: "cancelStream",
        data: { sessionId: state.sessionId },
      },
    });
    await expect(decision).rejects.toThrow();
    await expect(cancel).resolves.toHaveLength(1);
    await expect(manager.submit(state.sessionId, {
      command: {
        kind: "sendMessage",
        data: {
          sessionId: state.sessionId,
          text: "继续",
          skills: [],
          chips: [],
          fileIds: [],
        },
      },
    })).resolves.toHaveLength(1);

    expect(executed).toEqual(["cancelStream", "sendMessage"]);
    expect(state.pendingConfirms.has(toolCallId)).toBe(true);
    expect(state._abortController).toBeNull();
    expect(state._activeTurnPromise).toBeNull();
    await manager.disposeAll();
  });

  it("onAccepted 永不 resolve 时，在墙钟上限内关闭确认并释放会话所有权", async () => {
    const spec = commandConfirmSpec("confirm-on-accepted-hang");
    const { state, toolCallId } = setupPending(spec);
    const service = new ConfirmService({ persist: async () => undefined });
    const buildTools = vi.fn(async () => ({
      sessionScoped: {},
      capabilityTools: {},
    }));
    const startedAt = Date.now();

    const frames = await collect(handleConfirmDecision({
      sessionId: state.sessionId,
      toolCallId,
      decisionId: "decision-on-accepted-hang",
      decision: { id: spec.id, accepted: true },
      hasSecretValue: false,
    }, {
      service,
      getSession: async () => state,
      onAccepted: () => new Promise<never>(() => undefined),
      buildResumeTools: buildTools,
      resumeTimeoutMs: 25,
      persistTimeoutMs: 25,
    }));

    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(buildTools).not.toHaveBeenCalled();
    expect(state.pendingConfirms.has(toolCallId)).toBe(false);
    expect(state._abortController).toBeNull();
    expect(state._activeTurnPromise).toBeNull();
    expect(frames).toContainEqual(expect.objectContaining({
      kind: "confirmResolved",
      data: expect.objectContaining({ toolCallId, resolution: "failed" }),
    }));
  });

  it("buildResumeTools 永不 resolve 时，在墙钟上限内 fail-closed 且不调用 agent", async () => {
    const spec = commandConfirmSpec("confirm-build-tools-hang");
    const { state, toolCallId } = setupPending(spec);
    const service = new ConfirmService({ persist: async () => undefined });
    const agent = {
      approveToolCall: vi.fn(),
      declineToolCall: vi.fn(),
    };
    const startedAt = Date.now();

    const frames = await collect(handleConfirmDecision({
      sessionId: state.sessionId,
      toolCallId,
      decisionId: "decision-build-tools-hang",
      decision: { id: spec.id, accepted: true },
      hasSecretValue: false,
    }, {
      service,
      agent: agent as never,
      getSession: async () => state,
      buildResumeTools: () => new Promise<never>(() => undefined),
      resumeTimeoutMs: 25,
      persistTimeoutMs: 25,
    }));

    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(agent.approveToolCall).not.toHaveBeenCalled();
    expect(state.pendingConfirms.has(toolCallId)).toBe(false);
    expect(state._abortController).toBeNull();
    expect(state._activeTurnPromise).toBeNull();
    expect(frames).toContainEqual(expect.objectContaining({
      kind: "confirmResolved",
      data: expect.objectContaining({ toolCallId, resolution: "failed" }),
    }));
  });

  it("确认过期终态持久化永不 resolve 时，内存先终态化且会话清理不死锁", async () => {
    const spec: ConfirmSpec = {
      id: "confirm-expiry-persist-hang",
      kind: "command",
      title: "执行命令",
      say: "将执行一条命令",
      footHint: "仅本次执行",
      primaryLabel: "执行",
      secondaryLabel: "取消",
    };
    const { state, toolCallId } = setupPending(spec);
    state.pendingConfirms.get(toolCallId)!.expiresAt =
      new Date(Date.now() - 1).toISOString();
    const never = () => new Promise<void>(() => undefined);
    const service = new ConfirmService({
      persist: async (_current, reason) => {
        if (reason === "confirm:expired") await never();
      },
    });
    const agent = {
      approveToolCall: vi.fn(),
      declineToolCall: vi.fn(async () => ({
        fullStream: (async function* () {
          yield { type: "finish" };
        })(),
      })),
    };

    const startedAt = Date.now();
    const frames = await collect(handleConfirmExpiry(state.sessionId, toolCallId, {
      service,
      agent: agent as never,
      getSession: async () => state,
      persistTimeoutMs: 25,
    }));

    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(state.pendingConfirms.has(toolCallId)).toBe(false);
    expect(state._abortController).toBeNull();
    expect(state._activeTurnPromise).toBeNull();
    expect(state._confirmPersistenceDirtyReasons).toContain("confirm:expired");
    expect(frames).toContainEqual(expect.objectContaining({
      kind: "confirmResolved",
      data: expect.objectContaining({ resolution: "expired" }),
    }));
  });

  it("确认恢复终态与 finally 持久化都永不 resolve 时，completion/ownership 仍先释放", async () => {
    const spec: ConfirmSpec = {
      id: "confirm-resume-persist-hang",
      kind: "command",
      title: "执行命令",
      say: "将执行一条命令",
      footHint: "仅本次执行",
      primaryLabel: "执行",
      secondaryLabel: "取消",
    };
    const { state, toolCallId } = setupPending(spec);
    const never = () => new Promise<void>(() => undefined);
    const service = new ConfirmService({
      persist: async (_current, reason) => {
        if (reason === "confirm:accepted") await never();
      },
    });
    const agent = {
      approveToolCall: vi.fn(async () => ({
        runId: "run-confirm-resume-persist-hang",
        fullStream: modelStream(),
      })),
      declineToolCall: vi.fn(),
    };

    const startedAt = Date.now();
    const frames = await collect(handleConfirmDecision({
      sessionId: state.sessionId,
      toolCallId,
      decisionId: "decision-resume-persist-hang",
      decision: { id: spec.id, accepted: true },
      hasSecretValue: false,
    }, {
      service,
      agent: agent as never,
      getSession: async () => state,
      persistSession: never,
      persistTimeoutMs: 25,
    }));

    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(state.pendingConfirms.has(toolCallId)).toBe(false);
    expect(state._abortController).toBeNull();
    expect(state._activeTurnPromise).toBeNull();
    expect(state._turnOwner).toBeNull();
    expect(state._confirmPersistenceDirtyReasons).toEqual(new Set([
      "confirm:accepted",
      "confirm:runtime_finally",
    ]));
    expect(frames).toContainEqual(expect.objectContaining({
      kind: "confirmResolved",
      data: expect.objectContaining({ resolution: "accepted" }),
    }));
  });

  it("关闭期间确认恢复先内存终态化，再在有界持久化后完成 disposeAll 清理", async () => {
    const closeSpec: ConfirmSpec = {
      id: "confirm-close-resume",
      kind: "command",
      title: "执行命令",
      say: "将执行一条命令",
      footHint: "仅本次执行",
      primaryLabel: "执行",
      secondaryLabel: "取消",
    };
    const { state, toolCallId } = setupPending(closeSpec);
    const persistReasons: string[] = [];
    const service = new ConfirmService({
      persist: async (_current, reason) => {
        persistReasons.push(reason);
      },
    });
    let streamFinallyRan = false;
    const agent = {
      approveToolCall: vi.fn(async (options: { abortSignal: AbortSignal }) => ({
        runId: "run-confirm-close-resume",
        fullStream: (async function* () {
          try {
            await new Promise<void>((resolve) => {
              const onAbort = () => resolve();
              options.abortSignal.addEventListener("abort", onAbort, { once: true });
              if (options.abortSignal.aborted) onAbort();
            });
          } finally {
            streamFinallyRan = true;
          }
        })(),
      })),
      declineToolCall: vi.fn(),
    };
    const cleanupSnapshots: Array<{
      pending: number;
      active: boolean;
      status: string | undefined;
    }> = [];
    const terminalPersistSnapshots: Array<{
      reason: string;
      pending: number;
      status: string | undefined;
    }> = [];
    const manager = new SessionManager({
      handleCommand: async function* () {
        return;
      },
      abortSession: () => state._abortController?.abort("shutdown"),
      cleanupSession: () => {
        const part = state.chatHistory[0]?.parts[0];
        cleanupSnapshots.push({
          pending: state.pendingConfirms.size,
          active: state._activeTurnPromise !== null,
          status: part?.kind === "toolCall" ? part.data.status.kind : undefined,
        });
      },
      disposeWaitTimeoutMs: 1_000,
    });

    const running = manager.runExclusive(
      state.sessionId,
      () => handleConfirmDecision({
        sessionId: state.sessionId,
        toolCallId,
        decisionId: "decision-close-resume",
        decision: { id: closeSpec.id, accepted: true },
        hasSecretValue: false,
      }, {
        service,
        agent: agent as never,
        getSession: async () => state,
        persistSession: async (current, reason) => {
          const part = current.chatHistory[0]?.parts[0];
          terminalPersistSnapshots.push({
            reason,
            pending: current.pendingConfirms.size,
            status: part?.kind === "toolCall"
              ? part.data.status.kind
              : undefined,
          });
        },
      }),
    );
    void running.catch(() => undefined);
    await vi.waitFor(() => {
      expect(agent.approveToolCall).toHaveBeenCalledTimes(1);
      expect(state._activeTurnPromise).not.toBeNull();
    });

    await manager.disposeAll();
    await expect(running).rejects.toThrow("Session actor disposed");

    expect(streamFinallyRan).toBe(true);
    expect(persistReasons).toContain("confirm:resuming");
    expect(persistReasons).toContain("confirm:failed");
    expect(terminalPersistSnapshots).toEqual([{
      reason: "confirm:runtime_finally",
      pending: 0,
      status: "failed",
    }]);
    expect(cleanupSnapshots).toEqual([{
      pending: 0,
      active: false,
      status: "failed",
    }]);
    expect(state._activeTurnPromise).toBeNull();
  });

  it("过期 decline 永不结束时在硬时限内 fail-closed 收口并标记可重试", async () => {
    const expiredSpec: ConfirmSpec = {
      id: "confirm-expired-hung-decline",
      kind: "command",
      title: "执行命令",
      say: "将执行一条命令",
      footHint: "仅本次执行",
      primaryLabel: "执行",
      secondaryLabel: "取消",
    };
    const { state, toolCallId } = setupPending(expiredSpec);
    state.pendingConfirms.get(toolCallId)!.expiresAt =
      new Date(Date.now() - 1).toISOString();
    const service = new ConfirmService({ persist: async () => undefined });
    let declineSignal: AbortSignal | undefined;
    const agent = {
      approveToolCall: vi.fn(),
      declineToolCall: vi.fn((options: { abortSignal?: AbortSignal }) => {
        declineSignal = options.abortSignal;
        return new Promise<never>(() => undefined);
      }),
    };

    const frames = await collect(handleConfirmExpiry(state.sessionId, toolCallId, {
      service,
      agent: agent as never,
      getSession: async () => state,
      declineTimeoutMs: 5,
    }));

    expect(declineSignal?.aborted).toBe(true);
    expect(state.pendingConfirms.has(toolCallId)).toBe(false);
    expect(state._abortController).toBeNull();
    expect(state._activeTurnPromise).toBeNull();
    expect(frames).toContainEqual(expect.objectContaining({
      kind: "toolCallUpdated",
      data: expect.objectContaining({
        toolCallId,
        spec: expect.objectContaining({
          status: {
            kind: "failed",
            data: expect.objectContaining({ retriable: true }),
          },
        }),
      }),
    }));
    expect(frames).toContainEqual(expect.objectContaining({
      kind: "confirmResolved",
      data: expect.objectContaining({
        resolution: "expired",
        message: "这张确认卡已过期，命令没有执行。请重新确认。",
      }),
    }));
  });

  it("重复 decisionId 幂等且不二次执行，冲突 decisionId fail-closed", async () => {
    const repeatSpec: ConfirmSpec = {
      id: "confirm-repeat-runtime",
      kind: "command",
      title: "执行命令",
      say: "将执行一条命令",
      footHint: "仅本次执行",
      primaryLabel: "执行",
      secondaryLabel: "取消",
    };
    const { state, toolCallId } = setupPending(repeatSpec);
    const service = new ConfirmService({ persist: async () => undefined });
    const agent = {
      approveToolCall: vi.fn(async () => ({
        runId: "run-confirm-repeat-runtime",
        fullStream: modelStream(),
      })),
      declineToolCall: vi.fn(),
    };
    const submission = {
      sessionId: state.sessionId,
      toolCallId,
      decisionId: "decision-repeat",
      decision: { id: repeatSpec.id, accepted: true as const },
      hasSecretValue: false,
    };

    await collect(handleConfirmDecision(submission, {
      service,
      agent: agent as never,
      getSession: async () => state,
    }));
    expect(await collect(handleConfirmDecision(submission, {
      service,
      agent: agent as never,
      getSession: async () => state,
    }))).toEqual([]);
    expect(agent.approveToolCall).toHaveBeenCalledTimes(1);

    await expect(collect(handleConfirmDecision({
      ...submission,
      decisionId: "decision-conflict",
      decision: { id: repeatSpec.id, accepted: false },
    }, {
      service,
      agent: agent as never,
      getSession: async () => state,
    }))).rejects.toMatchObject({ code: "conflict" });
    expect(agent.approveToolCall).toHaveBeenCalledTimes(1);
    expect(agent.declineToolCall).not.toHaveBeenCalled();
  });
});
