import { describe, expect, it, vi } from "vitest";
import type { ConfirmSpec, ToolCallSpec } from "@qingagent/contract-ts";
import { ConfirmService, createSession } from "@qingagent/core";
import {
  reconcileRestoredConfirms,
  takeConfirmRecoveryFrames,
} from "../gateway/confirmRecovery";
import { emitRestoreFrames } from "../gateway/restoreFrames";

const spec: ConfirmSpec = {
  id: "confirm-recovery",
  kind: "command",
  title: "执行命令",
  say: "将执行一条需要确认的命令",
  footHint: "仅本次执行",
  primaryLabel: "执行",
  secondaryLabel: "取消",
};

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

function setup(status: "pending" | "resuming" = "pending") {
  const state = createSession(`session-recovery-${status}`);
  const toolCallId = `tool-recovery-${status}`;
  const expiresAt = new Date(Date.now() + 60_000).toISOString();
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
    runId: `run-recovery-${status}`,
    toolCallId,
    toolName: "mastra_workspace_execute_command",
    commandDigest: "digest",
    spec,
    requestedAt: new Date().toISOString(),
    expiresAt,
    status,
    ...(status === "resuming" ? { decisionId: "decision-before-crash" } : {}),
  });
  return { state, toolCallId };
}

function suspendedRun(runId: string, toolCallId: string) {
  return {
    runs: [{
      runId,
      toolCalls: [{
        toolCallId,
        toolName: "mastra_workspace_execute_command",
        requiresApproval: true,
      }],
    }],
  };
}

describe("confirm cold recovery", () => {
  it("pending metadata 与 Mastra snapshot 精确匹配时保留原卡", async () => {
    const { state, toolCallId } = setup();
    const agent = {
      listSuspendedRuns: vi.fn(async () => suspendedRun("run-recovery-pending", toolCallId)),
      declineToolCall: vi.fn(),
    };

    await reconcileRestoredConfirms(state, { agent: agent as never });

    expect(state.pendingConfirms.has(toolCallId)).toBe(true);
    expect(agent.declineToolCall).not.toHaveBeenCalled();
    expect(takeConfirmRecoveryFrames(state)).toEqual([]);
  });

  it("snapshot 缺失时 fail-closed，关闭卡且绝不 fresh-turn", async () => {
    const { state, toolCallId } = setup();
    const service = new ConfirmService({ persist: async () => undefined });
    const agent = {
      listSuspendedRuns: vi.fn(async () => ({ runs: [] })),
      declineToolCall: vi.fn(),
    };

    await reconcileRestoredConfirms(state, { agent: agent as never, service });

    expect(state.pendingConfirms.has(toolCallId)).toBe(false);
    expect(agent.declineToolCall).not.toHaveBeenCalled();
    expect([...emitRestoreFrames(state, { readOnly: true })].some(
      (frame) => frame.kind === "confirmResolved",
    )).toBe(false);
    expect(takeConfirmRecoveryFrames(state)).toContainEqual(expect.objectContaining({
      kind: "confirmResolved",
      data: expect.objectContaining({ resolution: "failed", toolCallId }),
    }));
    expect(state.chatHistory[0]?.parts[0]).toMatchObject({
      kind: "toolCall",
      data: { status: { kind: "failed" } },
    });
  });

  it("resuming 崩溃窗口只 decline，不调用 approve 或重放命令", async () => {
    const { state, toolCallId } = setup("resuming");
    const service = new ConfirmService({ persist: async () => undefined });
    const approveToolCall = vi.fn();
    const declineToolCall = vi.fn(async () => ({
      fullStream: (async function* () {
        yield { type: "finish" };
      })(),
    }));
    const agent = {
      listSuspendedRuns: vi.fn(async () => suspendedRun("run-recovery-resuming", toolCallId)),
      declineToolCall,
      approveToolCall,
    };

    await reconcileRestoredConfirms(state, { agent: agent as never, service });

    expect(approveToolCall).not.toHaveBeenCalled();
    expect(declineToolCall).toHaveBeenCalledWith(expect.objectContaining({
      runId: "run-recovery-resuming",
      toolCallId,
    }));
    expect(state.pendingConfirms.has(toolCallId)).toBe(false);
    expect(takeConfirmRecoveryFrames(state)).toContainEqual(expect.objectContaining({
      kind: "confirmResolved",
      data: expect.objectContaining({
        resolution: "failed",
        message: "上次确认后没有收到完整结果。为避免重复操作，系统没有自动重试；请查看命令输出后再决定是否重新执行。",
      }),
    }));
  });
});
