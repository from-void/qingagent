import { afterEach, describe, expect, it } from "vitest";
import type { BridgeFrame, Command } from "@qingagent/contract-ts";
import { app } from "../app";
import {
  forgetSession,
  handleCommand,
  sessionManager,
} from "../bridge/bridgeHandler";

async function collectFrames(gen: AsyncGenerator<BridgeFrame>): Promise<BridgeFrame[]> {
  const frames: BridgeFrame[] = [];
  for await (const frame of gen) frames.push(frame);
  return frames;
}

async function request(
  method: string,
  path: string,
  body?: unknown,
): Promise<Response> {
  const init: RequestInit = {
    method,
    headers: { "Content-Type": "application/json" },
  };
  if (body !== undefined) init.body = JSON.stringify(body);
  return app.request(path, init);
}

describe("POST /api/v1/commit", () => {
  const sessionIds: string[] = [];

  afterEach(() => {
    for (const sessionId of sessionIds.splice(0)) {
      forgetSession(sessionId);
      sessionManager.frameLog.evict(sessionId);
    }
  });

  it("拒绝不受信 Origin 的 commit 写入口", async () => {
    const res = await app.request("/api/v1/commit", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "https://evil.test",
      },
      body: JSON.stringify({ sessionId: "csrf-commit", patchIds: ["p-1"] }),
    });

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "跨站请求被拒绝" });
  });

  it("把 commit 产生的帧写入 FrameLog，并返回带 seq 的帧", async () => {
    const sessionId = "commit-frame-log-test";
    sessionIds.push(sessionId);
    const startCommand: Command = {
      kind: "startSession",
      data: { mode: { kind: "new", data: { sessionId, template: null } } },
    };
    await collectFrames(handleCommand(startCommand));

    const res = await request("POST", "/api/v1/commit", {
      sessionId,
      acceptReviewBatchIds: ["already-resolved-review-batch"],
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual([
      {
        seq: 1,
        frame: {
          kind: "docStateChanged",
          data: { state: { kind: "empty" }, activeOverlay: null, agentBusy: false },
        },
      },
    ]);
    const logged = sessionManager.frameLog.readFrom(sessionId, 0).frames;
    expect(logged.map(({ seq, frame }) => ({ seq, frame }))).toEqual(json);
  });
});
