import { afterEach, describe, expect, it } from "vitest";
import { createSession } from "../gateway/bridgeCore";
import {
  forgetSession,
  sessionManager,
} from "../gateway/bridgeHandler";
import { sessions } from "../gateway/sessionRegistry";
import { app } from "../app";
import { authenticatedCommandRequest } from "./commandTestRequest";

const sessionIds: string[] = [];

afterEach(() => {
  for (const sessionId of sessionIds.splice(0)) {
    forgetSession(sessionId);
    sessionManager.frameLog.evict(sessionId);
  }
});

describe("GET /api/v1/events 恢复快照背压", () => {
  it("深链冷启动先建立 SSE 时，startSession(existing) 仍完整送达正文与长聊天史", async () => {
    const sessionId = "events-deeplink-cold-existing-restore";
    sessionIds.push(sessionId);
    const session = createSession(sessionId, "2026-08-03T00:00:00.000Z");
    session.title = "深链冷启动会话";
    session.docState = { kind: "editing" };
    session.docVersion = 9;
    session.legacySections = [{ kind: "p", data: { text: "深链恢复正文" } }];
    session.doc = {
      type: "doc",
      attrs: { schemaVersion: 1 },
      content: [{
        type: "paragraph",
        attrs: { blockId: "deeplink-body" },
        content: [{ type: "text", text: "深链恢复正文" }],
      }],
    };
    session._workingMemorySnapshotLoaded = true;
    session._workingMemorySnapshotPersistable = false;
    session.chatHistory = Array.from({ length: 70 }, (_, index) => ({
      id: `deeplink-history-${index + 1}`,
      role: { kind: index % 2 === 0 ? "user" as const : "agent" as const },
      ts: "2026-08-03T00:00:00.000Z",
      parts: [{
        kind: "text" as const,
        data: { body: `深链历史消息 ${index + 1}` },
      }],
      chips: null,
    }));
    sessions.set(sessionId, session);

    // 模拟 URL 带 session 的首次 mount：事件通道先打开，随后后台命令才开始产出恢复批次。
    const epoch = sessionManager.frameLog.getEpoch(sessionId);
    const controller = new AbortController();
    const events = await app.request(
      `/api/v1/events?sessionId=${encodeURIComponent(sessionId)}&after=0&epoch=${epoch}`,
      { signal: controller.signal },
    );
    const command = await authenticatedCommandRequest("/api/v1/commands", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        kind: "startSession",
        data: { mode: { kind: "existing", data: { id: sessionId } } },
      }),
    });
    expect(command.status).toBe(200);

    const frames = await readUntilRestoreCompleted(events, controller);
    expect(frames.some((frame) => frame.kind === "documentSnapshotWritten")).toBe(true);
    expect(frames.filter((frame) => frame.kind === "chatMessageAdded")).toHaveLength(70);
    expect(frames.at(-1)?.kind).toBe("sessionRestoreCompleted");
  });

  it("恢复快照超过 live 队列帧数上限时仍能一次完整送达", async () => {
    const sessionId = "events-restore-over-live-frame-limit";
    sessionIds.push(sessionId);
    const session = createSession(sessionId, "2026-07-30T00:00:00.000Z");
    session.title = "长历史会话";
    session.chatHistory = Array.from({ length: 70 }, (_, index) => ({
      id: `history-${index + 1}`,
      role: { kind: "user" as const },
      ts: "2026-07-30T00:00:00.000Z",
      parts: [{
        kind: "text" as const,
        data: { body: `历史消息 ${index + 1}` },
      }],
      chips: null,
    }));
    sessions.set(sessionId, session);

    const epoch = sessionManager.frameLog.getEpoch(sessionId);
    const controller = new AbortController();
    const response = await app.request(
      `/api/v1/events?sessionId=${encodeURIComponent(sessionId)}&after=999999&epoch=${epoch}`,
      { signal: controller.signal },
    );

    const frames = await readUntilRestoreCompleted(response, controller);
    expect(frames.filter((frame) => frame.kind === "restoreReset")).toHaveLength(1);
    expect(frames.filter((frame) => frame.kind === "chatMessageAdded")).toHaveLength(70);
    expect(frames.at(-1)?.kind).toBe("sessionRestoreCompleted");
  });
});

async function readUntilRestoreCompleted(
  response: Response,
  controller: AbortController,
): Promise<Array<{ kind: string }>> {
  expect(response.status).toBe(200);
  const reader = response.body?.pipeThrough(new TextDecoderStream()).getReader();
  if (!reader) throw new Error("events response has no body");
  const frames: Array<{ kind: string }> = [];
  let buffer = "";
  try {
    const deadline = Date.now() + 3_000;
    while (Date.now() < deadline) {
      const remaining = Math.max(1, deadline - Date.now());
      const result = await readWithTimeout(reader, remaining);
      if (result.done) break;
      buffer += result.value;
      const chunks = buffer.split("\n\n");
      buffer = chunks.pop() ?? "";
      for (const chunk of chunks) {
        const frame = parseFrame(chunk);
        if (!frame) continue;
        frames.push(frame);
        if (frame.kind === "sessionRestoreCompleted") return frames;
      }
    }
    return frames;
  } finally {
    controller.abort();
    await reader.cancel().catch(() => undefined);
  }
}

async function readWithTimeout(
  reader: ReadableStreamDefaultReader<string>,
  timeoutMs: number,
): Promise<ReadableStreamReadResult<string>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("restore stream timed out")),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function parseFrame(chunk: string): { kind: string } | null {
  let event = "";
  const data: string[] = [];
  for (const line of chunk.split(/\r?\n/)) {
    if (line.startsWith("event: ")) event = line.slice(7);
    else if (line.startsWith("data: ")) data.push(line.slice(6));
  }
  if (event !== "frame" || data.length === 0) return null;
  const frame = JSON.parse(data.join("\n")) as { kind?: unknown };
  return typeof frame.kind === "string" ? { kind: frame.kind } : null;
}
