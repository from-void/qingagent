import { describe, expect, it, vi } from "vitest";
import type { BridgeFrame } from "@qingagent/contract-ts";
import { createSession } from "../session/sessionState.js";
import { ConfirmService } from "../confirm/confirmService.js";
import { processAgentStream } from "../agent-run/processAgentStream.js";
import {
  cancelConfirmedCommand,
  resumeConfirmDecision,
} from "../agent-run/confirmResume.js";
import {
  createAgentStreamTurnContext,
  type ProcessOutcome,
} from "../agent-run/agentStreamTurnContext.js";
import { handleApprovalEvent } from "../agent-run/agentStreamApproval.js";
import type { AgentStreamEvent } from "../agent-run/agentStreamEvents.js";
import { consumeApprovalProof } from "../confirm/approvalProof.js";
import { REQUEST_CREDENTIAL_ACCESS_TOOL } from "../confirm/credentialAccessConfirmation.js";

async function* events(...items: unknown[]): AsyncGenerator<unknown> {
  for (const item of items) yield item;
}

async function collect(generator: AsyncGenerator<BridgeFrame>): Promise<BridgeFrame[]> {
  const frames: BridgeFrame[] = [];
  for await (const frame of generator) frames.push(frame);
  return frames;
}

async function collectWithOutcome(
  generator: AsyncGenerator<BridgeFrame, ProcessOutcome>,
): Promise<{ frames: BridgeFrame[]; outcome: ProcessOutcome }> {
  const frames: BridgeFrame[] = [];
  for (;;) {
    const next = await generator.next();
    if (next.done) return { frames, outcome: next.value };
    frames.push(next.value);
  }
}

function approval(
  toolCallId: string,
  command: string,
  toolName = "mastra_workspace_execute_command",
): AgentStreamEvent {
  return {
    type: "tool-call-approval",
    runId: "run-confirm",
    payload: { toolCallId, toolName, args: { command } },
  };
}

function credentialApproval(toolCallId: string): AgentStreamEvent {
  return {
    type: "tool-call-approval",
    runId: "run-confirm",
    payload: {
      toolCallId,
      toolName: REQUEST_CREDENTIAL_ACCESS_TOOL,
      args: { path: "~/.fakecli", reason: "假 CLI 要读已有的登录" },
    },
  };
}

