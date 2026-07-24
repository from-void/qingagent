import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { app } from "../app";
import { sessionManager } from "../gateway/bridgeHandler";
import { getExternalToken, startExternalInstance, stopExternalInstance } from "../lib/externalInstance";
import { DEFAULT_SSE_ADMISSION_LIMITS } from "../lib/sseAdmission";

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

  it("70 条同步历史回放完整送达，不被 64 帧 live 队列误杀", async () => {
    const sessionId = "events-replay-over-64";
    for (let index = 1; index <= 70; index += 1) {
      sessionManager.frameLog.append(sessionId, {
        kind: "sessionMeta",
        data: { sessionId, title: `历史帧 ${index}` },
      });
    }

    const controller = new AbortController();
    const res = await app.request(`/api/v1/external/sessions/${sessionId}/events?after=0`, {
      headers: authHeaders(),
      signal: controller.signal,
    });
    const events = await readSseEvents(res, controller, 71);
    const frames = events
      .filter((event) => event.event === "frame")
      .map((event) => JSON.parse(event.data) as { seq: number });

    expect(frames).toHaveLength(70);
    expect(frames.map((frame) => frame.seq)).toEqual(
      Array.from({ length: 70 }, (_, index) => index + 1),
    );
  });

  it("超过 512 KiB 的文档快照可在重连回放中恢复", async () => {
    const sessionId = "events-large-document-snapshot";
    const largeText = "大".repeat(300 * 1024);
    sessionManager.frameLog.append(sessionId, {
      kind: "documentSnapshotWritten",
      data: {
        doc: {
          version: 1,
          ts: "2026-07-25T00:00:00.000Z",
          doc: {
            type: "doc",
            attrs: { schemaVersion: 1 },
            content: [{
              type: "paragraph",
              attrs: { blockId: "large-paragraph" },
              content: [{ type: "text", text: largeText }],
            }],
          },
        },
      },
    });

    const controller = new AbortController();
    const res = await app.request(`/api/v1/external/sessions/${sessionId}/events?after=0`, {
      headers: authHeaders(),
      signal: controller.signal,
    });
    const events = await readSseEvents(res, controller, 2);
    const frame = JSON.parse(events[1]!.data) as {
      kind: string;
      data: { doc: { doc: { content: Array<{ content: Array<{ text: string }> }> } } };
    };

    expect(Buffer.byteLength(events[1]!.data, "utf8")).toBeGreaterThan(512 * 1024);
    expect(frame.kind).toBe("documentSnapshotWritten");
    expect(frame.data.doc.doc.content[0]!.content[0]!.text).toBe(largeText);
  });

  it("Last-Event-ID 可覆盖旧 query after 继续补拉", async () => {
    const sessionId = "events-last-event-id";
    for (let index = 1; index <= 5; index += 1) {
      sessionManager.frameLog.append(sessionId, {
        kind: "sessionMeta",
        data: { sessionId, title: `帧 ${index}` },
      });
    }

    const controller = new AbortController();
    const res = await app.request(`/api/v1/external/sessions/${sessionId}/events?after=1`, {
      headers: { ...authHeaders(), "Last-Event-ID": "3" },
      signal: controller.signal,
    });
    const events = await readSseEvents(res, controller, 3);
    const seqs = events
      .filter((event) => event.event === "frame")
      .map((event) => (JSON.parse(event.data) as { seq: number }).seq);

    expect(seqs).toEqual([4, 5]);
  });

  it("external SSE 也纳入非回环公网会话准入上限", async () => {
    const sessionId = "external-events-public-admission";
    sessionManager.frameLog.append(sessionId, {
      kind: "sessionMeta",
      data: { sessionId, title: "公网准入" },
    });
    const connections: Array<{ controller: AbortController; response: Response }> = [];
    try {
      for (let index = 0; index < DEFAULT_SSE_ADMISSION_LIMITS.maxPerSession; index += 1) {
        const controller = new AbortController();
        const response = await app.request(
          `/api/v1/external/sessions/${sessionId}/events?after=1`,
          {
            headers: { ...authHeaders(), "X-Forwarded-For": "203.0.113.40" },
            signal: controller.signal,
          },
        );
        expect(response.status).toBe(200);
        connections.push({ controller, response });
      }

      const rejected = await app.request(
        `/api/v1/external/sessions/${sessionId}/events?after=1`,
        { headers: { ...authHeaders(), "X-Forwarded-For": "203.0.113.40" } },
      );
      expect(rejected.status).toBe(429);
      expect(rejected.headers.get("retry-after")).toBe("1");
    } finally {
      for (const connection of connections) {
        connection.controller.abort();
        await connection.response.body?.cancel().catch(() => undefined);
      }
    }
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

  it("只下发公开契约帧，并把一次性消费游标收敛到最后一个公开帧", async () => {
    const sessionId = "events-public-contract-only";
    sessionManager.frameLog.append(sessionId, {
      kind: "annotationPreview",
      data: { previewId: "internal-before", summary: "内部预览", anchors: [] },
    });
    sessionManager.frameLog.append(sessionId, {
      kind: "sessionMeta",
      data: { sessionId, title: "公开帧" },
    });
    sessionManager.frameLog.append(sessionId, {
      kind: "annotationPreviewCleared",
      data: {},
    });

    const controller = new AbortController();
    const res = await app.request(`/api/v1/external/sessions/${sessionId}/events?after=0`, {
      headers: authHeaders(),
      signal: controller.signal,
    });

    const events = await readSseEvents(res, controller, 2);
    const meta = JSON.parse(events[0]!.data) as { minSeq: number; nextSeq: number };
    const frames = events
      .filter((event) => event.event === "frame")
      .map((event) => JSON.parse(event.data) as { seq: number; kind: string });
    expect(meta).toMatchObject({ minSeq: 2, nextSeq: 3 });
    expect(frames).toEqual([{ seq: 2, kind: "sessionMeta", data: { sessionId, title: "公开帧" } }]);
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
