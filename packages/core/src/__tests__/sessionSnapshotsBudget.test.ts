import { RequestContext } from "@mastra/core/request-context";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MAX_SESSION_SNAPSHOT_BODY_BYTES,
  MAX_SESSION_SNAPSHOT_TOTAL_BYTES,
  beginSessionSnapshotTurn,
  clearSessionSnapshot,
  createBranchSnapshotFetch,
  getSessionSnapshot,
} from "../llm/sessionSnapshots.js";

const capturedSessionIds: string[] = [];

async function captureBody(sessionId: string, bodyText: string): Promise<void> {
  capturedSessionIds.push(sessionId);
  const requestContext = new RequestContext([
    ["sessionId", sessionId],
    ["streamId", `stream-${sessionId}`],
  ] as never) as RequestContext;
  beginSessionSnapshotTurn(requestContext);
  const snapshotFetch = createBranchSnapshotFetch(requestContext, "test-key", () => null);
  await snapshotFetch("https://example.test/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: bodyText,
  });
}

function requestBody(payloadChars: number): string {
  return JSON.stringify({
    model: "test-model",
    messages: [{ role: "user", content: "x".repeat(payloadChars) }],
  });
}

describe("session snapshot 字节预算", () => {
  afterEach(() => {
    for (const sessionId of capturedSessionIds.splice(0)) clearSessionSnapshot(sessionId);
    vi.unstubAllGlobals();
  });

  it("单条 body 超过字节上限时不常驻", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("ok")));
    await captureBody("snapshot-oversized", requestBody(MAX_SESSION_SNAPSHOT_BODY_BYTES));
    expect(getSessionSnapshot("snapshot-oversized")).toBeNull();
  });

  it("总字节超限时从最旧会话开始裁剪", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("ok")));
    const body = requestBody(MAX_SESSION_SNAPSHOT_BODY_BYTES - 1024);
    const count = Math.floor(MAX_SESSION_SNAPSHOT_TOTAL_BYTES / body.length) + 1;

    for (let index = 0; index < count; index += 1) {
      await captureBody(`snapshot-budget-${index}`, body);
    }

    expect(getSessionSnapshot("snapshot-budget-0")).toBeNull();
    expect(getSessionSnapshot(`snapshot-budget-${count - 1}`)).not.toBeNull();
  });
});