describe("processAgentStream tool-call-approval", () => {
  it("持久化成功后发 confirmRequested，并保留 running command card", async () => {
    const state = createSession("approval-stream-one");
    const persistReasons: string[] = [];
    const service = new ConfirmService({
      persist: async (_state, reason) => { persistReasons.push(reason); },
      createId: () => "confirm-one",
    });
    const frames = await collect(processAgentStream(
      events(approval("tool-one", "mv draft.txt final.txt")),
      {
        state,
        agentMessageId: "agent-message",
        streamId: "stream-confirm",
        runId: "run-confirm",
        confirmService: service,
      },
    ));

    expect(persistReasons).toContain("confirm:requested");
    expect(frames).toContainEqual(expect.objectContaining({
      kind: "confirmRequested",
      data: expect.objectContaining({ toolCallId: "tool-one" }),
    }));
    expect(frames).toContainEqual({
      kind: "docStateChanged",
      data: { state: { kind: "empty" }, activeOverlay: "confirm", agentBusy: false },
    });
    expect(state.pendingConfirms.get("tool-one")?.runId).toBe("run-confirm");
    const tool = state.chatHistory.flatMap((message) => message.parts)
      .find((part) => part.kind === "toolCall" && part.data.id === "tool-one");
    expect(tool?.kind === "toolCall" ? tool.data.status.kind : null).toBe("running");
  });

  it("确认持久化期间取消时清除 pending 且不发确认卡", async () => {
    const state = createSession("approval-cancel-during-persist");
    const abortController = new AbortController();
    const persistReasons: string[] = [];
    const service = new ConfirmService({
      createId: () => "confirm-cancelled",
      appendAudit: async () => undefined,
      persist: async (_state, reason) => {
        persistReasons.push(reason);
        if (reason === "confirm:requested") abortController.abort("user_abort");
      },
    });

    const frames = await collect(processAgentStream(
      events(approval("tool-cancelled", "mv draft.txt final.txt")),
      {
        state,
        agentMessageId: "agent-message",
        streamId: "stream-cancelled",
        runId: "run-confirm",
        abortController,
        confirmService: service,
      },
    ));

    expect(persistReasons).toEqual([
      "confirm:requested",
      "confirm:aborted:terminal",
      "confirm:aborted",
    ]);
    expect(state.pendingConfirms.size).toBe(0);
    expect(frames.some((frame) => frame.kind === "confirmRequested")).toBe(false);
  });

  it("同一步多个 approval 全部按 toolCallId 收集，不串权", async () => {
    const state = createSession("approval-stream-many");
    let id = 0;
    const service = new ConfirmService({
      persist: async () => undefined,
      createId: () => `confirm-${++id}`,
    });
    const frames = await collect(processAgentStream(
      events(
        approval("tool-a", "mv a.txt b.txt"),
        approval("tool-b", "mv c.txt d.txt"),
      ),
      {
        state,
        agentMessageId: "agent-message",
        streamId: "stream-confirm-many",
        runId: "run-confirm",
        confirmService: service,
      },
    ));
    expect([...state.pendingConfirms.keys()]).toEqual(["tool-a", "tool-b"]);
    expect(frames.filter((frame) => frame.kind === "confirmRequested")).toHaveLength(2);
    expect(state.pendingConfirms.get("tool-a")?.commandDigest)
      .not.toBe(state.pendingConfirms.get("tool-b")?.commandDigest);
  });

  it("用户拒绝确认时直接收成 rejected 且不可重试，迟到 decline result 不覆盖", async () => {
    const state = createSession("approval-rejected");
    const pending = {
      confirmId: "confirm-rejected",
      runId: "run-rejected",
      toolCallId: "tool-rejected",
      toolName: "mastra_workspace_execute_command",
      commandDigest: "digest-rejected",
      spec: {
        id: "confirm-rejected",
        kind: "install" as const,
        title: "安装依赖",
        say: "将安装依赖",
        commandPreview: "npm install is-number",
        footHint: "仅本次",
        primaryLabel: "确认安装",
        secondaryLabel: "取消",
      },
      requestedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      status: "resuming" as const,
      decisionId: "decision-rejected",
      decisionSource: "ui" as const,
      decisionAccepted: false,
    };
    state.pendingConfirms.set(pending.toolCallId, pending);
    state.chatHistory.push({
      id: "agent-rejected",
      role: { kind: "agent" },
      ts: new Date().toISOString(),
      parts: [{
        kind: "toolCall",
        data: {
          id: pending.toolCallId,
          name: pending.toolName,
          render: { kind: "chatInline" },
          status: { kind: "running", data: { progressPct: null, etaSec: null } },
          body: { kind: "generic", data: { argsJson: "" } },
          result: null,
        },
      }],
      chips: null,
    });
    const service = new ConfirmService({ persist: async () => undefined });
    const frames = await collect(resumeConfirmDecision({
      session: state,
      pending,
      decisionId: pending.decisionId,
      accepted: false,
      resolution: "rejected",
      service,
      agent: {
        approveToolCall: async () => { throw new Error("must not approve"); },
        declineToolCall: async () => ({
          runId: pending.runId,
          fullStream: events(
            {
              type: "tool-result",
              payload: {
                toolName: pending.toolName,
                toolCallId: pending.toolCallId,
                args: { command: pending.spec.commandPreview },
                result: "Tool call declined",
              },
            },
            {
              type: "text-delta",
              payload: { text: "已取消，命令未执行。" },
            },
            {
              type: "tool-error",
              payload: {
                toolName: pending.toolName,
                toolCallId: pending.toolCallId,
                error: "Tool call declined",
              },
            },
          ),
        }),
      } as never,
    }));

    const rejected = state.chatHistory.flatMap((message) => message.parts)
      .find((part) => part.kind === "toolCall" && part.data.id === pending.toolCallId);
    expect(rejected?.kind === "toolCall" ? rejected.data : null).toMatchObject({
      status: {
        kind: "failed",
        data: { retriable: false, reason: "已取消，命令未执行" },
      },
      body: {
        kind: "commandCard",
        data: {
          phase: "failed",
          terminalKind: "rejected",
          command: "npm install is-number",
        },
      },
    });
    expect(frames).toContainEqual(expect.objectContaining({
      kind: "confirmResolved",
      data: expect.objectContaining({ resolution: "rejected" }),
    }));
    expect(frames.some((frame) =>
      frame.kind === "toolCallUpdated" &&
      frame.data.toolCallId === pending.toolCallId &&
      frame.data.spec.body.kind === "commandCard" &&
      frame.data.spec.body.data.terminalKind === "rejected"
    )).toBe(true);
  });

  it("execute_command 空参审批降为可重试 tool error，不触发全局失败帧", async () => {
    const state = createSession("approval-stream-empty-command-args");
    const service = new ConfirmService({ persist: async () => undefined });
    const frames = await collect(processAgentStream(
      events({
        type: "tool-call-approval",
        runId: "run-confirm",
        payload: {
          toolCallId: "tool-empty-command-args",
          toolName: "mastra_workspace_execute_command",
          args: {},
        },
      }),
      {
        state,
        agentMessageId: "agent-message",
        streamId: "stream-empty-command-args",
        runId: "run-confirm",
        confirmService: service,
      },
    ));

    expect(state.pendingConfirms.size).toBe(0);
    expect(frames.some((frame) => frame.kind === "confirmRequested")).toBe(false);
    expect(frames.some(
      (frame) => frame.kind === "stream" && frame.data.kind === "draftingFailed",
    )).toBe(false);
    expect(JSON.stringify(frames)).toContain(
      "命令参数为空或格式损坏，请重新以合法 JSON 发起，注意转义",
    );
    expect(JSON.stringify(frames)).not.toContain("生成失败");
  });

  it("未知 approval 无卡、可见失败、绝不创建 pending", async () => {
    const state = createSession("approval-stream-invalid");
    const service = new ConfirmService({ persist: async () => undefined });
    const frames = await collect(processAgentStream(
      events(approval("tool-bad", "mv a b", "unknown-tool")),
      {
        state,
        agentMessageId: "agent-message",
        streamId: "stream-confirm-invalid",
        runId: "run-confirm",
        confirmService: service,
      },
    ));
    expect(state.pendingConfirms.size).toBe(0);
    expect(frames.some((frame) => frame.kind === "confirmRequested")).toBe(false);
    expect(frames.some(
      (frame) => frame.kind === "stream" && frame.data.kind === "draftingFailed",
    )).toBe(true);
    expect(JSON.stringify(frames)).toContain(
      "确认没有完成，命令没有执行。请稍后再试。",
    );
  });

  it("确认持久化失败且 pending 已删除时不保留挂起语义", async () => {
    const state = createSession("approval-persist-failed");
    const service = new ConfirmService({
      createId: () => "confirm-persist-failed",
      persist: async () => {
        throw new Error("storage unavailable");
      },
    });
    const context = await createAgentStreamTurnContext({
      state,
      agentMessageId: "agent-message",
      streamId: "stream-persist-failed",
      runId: "run-confirm",
      confirmService: service,
    });

    const frames = await collect(handleApprovalEvent(
      context,
      approval("tool-persist-failed", "mv draft.txt final.txt"),
    ));

    expect(state.pendingConfirms.has("tool-persist-failed")).toBe(false);
    expect(context.wasSuspended).toBe(false);
    expect(frames.some(
      (frame) => frame.kind === "stream" && frame.data.kind === "draftingFailed",
    )).toBe(true);
  });

  it.each(["pending", "resuming"] as const)(
    "确认失败但同一工具仍有 %s pending 时保留挂起语义",
    async (status) => {
      const state = createSession(`approval-${status}-remains`);
      const toolCallId = `tool-${status}-remains`;
      state.pendingConfirms.set(toolCallId, {
        confirmId: `confirm-${status}`,
        runId: "run-confirm",
        toolCallId,
        toolName: "mastra_workspace_execute_command",
        commandDigest: `digest-${status}`,
        spec: {
          id: `confirm-${status}`,
          kind: "command",
          title: "移动文件",
          say: "将移动文件",
          commandPreview: "mv draft.txt final.txt",
          footHint: "仅本次",
          primaryLabel: "执行",
          secondaryLabel: "取消",
        },
        requestedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        status,
      });
      const context = await createAgentStreamTurnContext({
        state,
        agentMessageId: "agent-message",
        streamId: `stream-${status}-remains`,
        runId: "run-confirm",
        confirmService: {
          requestCommandConfirm: async () => ({
            ok: false,
            reason: "确认恢复仍在进行",
          }),
        } as unknown as ConfirmService,
      });

      await collect(handleApprovalEvent(
        context,
        approval(toolCallId, "mv draft.txt final.txt"),
      ));

      expect(context.wasSuspended).toBe(true);
    },
  );

  it("凭证 A 挂起后审批 B 失败不会清除同一回合的挂起语义", async () => {
    const state = createSession("approval-success-then-failure");
    let nextId = 0;
    const service = new ConfirmService({
      createId: () => `confirm-sequence-${++nextId}`,
      persist: async (current, reason) => {
        if (reason === "confirm:requested" && current.pendingConfirms.has("tool-b")) {
          throw new Error("storage unavailable");
        }
      },
    });
    const context = await createAgentStreamTurnContext({
      state,
      agentMessageId: "agent-message",
      streamId: "stream-success-then-failure",
      runId: "run-confirm",
      confirmService: service,
    });

    await collect(handleApprovalEvent(
      context,
      credentialApproval("tool-a"),
    ));
    expect(context.wasSuspended).toBe(true);
    expect(state.pendingConfirms.has("tool-a")).toBe(true);
    expect(state.pendingConfirms.get("tool-a")?.toolName).toBe(REQUEST_CREDENTIAL_ACCESS_TOOL);

    await collect(handleApprovalEvent(
      context,
      approval("tool-b", "mv b.txt done-b.txt"),
    ));

    expect(state.pendingConfirms.has("tool-a")).toBe(true);
    expect(state.pendingConfirms.has("tool-b")).toBe(false);
    expect(context.wasSuspended).toBe(true);
  });

  it("stored grant 跳过参数流 generic 占位，首帧为排队 commandCard 并恢复到完成态", async () => {
    const state = createSession("approval-stream-stored");
    let now = Date.now();
    const audits: Array<Record<string, unknown>> = [];
    const service = new ConfirmService({
      now: () => now,
      createId: () => "stored-confirm",
      persist: async () => undefined,
      loadGrant: async () => ({
        grantId: "grant-command",
        kind: "command",
        createdAt: "2026-07-21T00:00:00.000Z",
        source: "settings",
      }),
      appendAudit: async (event) => { audits.push(event); },
    });
    const initial = await collectWithOutcome(processAgentStream(
      events(
        {
          type: "tool-call-input-streaming-start",
          payload: {
            toolCallId: "tool-stored",
            toolName: "mastra_workspace_execute_command",
          },
        },
        approval("tool-stored", "mv a.txt b.txt"),
      ),
      {
        state,
        agentMessageId: "agent-message",
        streamId: "stream-stored",
        runId: "run-confirm",
        confirmService: service,
      },
    ));
    expect(initial.frames.some((frame) => frame.kind === "confirmRequested")).toBe(false);
    const firstVisibleToolFrame = initial.frames.find(
      (frame) => frame.kind === "chatMessageAppended" || frame.kind === "toolCallUpdated",
    );
    const firstVisibleSpec = firstVisibleToolFrame?.kind === "chatMessageAppended"
      && firstVisibleToolFrame.data.part.kind === "toolCall"
      ? firstVisibleToolFrame.data.part.data
      : firstVisibleToolFrame?.kind === "toolCallUpdated"
        ? firstVisibleToolFrame.data.spec
        : null;
    expect(firstVisibleSpec?.body.kind).toBe("commandCard");
    expect(firstVisibleSpec?.status.kind).toBe("pending");
    expect(initial.frames.some((frame) =>
      frame.kind === "chatMessageAppended" &&
      frame.data.part.kind === "toolCall" &&
      frame.data.part.data.body.kind === "generic"
    )).toBe(false);
    expect(initial.outcome.storedGrantApprovals).toHaveLength(1);
    const stored = initial.outcome.storedGrantApprovals[0]!;
    now += 61_000;
    const agent = {
      approveToolCall: async () => {
        expect(consumeApprovalProof(state, {
          sessionId: state.sessionId,
          runId: stored.pending.runId,
          toolCallId: stored.pending.toolCallId,
          commandDigest: stored.pending.commandDigest,
        }, now)).toBe(true);
        return {
          runId: "run-confirm",
          fullStream: events({
            type: "tool-result",
            payload: {
              toolName: "mastra_workspace_execute_command",
              toolCallId: "tool-stored",
              args: { command: "mv a.txt b.txt" },
              result: "ok",
            },
          }),
        };
      },
      declineToolCall: async () => ({ runId: "run-confirm", fullStream: events() }),
    };
    const resumed = await collect(resumeConfirmDecision({
      session: state,
      pending: stored.pending,
      decisionId: stored.decisionId,
      accepted: true,
      resolution: "accepted",
      service,
      agent: agent as never,
      emitResolvedFrame: false,
    }));
    expect(resumed.some((frame) => frame.kind === "confirmRequested")).toBe(false);
    expect(resumed.some((frame) => frame.kind === "confirmResolved")).toBe(false);
    const commandPhases = resumed.flatMap((frame) => {
      if (frame.kind !== "toolCallUpdated" || frame.data.spec.body.kind !== "commandCard") return [];
      return [frame.data.spec.body.data.phase];
    });
    expect(commandPhases).toContain("running");
    expect(commandPhases).toContain("done");
    expect(state.pendingConfirms.size).toBe(0);
    expect(audits).toContainEqual(expect.objectContaining({
      eventType: "decision_finished",
      source: "stored-grant",
      grantId: "grant-command",
      commandDigest: stored.pending.commandDigest,
      result: "accepted",
    }));
  });

  it("五条 stored grant 在串行恢复前逐条先发排队命令卡", async () => {
    const state = createSession("approval-stream-five-stored");
    let id = 0;
    const service = new ConfirmService({
      createId: () => `stored-${++id}`,
      persist: async () => undefined,
      loadGrant: async () => ({
        grantId: "grant-command",
        kind: "command",
        createdAt: "2026-07-22T00:00:00.000Z",
        source: "settings",
      }),
      appendAudit: async () => undefined,
    });
    const initial = await collectWithOutcome(processAgentStream(
      events(...Array.from({ length: 5 }, (_, index) =>
        approval(`tool-${index + 1}`, `mv file-${index + 1}.txt done-${index + 1}.txt`))),
      {
        state,
        agentMessageId: "agent-message-five",
        streamId: "stream-five",
        runId: "run-five",
        confirmService: service,
      },
    ));

    expect(initial.outcome.storedGrantApprovals).toHaveLength(5);
    const visibleCards = initial.frames.flatMap((frame) => {
      if (frame.kind !== "chatMessageAppended" || frame.data.part.kind !== "toolCall") return [];
      return [frame.data.part.data];
    });
    expect(visibleCards).toHaveLength(5);
    expect(visibleCards.every((item) =>
      item.body.kind === "commandCard" && item.status.kind === "pending"
    )).toBe(true);
  });

  it("卡级停止在批准调用前生效时明确命令没有执行", async () => {
    const state = createSession("approval-targeted-cancel");
    const pending = {
      confirmId: "confirm-targeted",
      runId: "run-targeted",
      toolCallId: "tool-targeted",
      toolName: "mastra_workspace_execute_command",
      commandDigest: "digest-targeted",
      spec: {
        id: "confirm-targeted",
        kind: "command" as const,
        title: "移动文件",
        say: "将移动文件",
        commandPreview: "mv a.txt b.txt",
        footHint: "仅本次",
        primaryLabel: "执行",
        secondaryLabel: "取消",
      },
      requestedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      status: "resuming" as const,
      decisionId: "decision-targeted",
      decisionSource: "stored-grant" as const,
      decisionAccepted: true,
    };
    state.pendingConfirms.set(pending.toolCallId, pending);
    state.chatHistory.push({
      id: "agent-targeted",
      role: { kind: "agent" },
      ts: new Date().toISOString(),
      parts: [{
        kind: "toolCall",
        data: {
          id: pending.toolCallId,
          name: pending.toolName,
          render: { kind: "chatInline" },
          status: { kind: "pending" },
          body: {
            kind: "commandCard",
            data: {
              title: pending.spec.title,
              icon: "⚙️",
              command: pending.spec.commandPreview,
              exitCode: 0,
              outputTail: "",
              phase: "running",
            },
          },
          result: null,
        },
      }],
      chips: null,
    });
    const service = new ConfirmService({ persist: async () => undefined });
    const sharedAbortController = new AbortController();
    const agent = {
      approveToolCall: async (options: { abortSignal: AbortSignal }) => {
        options.abortSignal.throwIfAborted();
        return { runId: pending.runId, fullStream: events() };
      },
      declineToolCall: async () => ({ runId: pending.runId, fullStream: events() }),
    };
    const generator = resumeConfirmDecision({
      session: state,
      pending,
      decisionId: pending.decisionId,
      accepted: true,
      resolution: "accepted",
      service,
      agent: agent as never,
      emitResolvedFrame: false,
      abortController: sharedAbortController,
    });
    const frames: BridgeFrame[] = [];
    frames.push((await generator.next()).value as BridgeFrame);
    frames.push((await generator.next()).value as BridgeFrame);

    expect(cancelConfirmedCommand(state, "tool-other")).toBe(false);
    expect(cancelConfirmedCommand(state, pending.toolCallId)).toBe(true);
    for (;;) {
      const next = await generator.next();
      if (next.done) break;
      frames.push(next.value);
    }

    const stopped = frames.find((frame) =>
      frame.kind === "toolCallUpdated" &&
      frame.data.toolCallId === pending.toolCallId &&
      frame.data.spec.status.kind === "failed"
    );
    expect(stopped?.kind === "toolCallUpdated" ? stopped.data.spec.status : null)
      .toEqual({
        kind: "failed",
        data: { retriable: false, reason: "已中止，命令没有执行。" },
      });
    expect(state._activeConfirmedToolCallId).toBeNull();
  });

  it("stored grant 队列复用原轮取消信号，停止前项后不执行后项", async () => {
    const state = createSession("approval-stored-drain-cancel");
    const sharedAbortController = new AbortController();
    const service = new ConfirmService({ persist: async () => undefined });
    const makePending = (suffix: string) => ({
      confirmId: `confirm-${suffix}`,
      runId: "run-stored-drain",
      toolCallId: `tool-${suffix}`,
      toolName: "mastra_workspace_execute_command",
      commandDigest: `digest-${suffix}`,
      spec: {
        id: `confirm-${suffix}`,
        kind: "command" as const,
        title: `命令 ${suffix}`,
        say: "将执行命令",
        commandPreview: `mv ${suffix}.txt done-${suffix}.txt`,
        footHint: "仅本次",
        primaryLabel: "执行",
        secondaryLabel: "取消",
      },
      requestedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      status: "resuming" as const,
      decisionId: `decision-${suffix}`,
      decisionSource: "stored-grant" as const,
      decisionAccepted: true,
    });
    const first = makePending("first");
    const second = makePending("second");
    for (const pending of [first, second]) {
      state.pendingConfirms.set(pending.toolCallId, pending);
      state.chatHistory.push({
        id: `agent-${pending.toolCallId}`,
        role: { kind: "agent" },
        ts: new Date().toISOString(),
        parts: [{
          kind: "toolCall",
          data: {
            id: pending.toolCallId,
            name: pending.toolName,
            render: { kind: "chatInline" },
            status: { kind: "pending" },
            body: {
              kind: "commandCard",
              data: {
                title: pending.spec.title,
                icon: "⚙️",
                command: pending.spec.commandPreview,
                exitCode: 0,
                outputTail: "",
                phase: "running",
              },
            },
            result: null,
          },
        }],
        chips: null,
      });
    }
    const approveToolCall = vi.fn(async () => ({
      runId: "run-stored-drain",
      fullStream: events(),
    }));
    const agent = {
      approveToolCall,
      declineToolCall: async () => ({ runId: "run-stored-drain", fullStream: events() }),
    };

    const firstResume = resumeConfirmDecision({
      session: state,
      pending: first,
      decisionId: first.decisionId,
      accepted: true,
      resolution: "accepted",
      service,
      agent: agent as never,
      emitResolvedFrame: false,
      abortController: sharedAbortController,
    });
    await firstResume.next();
    await firstResume.next();
    expect(cancelConfirmedCommand(state, first.toolCallId)).toBe(true);
    await collect(firstResume);

    await collect(resumeConfirmDecision({
      session: state,
      pending: second,
      decisionId: second.decisionId,
      accepted: true,
      resolution: "accepted",
      service,
      agent: agent as never,
      emitResolvedFrame: false,
      abortController: sharedAbortController,
    }));

    expect(approveToolCall).not.toHaveBeenCalled();
    const secondCard = state.chatHistory.flatMap((message) => message.parts)
      .find((part) => part.kind === "toolCall" && part.data.id === second.toolCallId);
    expect(secondCard?.kind === "toolCall" ? secondCard.data : null).toMatchObject({
      status: {
        kind: "failed",
        data: { reason: "已中止，命令没有执行。" },
      },
      body: {
        kind: "commandCard",
        data: { terminalKind: "aborted" },
      },
    });
  });

  it("approveToolCall 跨过调用边界后抛错时提示执行状态未知", async () => {
    const state = createSession("approval-execution-unknown");
    const pending = {
      confirmId: "confirm-execution-unknown",
      runId: "run-execution-unknown",
      toolCallId: "tool-execution-unknown",
      toolName: "mastra_workspace_execute_command",
      commandDigest: "digest-execution-unknown",
      spec: {
        id: "confirm-execution-unknown",
        kind: "command" as const,
        title: "运行命令",
        say: "需要确认",
        commandPreview: "touch result.txt",
        footHint: "仅本次",
        primaryLabel: "执行",
        secondaryLabel: "取消",
      },
      requestedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      status: "resuming" as const,
      decisionId: "decision-execution-unknown",
      decisionSource: "ui" as const,
      decisionAccepted: true,
    };
    state.pendingConfirms.set(pending.toolCallId, pending);
    state.chatHistory.push({
      id: "agent-execution-unknown",
      role: { kind: "agent" },
      ts: new Date().toISOString(),
      parts: [{
        kind: "toolCall",
        data: {
          id: pending.toolCallId,
          name: pending.toolName,
          render: { kind: "chatInline" },
          status: { kind: "pending" },
          body: { kind: "generic", data: { argsJson: "" } },
          result: null,
        },
      }],
      chips: null,
    });

    const frames = await collect(resumeConfirmDecision({
      session: state,
      pending,
      decisionId: pending.decisionId,
      accepted: true,
      resolution: "accepted",
      service: new ConfirmService({ persist: async () => undefined }),
      agent: {
        approveToolCall: async () => {
          throw new Error("resume transport failed after execution started");
        },
        declineToolCall: async () => {
          throw new Error("must not decline");
        },
      } as never,
    }));

    expect(JSON.stringify(frames)).toContain(
      "执行状态未知，请先核实命令是否已生效再重试。",
    );
    expect(JSON.stringify(frames)).not.toContain("命令没有执行");
  });

  it("确认所属消息缺失且 failDecision 持久化失败时仍补失败工具卡与 resolved", async () => {
    const state = createSession("approval-missing-message");
    const pending = {
      confirmId: "confirm-missing-message",
      runId: "run-missing-message",
      toolCallId: "tool-missing-message",
      toolName: "mastra_workspace_execute_command",
      commandDigest: "digest-missing-message",
      spec: {
        id: "confirm-missing-message",
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
      status: "resuming" as const,
      decisionId: "decision-missing-message",
    };
    state.pendingConfirms.set(pending.toolCallId, pending);
    const service = new ConfirmService({
      persist: async (_current, reason) => {
        if (reason === "confirm:failed") throw new Error("persist unavailable");
      },
    });

    const frames = await collect(resumeConfirmDecision({
      session: state,
      pending,
      decisionId: pending.decisionId,
      accepted: true,
      resolution: "accepted",
      service,
      agent: {
        approveToolCall: async () => { throw new Error("must not resume"); },
        declineToolCall: async () => { throw new Error("must not resume"); },
      } as never,
    }));

    expect(frames).toContainEqual(expect.objectContaining({
      kind: "chatMessageAdded",
      data: {
        message: expect.objectContaining({
          parts: [expect.objectContaining({
            kind: "toolCall",
            data: expect.objectContaining({
              id: pending.toolCallId,
              status: expect.objectContaining({ kind: "failed" }),
              body: expect.objectContaining({
                kind: "commandCard",
                data: expect.objectContaining({ phase: "failed" }),
              }),
            }),
          })],
        }),
      },
    }));
    expect(frames).toContainEqual(expect.objectContaining({
      kind: "confirmResolved",
      data: expect.objectContaining({
        id: pending.confirmId,
        toolCallId: pending.toolCallId,
        resolution: "failed",
      }),
    }));
    expect(state.pendingConfirms.has(pending.toolCallId)).toBe(false);
  });
});
