import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BridgeFrame, Command } from "@qingagent/contract-ts";
import { createSession, runAgentTurn } from "../bridgeCore";
import type { CommandExecutionContext } from "../commandTypes";
import { getOrRestoreSession } from "../sessionLifecycle";
import { handleTurnCommand } from "../turnOrchestration";

vi.mock("../bridgeCore", async (importOriginal) => ({
  ...await importOriginal<typeof import("../bridgeCore")>(),
  runAgentTurn: vi.fn(),
}));

vi.mock("../commandTracing", () => ({
  bindClientTraceId: vi.fn(),
  deriveSessionTraceId: vi.fn(),
}));

vi.mock("../sessionLifecycle", () => ({
  findSessionByStream: vi.fn(),
  getOrRestoreSession: vi.fn(),
}));

const context: CommandExecutionContext = {
  sessionId: "session-retry",
  clientTraceId: undefined,
  resolvedClientTraceId: undefined,
  origin: "manual",
  modelOverrides: undefined,
  client: undefined,
  commandAbortSignal: undefined,
};

async function collectFrames(
  generator: AsyncGenerator<BridgeFrame>,
): Promise<BridgeFrame[]> {
  const frames: BridgeFrame[] = [];
  for await (const frame of generator) frames.push(frame);
  return frames;
}

describe("handleTurnCommand sendMessage 重试", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(runAgentTurn).mockImplementation(async function* () {
      yield {
        kind: "sessionMeta",
        data: { sessionId: "session-retry", title: "retry-ran" },
      };
    });
  });

  it("chatHistory 已有同 clientMessageId 时跳过用户气泡追加并继续执行本轮", async () => {
    const session = createSession("session-retry");
    session.chatHistory.push({
      id: "client-message-retry",
      role: { kind: "user" },
      ts: "2026-08-06T00:00:00.000Z",
      parts: [{ kind: "text", data: { body: "重新生成这条" } }],
      chips: null,
    });
    vi.mocked(getOrRestoreSession).mockResolvedValue(session);
    const command: Extract<Command, { kind: "sendMessage" }> = {
      kind: "sendMessage",
      data: {
        sessionId: "session-retry",
        text: "重新生成这条",
        skills: [],
        chips: [],
        fileIds: [],
        clientMessageId: "client-message-retry",
      },
    };

    const frames = await collectFrames(handleTurnCommand(command, context));

    expect(runAgentTurn).toHaveBeenCalledOnce();
    expect(runAgentTurn).toHaveBeenCalledWith(
      session,
      "重新生成这条",
      [],
      [],
      [],
      null,
      "client-message-retry",
      undefined,
      undefined,
      expect.objectContaining({ reuseExistingUserMessage: true }),
    );
    expect(frames).toEqual([{
      kind: "sessionMeta",
      data: { sessionId: "session-retry", title: "retry-ran" },
    }]);
    expect(session.chatHistory.filter((message) =>
      message.role.kind === "user" && message.id === "client-message-retry"
    )).toHaveLength(1);
  });
});
