import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { app } from "../app";
import { sessionManager } from "../bridge/bridgeHandler";
import { getExternalToken, startExternalInstance, stopExternalInstance } from "../lib/externalInstance";

const dirs: string[] = [];
let token = "";

beforeEach(async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "qa-events-test-"));
  dirs.push(dir);
  await startExternalInstance({ port: 52341, version: "test", filePath: path.join(dir, "instance.json") });
  token = getExternalToken() ?? "";
});

afterEach(async () => {
  await stopExternalInstance();
  await sessionManager.disposeAll();
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("external events", () => {
  it("after 游标历史帧只由 subscribe 回放一次", async () => {
    const sessionId = "events-replay-once";
    for (let i = 1; i <= 5; i += 1) {
      sessionManager.frameLog.append(sessionId, {
        kind: "sessionMeta",
        data: { sessionId, title: `帧 ${i}` },
      });
    }

    const controller = new AbortController();
    const res = await app.request(`/api/v1/external/sessions/${sessionId}/events?after=2`, {
      headers: authHeaders(),
      signal: controller.signal,
    });

    const events = await readSseEvents(res, controller, 4);
    const frames = events.filter((event) => event.event === "frame").map((event) => JSON.parse(event.data) as { seq: number });
    expect(events[0]).toMatchObject({ event: "meta" });
    expect(frames.map((frame) => frame.seq)).toEqual([3, 4, 5]);
  });

  it("订阅建立后追加的帧不丢不重", async () => {
    const sessionId = "events-live-append";
    sessionManager.frameLog.append(sessionId, {
      kind: "sessionMeta",
      data: { sessionId, title: "旧帧" },
    });
    const controller = new AbortController();
    const res = await app.request(`/api/v1/external/sessions/${sessionId}/events?after=1`, {
      headers: authHeaders(),
      signal: controller.signal,
    });
    const readPromise = readSseEvents(res, controller, 2);

    await waitUntil(() => sessionManager.frameLog.hasSubscribers(sessionId));
    sessionManager.frameLog.append(sessionId, {
      kind: "sessionMeta",
      data: { sessionId, title: "新帧" },
    });

    const events = await readPromise;
    const frames = events.filter((event) => event.event === "frame").map((event) => JSON.parse(event.data) as { seq: number });
    expect(frames.map((frame) => frame.seq)).toEqual([2]);
  });

  it("after 早于内存窗口时首帧 meta 标记 gap", async () => {
    const sessionId = "events-gap";
    sessionManager.frameLog.evict(sessionId);
    const controller = new AbortController();
    const res = await app.request(`/api/v1/external/sessions/${sessionId}/events?after=999`, {
      headers: authHeaders(),
      signal: controller.signal,
    });

    const events = await readSseEvents(res, controller, 1);
    expect(events).toHaveLength(1);
    expect(events[0]?.event).toBe("meta");
    expect(JSON.parse(events[0]!.data)).toMatchObject({ minSeq: 1, nextSeq: 1, gap: true });
  });
});

function authHeaders(): HeadersInit {
  return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
}

async function readSseEvents(
  res: Response,
  controller: AbortController,
  count: number,
): Promise<Array<{ event: string; data: string }>> {
  expect(res.status).toBe(200);
  const reader = res.body?.pipeThrough(new TextDecoderStream()).getReader();
  if (!reader) throw new Error("events response has no body");
  const events: Array<{ event: string; data: string }> = [];
  let buffer = "";
  try {
    while (events.length < count) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += value;
      const chunks = buffer.split("\n\n");
      buffer = chunks.pop() ?? "";
      for (const chunk of chunks) {
        const parsed = parseSseEvent(chunk);
        if (parsed && parsed.event !== "ping") events.push(parsed);
        if (events.length >= count) break;
      }
    }
    return events;
  } finally {
    controller.abort();
    await reader.cancel().catch(() => undefined);
  }
}

function parseSseEvent(chunk: string): { event: string; data: string } | null {
  let event = "message";
  const data: string[] = [];
  for (const line of chunk.split(/\r?\n/)) {
    if (line.startsWith("event: ")) event = line.slice(7);
    if (line.startsWith("data: ")) data.push(line.slice(6));
  }
  if (data.length === 0) return null;
  return { event, data: data.join("\n") };
}

async function waitUntil(fn: () => boolean): Promise<void> {
  for (let i = 0; i < 50; i += 1) {
    if (fn()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("condition not met");
}
