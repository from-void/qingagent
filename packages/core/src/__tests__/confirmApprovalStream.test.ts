import { describe, expect, it } from "vitest";
import type { BridgeFrame } from "@qingagent/contract-ts";
import { createSession } from "../session/sessionState.js";
import { ConfirmService } from "../confirm/confirmService.js";
import { processAgentStream } from "../agent-run/processAgentStream.js";

async function* events(...items: unknown[]): AsyncGenerator<unknown> {
  for (const item of items) yield item;
}

async function collect(generator: AsyncGenerator<BridgeFrame>): Promise<BridgeFrame[]> {
  const frames: BridgeFrame[] = [];
  for await (const frame of generator) frames.push(frame);
  return frames;
}

function approval(toolCallId: string, command: string, toolName = "mastra_workspace_execute_command") {
  return {
    type: "tool-call-approval",
    runId: "run-confirm",
    payload: { toolCallId, toolName, args: { command } },
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

  it("malformed/未知 approval 无卡、可见失败、绝不创建 pending", async () => {
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
  });
});
