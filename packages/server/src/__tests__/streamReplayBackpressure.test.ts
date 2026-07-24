import { afterEach, describe, expect, it } from "vitest";
import { app } from "../app";
import { sessionManager } from "../gateway/bridgeHandler";

const sessionIds: string[] = [];

afterEach(() => {
  for (const sessionId of sessionIds.splice(0)) sessionManager.frameLog.evict(sessionId);
});

describe("GET /api/v1/events 回放背压", () => {
  it("70 条历史帧与超过 512 KiB 的文档快照可在同次重连完整恢复", async () => {
    const sessionId = "main-events-large-replay";
    sessionIds.push(sessionId);
    for (let index = 1; index <= 70; index += 1) {
      sessionManager.frameLog.append(sessionId, {
        kind: "sessionMeta",
        data: { sessionId, title: `历史 ${index}` },
      });
    }
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
              attrs: { blockId: "large-main-replay" },
              content: [{ type: "text", text: largeText }],
            }],
          },
        },
      },
    });

    const controller = new AbortController();
    const response = await app.request(
      `/api/v1/events?sessionId=${encodeURIComponent(sessionId)}&after=0`,
      { signal: controller.signal },
    );
    const frames = await readFrames(response, controller, 71);

    expect(frames).toHaveLength(71);
    expect(frames.map((frame) => frame.id)).toEqual(
      Array.from({ length: 71 }, (_, index) => String(index + 1)),
    );
    const snapshot = frames.at(-1)!;
    expect(Buffer.byteLength(snapshot.data, "utf8")).toBeGreaterThan(512 * 1024);
    expect(JSON.parse(snapshot.data)).toMatchObject({
      kind: "documentSnapshotWritten",
      data: { doc: { version: 1 } },
    });
  });
});

async function readFrames(
  response: Response,
  controller: AbortController,
  count: number,
): Promise<Array<{ id: string; data: string }>> {
  expect(response.status).toBe(200);
  const reader = response.body?.pipeThrough(new TextDecoderStream()).getReader();
  if (!reader) throw new Error("events response has no body");
  const frames: Array<{ id: string; data: string }> = [];
  let buffer = "";
  try {
    while (frames.length < count) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += value;
      const chunks = buffer.split("\n\n");
      buffer = chunks.pop() ?? "";
      for (const chunk of chunks) {
        const parsed = parseFrame(chunk);
        if (parsed) frames.push(parsed);
        if (frames.length >= count) break;
      }
    }
    return frames;
  } finally {
    controller.abort();
    await reader.cancel().catch(() => undefined);
  }
}

function parseFrame(chunk: string): { id: string; data: string } | null {
  let event = "";
  let id = "";
  const data: string[] = [];
  for (const line of chunk.split(/\r?\n/)) {
    if (line.startsWith("event: ")) event = line.slice(7);
    else if (line.startsWith("id: ")) id = line.slice(4);
    else if (line.startsWith("data: ")) data.push(line.slice(6));
  }
  return event === "frame" && id && data.length > 0 ? { id, data: data.join("\n") } : null;
}
