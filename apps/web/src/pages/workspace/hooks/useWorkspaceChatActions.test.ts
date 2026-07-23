import { describe, expect, it, vi } from "vitest";
import type { Command } from "@qingagent/contract-ts";
import type { ServerStream } from "../data/serverStream";
import {
  beginWorkspaceTurnDispatch,
  cancelWorkspaceGeneration,
  cancelWorkspaceTurnDispatch,
  isWorkspaceTurnDispatchCurrent,
  prepareAndDispatchWorkspaceTurn,
  type WorkspaceTurnDispatchGate,
} from "./useWorkspaceChatActions";

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

  it("新会话尚未拿到 sessionId 时由本地 turn 闸门完成停止，不误报没有任务", async () => {
    const input = setup();

    await cancelWorkspaceGeneration({
      ...input,
      sessionId: null,
      streamIds: [],
    });

    expect(input.cancel).not.toHaveBeenCalled();
    expect(input.showToast).toHaveBeenCalledWith("已中断");
  });
});

describe("WorkspaceTurnDispatchGate", () => {
  it("规划期停止后旧编排跨过多个异步步骤仍保持取消，不再派发后续 sendMessage/问卷", async () => {
    const gate: WorkspaceTurnDispatchGate = { generation: 0 };
    const generation = beginWorkspaceTurnDispatch(gate);
    let finishPrepare!: (value: string) => void;
    const prepare = vi.fn(
      () => new Promise<string>((resolve) => {
        finishPrepare = resolve;
      }),
    );
    const dispatch = vi.fn(async (_command: string) => undefined);

    const resultPromise = prepareAndDispatchWorkspaceTurn({
      gate,
      generation,
      prepare,
      dispatch,
    });
    await Promise.resolve();

    cancelWorkspaceTurnDispatch(gate);
    finishPrepare("sendMessage:继续产出问卷");

    await expect(resultPromise).resolves.toBe("cancelled");
    expect(dispatch).not.toHaveBeenCalled();
    expect(isWorkspaceTurnDispatchCurrent(gate, generation)).toBe(false);
  });

  it("取消标记只终止旧 turn，下一次用户主动发送会获得新 generation", async () => {
    const gate: WorkspaceTurnDispatchGate = { generation: 0 };
    const cancelledGeneration = beginWorkspaceTurnDispatch(gate);
    cancelWorkspaceTurnDispatch(gate);
    const nextGeneration = beginWorkspaceTurnDispatch(gate);
    const dispatch = vi.fn(async (_command: string) => undefined);

    expect(isWorkspaceTurnDispatchCurrent(gate, cancelledGeneration)).toBe(false);
    await expect(prepareAndDispatchWorkspaceTurn({
      gate,
      generation: nextGeneration,
      prepare: async () => "sendMessage:新 turn",
      dispatch,
    })).resolves.toBe("sent");
    expect(dispatch).toHaveBeenCalledWith("sendMessage:新 turn");
  });
});
