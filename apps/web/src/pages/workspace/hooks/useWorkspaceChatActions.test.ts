import { describe, expect, it, vi } from "vitest";
import type { Command } from "@qingagent/contract-ts";
import type { ServerStream } from "../data/serverStream";
import { cancelWorkspaceGeneration } from "./useWorkspaceChatActions";

type CancelStreamCommand = Extract<Command, { kind: "cancelStream" }>;

function setup() {
  const cancel = vi.fn(async (_commands?: readonly CancelStreamCommand[]) => undefined);
  const setSendPending = vi.fn();
  const showToast = vi.fn();
  return {
    cancel,
    setSendPending,
    showToast,
    stream: { cancel } as Pick<ServerStream, "cancel">,
  };
}

describe("cancelWorkspaceGeneration", () => {
  it("规划期 start 帧到达前也实际下发 session 级取消，不再早退到问卷", async () => {
    const input = setup();

    await cancelWorkspaceGeneration({
      ...input,
      sessionId: "session-planning",
      streamIds: [],
    });

    expect(input.cancel).toHaveBeenCalledWith([
      { kind: "cancelStream", data: { sessionId: "session-planning" } },
    ]);
    expect(input.showToast).toHaveBeenCalledWith("已中断");
  });

  it("写作期仍按 sessionId + streamId 走同一取消下发路径", async () => {
    const input = setup();

    await cancelWorkspaceGeneration({
      ...input,
      sessionId: "session-writing",
      streamIds: ["stream-writing"],
    });

    expect(input.cancel).toHaveBeenCalledWith([
      {
        kind: "cancelStream",
        data: { sessionId: "session-writing", streamId: "stream-writing" },
      },
    ]);
  });

  it("停止时同步清除乐观 sendPending，输入框不残留忙碌态", async () => {
    const input = setup();

    await cancelWorkspaceGeneration({
      ...input,
      sessionId: "session-reset",
      streamIds: [],
    });

    expect(input.setSendPending).toHaveBeenCalledTimes(1);
    expect(input.setSendPending).toHaveBeenCalledWith(false);
  });
});
