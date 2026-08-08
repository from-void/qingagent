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
                skills,
        chips: [],
        fileIds: [],
      },
    };
    await collectFrames(handleCommand(send));

    expect(runAgentTurnMock).toHaveBeenCalledTimes(1);
    expect(runAgentTurnMock.mock.calls[0]?.[4]).toEqual(skills);
  });

  it("会话恢复后复用 chatHistory 的用户消息，但继续执行重试 turn", async () => {
    let restoredChatHistory: Array<{
      id: string;
      role: { kind: "user" };
      ts: string;
      parts: [];
      chips: null;
    }> | null = null;
    runAgentTurnMock.mockImplementation(async function* (
      session: {
        chatHistory: Array<{
          id: string;
          role: { kind: "user" };
          ts: string;
          parts: [];
          chips: null;
        }>;
      },
      _text: string,
      _fileIds: string[],
      _chips: unknown[],
      _skills: unknown[],
      _parts: unknown,
      clientMessageId: string,
      _richText: unknown,
      _reviewContext: unknown,
      runtimeOptions: { reuseExistingUserMessage?: boolean },
    ) {
      restoredChatHistory = session.chatHistory;
      if (!runtimeOptions.reuseExistingUserMessage) {
        session.chatHistory.push({
          id: clientMessageId,
          role: { kind: "user" },
          ts: new Date().toISOString(),
          parts: [],
          chips: null,
        });
      }
    });
    const startFrames = await collectFrames(handleCommand({
      kind: "startSession",
      data: { mode: { kind: "new", data: { template: null } } },
    }));
    const sessionMeta = startFrames.find(
      (frame) => frame.kind === "sessionMeta",
    );
    expect(sessionMeta?.kind).toBe("sessionMeta");
    if (sessionMeta?.kind !== "sessionMeta") return;
    const send: Command = {
      kind: "sendMessage",
      data: {
        sessionId: sessionMeta.data.sessionId,
        text: "同一条消息",
        skills: [],
        chips: [],
        fileIds: [],
        clientMessageId: "durable-client-message",
      },
    };

    await collectFrames(handleCommand(send));
    await collectFrames(handleCommand(send));

    expect(runAgentTurnMock).toHaveBeenCalledTimes(2);
    expect(runAgentTurnMock.mock.calls[0]?.[9]).toMatchObject({
      reuseExistingUserMessage: false,
    });
    expect(runAgentTurnMock.mock.calls[1]?.[9]).toMatchObject({
      reuseExistingUserMessage: true,
    });
    expect(restoredChatHistory).toHaveLength(1);
  });
});
