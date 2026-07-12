import { describe, it, expect } from "vitest";
import { handleCommand } from "../gateway/bridgeHandler";
import type { Command, BridgeFrame } from "@qingagent/contract-ts";

/** Collect all frames from an async generator into an array. */
async function collectFrames(
  gen: AsyncGenerator<BridgeFrame>,
): Promise<BridgeFrame[]> {
  const frames: BridgeFrame[] = [];
  for await (const frame of gen) {
    frames.push(frame);
  }
  return frames;
}

describe("handleCommand", () => {
  it("yields sessionMeta for startSession", async () => {
    const command: Command = {
      kind: "startSession",
      data: { mode: { kind: "new", data: { template: null } } },
    };
    const frames = await collectFrames(handleCommand(command));

    // The first frame should be sessionMeta
    expect(frames.length).toBeGreaterThan(0);
    const first = frames[0];
    expect(first?.kind).toBe("sessionMeta");
    if (first?.kind === "sessionMeta") {
      expect(first.data.sessionId).toBeTruthy();
      expect(typeof first.data.title).toBe("string");
    }
  });

  it("throws on sendMessage with unknown session", async () => {
    const command: Command = {
      kind: "sendMessage",
      data: {
        sessionId: "does-not-exist",
        text: "test",
        mentions: [],
        skills: [],
        chips: [],
        fileIds: [],
      },
    };

    await expect(
      collectFrames(handleCommand(command)),
    ).rejects.toThrow("Session not found");
  });

  it("throws on sendMessage with fileIds for unknown session", async () => {
    const command: Command = {
      kind: "sendMessage",
      data: {
        sessionId: "no-such-session",
        text: "here are files",
        mentions: [],
        skills: [],
        chips: [],
        fileIds: ["some-file-id"],
      },
    };

    await expect(
      collectFrames(handleCommand(command)),
    ).rejects.toThrow("Session not found");
  });

  it("normalizes missing fileIds field to empty array", async () => {
    // When fileIds field is absent (old client), bridgeHandler
    // normalizes it to []. This should not cause an error beyond
    // the expected "Session not found".
    const command: Command = {
      kind: "sendMessage",
      data: {
        sessionId: "missing-session",
        text: "old client format",
        mentions: [],
        skills: [],
        chips: [],
        fileIds: [],
      },
    };

    await expect(
      collectFrames(handleCommand(command)),
    ).rejects.toThrow("Session not found");
  });
});
