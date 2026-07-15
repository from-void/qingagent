import { describe, expect, it, vi } from "vitest";
import type { BridgeFrame, ConfirmSpec, ToolCallSpec } from "@qingagent/contract-ts";
import { ConfirmService, SecretLeaseStore } from "@qingagent/core/confirm";
import { createSession } from "@qingagent/core";
import { handleConfirmDecision, handleConfirmExpiry } from "../gateway/confirmRuntime";
import { InMemoryFrameLog } from "../gateway/frameLog";

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

async function collect(generator: AsyncGenerator<BridgeFrame>): Promise<BridgeFrame[]> {
  const frames: BridgeFrame[] = [];
  for await (const frame of generator) frames.push(frame);
  return frames;
}

describe("confirm runtime", () => {
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
