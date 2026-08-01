import { afterEach, describe, expect, it, vi } from "vitest";
import { app } from "../app";
import type { BridgeFrame } from "@qingagent/contract-ts";
import {
  forgetSession,
  getSession,
  handleCommand,
  sessionManager,
} from "../gateway/bridgeHandler";

const sessionIds: string[] = [];

afterEach(() => {
  vi.useRealTimers();
  for (const sessionId of sessionIds.splice(0)) {
    forgetSession(sessionId);
    sessionManager.frameLog.evict(sessionId);
  }
  vi.restoreAllMocks();
});

describe("GET /api/v1/events 回放背压", () => {
  it("live 溢出会结束旧 HTTP，并从最后已收 seq 重连回放候选终态", async () => {
    const sessionId = "main-events-live-overflow-reconnect";
    sessionIds.push(sessionId);
    sessionManager.frameLog.append(sessionId, {
      kind: "stream",
      data: { kind: "start", data: { streamId: "stream-overflow" } },
    });

    const overflowLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const firstResponse = await app.request(
      `/api/v1/events?sessionId=${encodeURIComponent(sessionId)}&after=0`,
    );

    for (let index = 1; index <= 66; index += 1) {
      sessionManager.frameLog.append(sessionId, {
        kind: "sessionMeta",
        data: {
          sessionId,
          title: `批量编辑帧 ${index} ${"文".repeat(2_000)}`,
        },
      });
    }
    sessionManager.frameLog.append(sessionId, {
      kind: "docDiffReady",
      data: {
        baseVersion: 1,
        suggestions: [{
          id: "overflow-review-1",
          docId: "doc-overflow",
          baseVersion: 1,
          baseSchemaVersion: 1,
          status: "reviewing",
          anchor: {
            blockId: "dialogue-1",
            pmFrom: 1,
            pmTo: 2,
            quote: "旧",
            textHash: "overflow-anchor",
          },
          patch: {
            kind: "prosemirror_steps",
            steps: [{ stepType: "replace", from: 1, to: 2 }],
          },
          preview: { deleteText: "旧", insertText: "新" },
          summary: "对白文言化",
        }],
      },
    });
    sessionManager.frameLog.append(sessionId, {
      kind: "docStateChanged",
      data: {
        state: { kind: "pendingReview" },
        activeOverlay: null,
        agentBusy: false,
      },
    });
    sessionManager.frameLog.append(sessionId, {
      kind: "stream",
      data: {
        kind: "end",
        data: { streamId: "stream-overflow", reason: { kind: "done" } },
      },
    });

    const firstFrames = await readUntilClosed(firstResponse, 1_000);
    expect(overflowLog).toHaveBeenCalledWith(
      "[events] SSE pump closed",
      expect.objectContaining({
        sessionId,
        reason: "overflow",
        queuedFrames: 65,
      }),
    );
    const overflowDetails = overflowLog.mock.calls.find(
      ([message]) => message === "[events] SSE pump closed",
    )?.[1] as { queuedBytes: number } | undefined;
    expect(overflowDetails?.queuedBytes).toBeGreaterThan(128 * 1024);
    expect(overflowDetails?.queuedBytes).toBeLessThan(512 * 1024);
    const after = Number(firstFrames.at(-1)?.id ?? 0);
    const reconnectController = new AbortController();
    const reconnectResponse = await app.request(
      `/api/v1/events?sessionId=${encodeURIComponent(sessionId)}&after=${after}`,
      { signal: reconnectController.signal },
    );
    const replayed = await readFramesUntil(
      reconnectResponse,
      reconnectController,
      (frame) => frame.kind === "stream" && frame.data.kind === "end",
    );

    expect(replayed.find((entry) => entry.frame.kind === "docDiffReady")?.frame)
      .toMatchObject({
        kind: "docDiffReady",
        data: { suggestions: [{ id: "overflow-review-1" }] },
      });
    expect(replayed.find((entry) => entry.frame.kind === "docStateChanged")?.frame)
      .toMatchObject({
        kind: "docStateChanged",
        data: { state: { kind: "pendingReview" }, agentBusy: false },
      });
    expect(replayed.at(-1)?.frame).toMatchObject({
      kind: "stream",
      data: { kind: "end", data: { reason: { kind: "done" } } },
    });
  });

  it("导航断开后后台完成，重进按游标回放标题、完整正文与 end 终态", async () => {
    const sessionId = "main-events-navigation-background-finish";
    sessionIds.push(sessionId);
    for await (const _frame of handleCommand({
      kind: "startSession",
      data: {
        mode: {
          kind: "new",
          data: { sessionId, template: null },
        },
      },
    })) {
      // 建立真实会话注册；本用例用同一个 SessionManager/Actor 与 /events 路由跑后台轮次。
    }
    const session = getSession(sessionId);
    if (!session) throw new Error("missing navigation background session");

    const generationController = new AbortController();
    session._abortController = generationController;
    let started!: () => void;
    const startedPromise = new Promise<void>((resolve) => { started = resolve; });
    let release!: () => void;
    const releasePromise = new Promise<void>((resolve) => { release = resolve; });
    const finalDoc = {
      type: "doc" as const,
      attrs: { schemaVersion: 1 as const },
      content: [{
        type: "paragraph" as const,
        attrs: { blockId: "navigation-background-final" },
        content: [{ type: "text" as const, text: "离开首页后后台写完，回来仍是完整正文。" }],
      }],
    };

    const running = sessionManager.runExclusive(sessionId, async function* () {
      yield {
        kind: "stream",
        data: { kind: "start", data: { streamId: "navigation-background-stream" } },
      };
      yield {
        kind: "docGenerationEvent",
        data: {
          kind: "inline_appended",
          data: {
            generationId: "navigation-background-generation",
            seq: 1,
            prevSeq: null,
            blockId: "navigation-background-final",
            index: 0,
            appendOffset: 0,
            run: { text: "离开首页后" },
          },
        },
      };
      started();
      await releasePromise;
      session.title = "后台完成标题";
      session.doc = finalDoc;
      session.docVersion = 7;
      yield {
        kind: "sessionMeta",
        data: { sessionId, title: session.title },
      };
      yield {
        kind: "documentSnapshotWritten",
        data: {
          doc: {
            version: 7,
            ts: "2026-08-01T00:00:00.000Z",
            doc: finalDoc,
          },
        },
      };
      yield {
        kind: "docGenerationEvent",
        data: {
          kind: "generation_finished",
          data: {
            generationId: "navigation-background-generation",
            seq: 2,
            prevSeq: 1,
            doc: finalDoc,
            finalVersion: 7,
            contentHash: "navigation-background-hash",
          },
        },
      };
      yield {
        kind: "stream",
        data: {
          kind: "end",
          data: {
            streamId: "navigation-background-stream",
            reason: { kind: "done" },
            finalDocument: {
              version: 7,
              contentHash: "navigation-background-hash",
              doc: finalDoc,
            },
          },
        },
      };
    });
    await startedPromise;

    vi.useFakeTimers();
    const firstController = new AbortController();
    const firstResponse = await app.request(
      `/api/v1/events?sessionId=${encodeURIComponent(sessionId)}&after=0`,
      { signal: firstController.signal },
    );
    const firstFrames = await readFrames(firstResponse, firstController, 2);
    const cursor = Number(firstFrames.at(-1)?.id ?? 0);
    await vi.advanceTimersByTimeAsync(60_000);
    const abortedAfterNavigation = generationController.signal.aborted;

    release();
    await running;
    vi.useRealTimers();

    expect(abortedAfterNavigation).toBe(false);
    expect(session.title).toBe("后台完成标题");
    expect(session.doc).toEqual(finalDoc);
    expect(sessionManager.frameLog.readFrom(sessionId, Number.MAX_SAFE_INTEGER).activeRunner)
      .toBe(false);

    const reconnectController = new AbortController();
    const reconnectResponse = await app.request(
      `/api/v1/events?sessionId=${encodeURIComponent(sessionId)}&after=${cursor}`,
      { signal: reconnectController.signal },
    );
    const replayed = await readFramesUntil(
      reconnectResponse,
      reconnectController,
      (frame) => frame.kind === "stream" && frame.data.kind === "end",
    );
    expect(replayed.map((entry) => entry.frame)).toEqual([
      {
        kind: "sessionMeta",
        data: { sessionId, title: "后台完成标题" },
      },
      {
        kind: "documentSnapshotWritten",
        data: {
          doc: {
            version: 7,
            ts: "2026-08-01T00:00:00.000Z",
            doc: finalDoc,
          },
        },
      },
      expect.objectContaining({
        kind: "docGenerationEvent",
        data: expect.objectContaining({ kind: "generation_finished" }),
      }),
      expect.objectContaining({
        kind: "stream",
        data: expect.objectContaining({
          kind: "end",
          data: expect.objectContaining({
            reason: { kind: "done" },
            finalDocument: expect.objectContaining({ doc: finalDoc }),
          }),
        }),
      }),
    ]);
  });

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

  it("慢客户端 live 溢出后可从 FrameLog 重放 reasoning、终稿与 end 收据", async () => {
    const sessionId = "main-events-terminal-replay";
    sessionIds.push(sessionId);
    for (let index = 1; index <= 70; index += 1) {
      sessionManager.frameLog.append(sessionId, {
        kind: "docGenerationEvent",
        data: {
          kind: "inline_appended",
          data: {
            generationId: "g-terminal-replay",
            seq: index,
            prevSeq: index === 1 ? null : index - 1,
            blockId: "draft-progress",
            index: 0,
            appendOffset: index - 1,
            run: { text: "片" },
          },
        },
      });
    }
    const doc = {
      type: "doc" as const,
      attrs: { schemaVersion: 1 as const },
      content: [{
        type: "paragraph" as const,
        attrs: { blockId: "terminal-replay" },
        content: [{ type: "text" as const, text: "最终正文" }],
      }],
    };
    sessionManager.frameLog.append(sessionId, {
      kind: "docGenerationEvent",
      data: {
        kind: "generation_finished",
        data: {
          generationId: "g-terminal-replay",
          seq: 2,
          prevSeq: 1,
          doc,
          finalVersion: 5,
          contentHash: "hash-terminal-replay",
        },
      },
    });
    sessionManager.frameLog.append(sessionId, {
      kind: "stream",
      data: {
        kind: "end",
        data: {
          streamId: "stream-terminal-replay",
          reason: { kind: "done" },
          finalDocument: {
            version: 5,
            contentHash: "hash-terminal-replay",
            doc,
          },
        },
      },
    });

    const controller = new AbortController();
    const response = await app.request(
      `/api/v1/events?sessionId=${encodeURIComponent(sessionId)}&after=0`,
      { signal: controller.signal },
    );
    const frames = await readFrames(response, controller, 72);
    expect(frames).toHaveLength(72);
    expect(JSON.parse(frames.at(-2)!.data)).toMatchObject({
      kind: "docGenerationEvent",
      data: {
        kind: "generation_finished",
        data: { finalVersion: 5 },
      },
    });
    expect(JSON.parse(frames.at(-1)!.data)).toMatchObject({
      kind: "stream",
      data: {
        kind: "end",
        data: {
          reason: { kind: "done" },
          finalDocument: { version: 5 },
        },
      },
    });
  });

  it("FrameLog 超过 2000 帧形成 gap 后恢复最新 canonical 文档与 idle 终态", async () => {
    const sessionId = "main-events-gap-restore-terminal";
    sessionIds.push(sessionId);
    for await (const _frame of handleCommand({
      kind: "startSession",
      data: {
        mode: {
          kind: "new",
          data: { sessionId, template: null },
        },
      },
    })) {
      // 直接创建真实缓存会话；本用例只关心随后 /events 的只读 restore。
    }
    const session = getSession(sessionId);
    if (!session) throw new Error("missing gap restore session");
    const latestDoc = {
      type: "doc" as const,
      attrs: { schemaVersion: 1 as const },
      content: [{
        type: "paragraph" as const,
        attrs: { blockId: "gap-restore-latest" },
        content: [{ type: "text" as const, text: "超过两千帧后仍恢复的最新正文" }],
      }],
    };
    session.doc = latestDoc;
    session.legacySections = [{
      kind: "p",
      data: { text: "超过两千帧后仍恢复的最新正文" },
    }];
    session.docVersion = 23;
    session.docState = { kind: "editing" };
    session.streamId = null;
    session.runId = null;

    for (let index = 0; index < 2_005; index += 1) {
      sessionManager.frameLog.append(sessionId, {
        kind: "sessionMeta",
        data: { sessionId, title: `噪声帧 ${index}` },
      });
    }
    expect(sessionManager.frameLog.readFrom(sessionId, 0).gap).toBe(true);

    const controller = new AbortController();
    const response = await app.request(
      `/api/v1/events?sessionId=${encodeURIComponent(sessionId)}&after=0`,
      { signal: controller.signal },
    );
    const frames = await readFramesUntil(
      response,
      controller,
      (frame) => frame.kind === "sessionRestoreCompleted",
    );
    const restored = frames.map((frame) => frame.frame);

    expect(restored[0]).toMatchObject({ kind: "restoreReset" });
    expect(restored.find((frame) => frame.kind === "documentSnapshotWritten"))
      .toMatchObject({
        kind: "documentSnapshotWritten",
        data: {
          doc: {
            version: 23,
            doc: latestDoc,
          },
        },
      });
    expect(restored.find((frame) => frame.kind === "docStateChanged"))
      .toEqual({
        kind: "docStateChanged",
        data: {
          state: { kind: "editing" },
          activeOverlay: null,
          agentBusy: false,
        },
      });
    expect(restored.at(-1)).toEqual({
      kind: "sessionRestoreCompleted",
      data: { sessionId },
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

async function readUntilClosed(
  response: Response,
  timeoutMs: number,
): Promise<Array<{ id: string; data: string }>> {
  expect(response.status).toBe(200);
  const reader = response.body?.pipeThrough(new TextDecoderStream()).getReader();
  if (!reader) throw new Error("events response has no body");
  const frames: Array<{ id: string; data: string }> = [];
  let buffer = "";
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const remaining = Math.max(1, deadline - Date.now());
    const { value, done } = await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error("overflow response did not close")),
          remaining,
        );
      }),
    ]).finally(() => {
      if (timeout) clearTimeout(timeout);
    });
    if (done) return frames;
    buffer += value;
    const chunks = buffer.split("\n\n");
    buffer = chunks.pop() ?? "";
    for (const chunk of chunks) {
      const parsed = parseFrame(chunk);
      if (parsed) frames.push(parsed);
    }
  }
  throw new Error("overflow response did not close");
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

async function readFramesUntil(
  response: Response,
  controller: AbortController,
  done: (frame: BridgeFrame) => boolean,
): Promise<Array<{ id: string; frame: BridgeFrame }>> {
  expect(response.status).toBe(200);
  const reader = response.body?.pipeThrough(new TextDecoderStream()).getReader();
  if (!reader) throw new Error("events response has no body");
  const frames: Array<{ id: string; frame: BridgeFrame }> = [];
  let buffer = "";
  try {
    while (frames.length < 100) {
      const { value, done: streamDone } = await reader.read();
      if (streamDone) break;
      buffer += value;
      const chunks = buffer.split("\n\n");
      buffer = chunks.pop() ?? "";
      for (const chunk of chunks) {
        const parsed = parseFrame(chunk);
        if (!parsed) continue;
        const frame = JSON.parse(parsed.data) as BridgeFrame;
        frames.push({ id: parsed.id, frame });
        if (done(frame)) return frames;
      }
    }
    throw new Error("terminal restore frame not received");
  } finally {
    controller.abort();
    await reader.cancel().catch(() => undefined);
  }
}
