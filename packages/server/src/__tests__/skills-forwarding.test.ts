import { describe, expect, it, vi, beforeEach } from "vitest";
import type { Command, BridgeFrame } from "@qingagent/contract-ts";

const runAgentTurnMock = vi.hoisted(() => vi.fn());

vi.mock("@qingagent/core", async () => {
  const actual = await vi.importActual<typeof import("@qingagent/core")>("@qingagent/core");
  return {
    ...actual,
    runAgentTurn: runAgentTurnMock,
  };
});

import { handleCommand } from "../gateway/bridgeHandler";

async function collectFrames(gen: AsyncGenerator<BridgeFrame>): Promise<BridgeFrame[]> {
  const frames: BridgeFrame[] = [];
  for await (const frame of gen) {
    frames.push(frame);
  }
  return frames;
}

describe("bridge skill forwarding", () => {
  beforeEach(() => {
    runAgentTurnMock.mockReset();
    runAgentTurnMock.mockImplementation(async function* () {});
  });

  it("passes sendMessage skills to runAgentTurn as the fifth argument", async () => {
    const start: Command = {
      kind: "startSession",
      data: { mode: { kind: "new", data: { template: null } } },
    };
    const frames = await collectFrames(handleCommand(start));
    const sessionMeta = frames.find((frame) => frame.kind === "sessionMeta");
    expect(sessionMeta?.kind).toBe("sessionMeta");
    if (sessionMeta?.kind !== "sessionMeta") return;

    const skills = [{ id: "browser-ops", version: null }];
    const send: Command = {
      kind: "sendMessage",
      data: {
        sessionId: sessionMeta.data.sessionId,
        text: "抓取这个链接",
        mentions: [],
        skills,
        chips: [],
        fileIds: [],
      },
    };
    await collectFrames(handleCommand(send));

    expect(runAgentTurnMock).toHaveBeenCalledTimes(1);
    expect(runAgentTurnMock.mock.calls[0]?.[4]).toEqual(skills);
  });
});
