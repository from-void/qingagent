import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ServerStream } from "../serverStream";
import type { AskUserQuestion, BridgeFrame } from "@qingagent/contract-ts";
import type { WorkspaceLocalAction } from "../protocol";

const VALID_FRAME: BridgeFrame = {
  kind: "sessionMeta",
  data: { title: "Test", sessionId: "s-1" },
};

const INVALID_FRAME: BridgeFrame = {
  kind: "chatMessageAppended",
  data: {
    messageId: "",
    seq: 1,
    part: { kind: "text", data: { body: "x" } },
  },
};

const STREAM_START_FRAME: BridgeFrame = {
  kind: "stream",
  data: {
    kind: "start",
    data: { streamId: "stream-1" },
  },
};

class MockEventSource extends EventTarget {
  static instances: MockEventSource[] = [];
  onerror: ((event: Event) => void) | null = null;
  closed = false;

  constructor(readonly url: string) {
    super();
    MockEventSource.instances.push(this);
  }

  close(): void {
    this.closed = true;
  }

  emitFrame(frame: unknown, id = "1"): void {
    if (this.closed) return;
    const event = new MessageEvent("frame", {
      data: JSON.stringify(frame),
      lastEventId: id,
    });
    this.dispatchEvent(event);
  }
}

function commandResponse(body: unknown = { accepted: true, sessionId: "s-1", epoch: 1 }, status = 200) {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as unknown as Response);
}

function ssePayload(...frames: unknown[]): string {
  return frames.map((f) => `data: ${JSON.stringify(f)}\n`).join("\n") + "\n";
}

function makeReadableStream(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let i = 0;
  return new ReadableStream({
    pull(controller) {
      if (i < chunks.length) {
        controller.enqueue(encoder.encode(chunks[i]!));
        i++;
      } else {
        controller.close();
      }
    },
  });
}

function askMoreFetch(body: ReadableStream<Uint8Array>, status = 200) {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    body,
    json: () => Promise.resolve({}),
  } as unknown as Response);
}

function mockCommitFetch(body: string, status = 200, ok = true) {
  return vi.fn().mockResolvedValue({
    ok,
    status,
    text: vi.fn().mockResolvedValue(body),
    json: vi.fn(),
  } as unknown as Response);
}

async function waitForEventSource(): Promise<MockEventSource> {
  for (let i = 0; i < 10; i++) {
    const source = MockEventSource.instances.at(-1);
    if (source) return source;
    await Promise.resolve();
  }
  throw new Error("EventSource was not created");
}

describe("ServerStream", () => {
  const originalFetch = globalThis.fetch;
  const originalEventSource = globalThis.EventSource;

  beforeEach(() => {
    vi.restoreAllMocks();
    MockEventSource.instances = [];
    globalThis.EventSource = MockEventSource as unknown as typeof EventSource;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    globalThis.EventSource = originalEventSource;
    vi.useRealTimers();
  });

  it("subscribe / unsubscribe works", () => {
    const stream = new ServerStream();
    const collected: BridgeFrame[] = [];
    const unsub = stream.subscribe((f) => collected.push(f));
    unsub();
    expect(collected).toHaveLength(0);
  });

  it("startSession 提交命令后通过 EventSource 分发帧", async () => {
    globalThis.fetch = commandResponse({ accepted: true, sessionId: "s-1", epoch: 7 });
    const stream = new ServerStream();
    const frames: BridgeFrame[] = [];
    stream.subscribe((f) => frames.push(f));

    const promise = stream.startSession({ mode: { kind: "new", data: { template: null } } });
    const source = await waitForEventSource();
    expect(source.url).toContain("/api/v1/events?");
    expect(source.url).toContain("sessionId=s-1");
    source.emitFrame(VALID_FRAME, "1");

    await expect(promise).resolves.toBe("s-1");
    expect(frames).toEqual([VALID_FRAME]);
    expect(globalThis.fetch).toHaveBeenCalledWith(
      "/api/v1/commands",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("drops invalid frames from EventSource", async () => {
    globalThis.fetch = commandResponse({ accepted: true, sessionId: "s-1", epoch: 1 });
    const stream = new ServerStream();
    const frames: BridgeFrame[] = [];
    stream.subscribe((f) => frames.push(f));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const promise = stream.startSession({ mode: { kind: "new", data: { template: null } } });
    const source = await waitForEventSource();
    source.emitFrame(INVALID_FRAME, "1");
    source.emitFrame(VALID_FRAME, "2");

    await promise;
    expect(frames).toEqual([VALID_FRAME]);
    expect(errorSpy).toHaveBeenCalled();
  });

  it("stop() aborts an in-flight command submit without closing EventSource", async () => {
    let abortSignal: AbortSignal | undefined;
    globalThis.fetch = vi.fn().mockImplementation((_url: string, init: RequestInit) => {
      abortSignal = init.signal as AbortSignal;
      return new Promise((_resolve, reject) => {
        abortSignal?.addEventListener("abort", () => {
          reject(new DOMException("Aborted", "AbortError"));
        });
      });
    });

    const stream = new ServerStream();
    const promise = stream.sendCommand({
      kind: "sendMessage",
      data: {
        sessionId: "s-1",
        text: "hello",
        mentions: [],
        skills: [],
        chips: [],
        fileIds: [],
      },
    });

    stream.stop();
    expect(abortSignal?.aborted).toBe(true);
    await expect(promise).resolves.toBeUndefined();
  });

  it("stop() dispatches local stream termination", () => {
    const localActions: WorkspaceLocalAction[] = [];
    const stream = new ServerStream((action) => localActions.push(action));

    stream.stop();

    expect(localActions).toContainEqual({
      kind: "streamTerminated",
      reason: "stop",
    });
  });

  it("dispose() only detaches EventSource and clears listeners", async () => {
    globalThis.fetch = commandResponse({ accepted: true, sessionId: "s-1", epoch: 1 });
    const stream = new ServerStream();
    const frames: BridgeFrame[] = [];
    stream.subscribe((f) => frames.push(f));

    const promise = stream.startSession({ mode: { kind: "new", data: { template: null } } });
    const source = await waitForEventSource();
    source.emitFrame(VALID_FRAME, "1");
    await promise;

    stream.dispose();
    expect(source.closed).toBe(true);
    source.emitFrame({ kind: "restoreReset", data: { epoch: 1, snapshotSeq: 2 } }, "2");
    expect(frames).toHaveLength(1);
  });

  it("sendCommand with sendMessage posts to /commands and includes fileIds", async () => {
    let capturedBody: string | undefined;
    globalThis.fetch = vi.fn().mockImplementation((_url: string, init: RequestInit) => {
      capturedBody = init.body as string;
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ accepted: true, sessionId: "s-1", epoch: 1 }),
      } as unknown as Response);
    });

    const stream = new ServerStream();
    await stream.sendCommand({
      kind: "sendMessage",
      data: {
        sessionId: "s-1",
        text: "check this",
        mentions: [],
        skills: [],
        chips: [],
        fileIds: ["file-abc-123"],
      },
    });

    const parsed = JSON.parse(capturedBody!);
    expect(parsed.kind).toBe("sendMessage");
    expect(parsed.data.fileIds).toEqual(["file-abc-123"]);
  });

  it("updateDoc waits for the matching docWriteResult frame", async () => {
    let capturedBody: string | undefined;
    globalThis.fetch = vi.fn().mockImplementation((_url: string, init: RequestInit) => {
      capturedBody = init.body as string;
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve([{ kind: "docWriteResult" }]),
      } as unknown as Response);
    });

    const stream = new ServerStream();
    const frames: BridgeFrame[] = [];
    stream.subscribe((f) => frames.push(f));
    const promise = stream.sendCommand({
      kind: "updateDoc",
      data: {
        sessionId: "s-1",
        expectedDocumentSnapshot: 1,
        legacySections: [{ kind: "p", data: { text: "正文" } }],
        clientMutationId: "mutation-1",
      },
    });

    const source = await waitForEventSource();
    source.emitFrame({
      kind: "docWriteResult",
      data: { ok: true, clientMutationId: "mutation-1", docVersion: 2 },
    } satisfies BridgeFrame, "3");

    await expect(promise).resolves.toBeUndefined();
    const parsed = JSON.parse(capturedBody!);
    expect(parsed.kind).toBe("updateDoc");
    expect(frames[0]?.kind).toBe("docWriteResult");
  });

  it("startSession then sendMessage flows over command/event split", async () => {
    let callCount = 0;
    globalThis.fetch = vi.fn().mockImplementation(() => {
      callCount++;
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve(
            callCount === 1
              ? { accepted: true, sessionId: "s-new", epoch: 1 }
              : { accepted: true, sessionId: "s-new", epoch: 1 },
          ),
      } as unknown as Response);
    });

    const stream = new ServerStream();
    const frames: BridgeFrame[] = [];
    stream.subscribe((f) => frames.push(f));

    const sessionPromise = stream.startSession({
      mode: { kind: "new", data: { template: null } },
    });
    const source = await waitForEventSource();
    source.emitFrame({ kind: "sessionMeta", data: { title: "Test", sessionId: "s-new" } } satisfies BridgeFrame, "1");
    const sessionId = await sessionPromise;

    await stream.sendCommand({
      kind: "sendMessage",
      data: {
        sessionId,
        text: "analyze this",
        mentions: [],
        skills: [],
        chips: [],
        fileIds: ["file-def-456"],
      },
    });
    source.emitFrame({
      kind: "chatMessageAppended",
      data: {
        messageId: "m-1",
        seq: 1,
        part: { kind: "text", data: { body: "Got your file" } },
      },
    } satisfies BridgeFrame, "2");

    expect(frames.map((frame) => frame.kind)).toEqual(["sessionMeta", "chatMessageAppended"]);
  });

  it("commitReviewGroups 对 REST 和 EventSource 的同 seq 帧只分发一次", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve([{ seq: 1, frame: VALID_FRAME }]),
      text: () => Promise.resolve(JSON.stringify([{ seq: 1, frame: VALID_FRAME }])),
    } as unknown as Response);
    const stream = new ServerStream();
    const frames: BridgeFrame[] = [];
    stream.subscribe((f) => frames.push(f));

    const returned = await stream.commitReviewGroups("s-1", {
      acceptReviewBatchIds: ["review-batch-1"],
    });
    const source = await waitForEventSource();
    source.emitFrame(VALID_FRAME, "1");

    expect(returned).toEqual([VALID_FRAME]);
    expect(frames).toEqual([VALID_FRAME]);
  });

  it("handles restoreReset frames", async () => {
    globalThis.fetch = commandResponse({ accepted: true, sessionId: "s-1", epoch: 1 });
    const stream = new ServerStream();
    const frames: BridgeFrame[] = [];
    stream.subscribe((f) => frames.push(f));
    const promise = stream.startSession({ mode: { kind: "new", data: { template: null } } });
    const source = await waitForEventSource();
    source.emitFrame(VALID_FRAME, "1");
    await promise;
    source.emitFrame({ kind: "restoreReset", data: { epoch: 2, snapshotSeq: 2 } } satisfies BridgeFrame, "2");

    expect(frames.at(-1)).toEqual({ kind: "restoreReset", data: { epoch: 2, snapshotSeq: 2 } });
  });

  it("restoreReset 的 seq 回退必须被接受并回拨去重游标(服务端日志重置后恢复帧不得丢)", async () => {
    // 回归(review-loop-0702 lane-B round-1):服务端热重启后 FrameLog 清空、seq 从头计,
    // /events 会推 restoreReset(小 seq)+ 恢复快照帧。修复前 emitLoggedFrame 的单调 seq
    // 去重不认 restoreReset → lastSeq 停在旧日志大 seq,恢复帧全被丢弃,页面永久静默
    // (真机:server 跑完整轮 turn,UI 零反应)。
    globalThis.fetch = commandResponse({ accepted: true, sessionId: "s-1", epoch: 1 });
    const stream = new ServerStream();
    const frames: BridgeFrame[] = [];
    stream.subscribe((f) => frames.push(f));
    const promise = stream.startSession({ mode: { kind: "new", data: { template: null } } });
    const source = await waitForEventSource();
    source.emitFrame(VALID_FRAME, "1");
    await promise;
    // 旧日志推进到大 seq
    source.emitFrame(STREAM_START_FRAME, "500");
    expect(frames).toHaveLength(2);

    // 服务端日志重置:restoreReset 以小 seq 到来,必须被接受
    const reset: BridgeFrame = { kind: "restoreReset", data: { epoch: 2, snapshotSeq: 3 } };
    source.emitFrame(reset, "3");
    expect(frames.at(-1)).toEqual(reset);

    // 其后的恢复帧(seq 继续从小处递增)也必须送达
    source.emitFrame(VALID_FRAME, "4");
    expect(frames).toHaveLength(4);
    expect(frames.at(-1)).toEqual(VALID_FRAME);

    // 去重语义仍在:重复 seq 不重复分发
    source.emitFrame(VALID_FRAME, "4");
    expect(frames).toHaveLength(4);
  });

  it("throws on non-ok command response", async () => {
    globalThis.fetch = commandResponse({}, 500);
    const stream = new ServerStream();

    await expect(
      stream.sendCommand({
        kind: "sendMessage",
        data: {
          sessionId: "s-1",
          text: "bad",
          mentions: [],
          skills: [],
          chips: [],
          fileIds: [],
        },
      }),
    ).rejects.toThrow("Stream request failed: 500");
  });

  it("commitReviewGroups 对 502 HTML 响应报清晰 status 错误,不冒出 JSON.parse 原始错误", async () => {
    globalThis.fetch = mockCommitFetch(
      "<html><body>Bad gateway sk-abcdefghijklmnopqrstuvwxyz</body></html>",
      502,
      true,
    );

    const stream = new ServerStream();
    let error: unknown;
    try {
      await stream.commitReviewGroups("s-1", { acceptReviewBatchIds: ["review-1"] });
    } catch (err) {
      error = err;
    }

    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toContain("commit failed: HTTP 502 returned non-JSON response");
    expect(message).toContain("Bad gateway");
    expect(message).not.toContain("Unexpected token");
    expect(message).not.toContain("sk-abcdefghijklmnopqrstuvwxyz");
    expect(message).toContain("sk-[redacted]");
  });

  it("commitReviewGroups 对截断 JSON 报 non-JSON response,不冒出 Unexpected token", async () => {
    globalThis.fetch = mockCommitFetch(`[${JSON.stringify(VALID_FRAME).slice(0, 24)}`, 200);

    const stream = new ServerStream();
    let error: unknown;
    try {
      await stream.commitReviewGroups("s-1", { acceptReviewBatchIds: ["review-1"] });
    } catch (err) {
      error = err;
    }

    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toContain("commit failed: HTTP 200 returned non-JSON response");
    expect(message).not.toContain("Unexpected token");
  });

  it("commitReviewGroups 对 JSON 非数组响应报 frame array 错误", async () => {
    globalThis.fetch = mockCommitFetch(JSON.stringify(VALID_FRAME), 200);

    const stream = new ServerStream();

    await expect(
      stream.commitReviewGroups("s-1", { acceptReviewBatchIds: ["review-1"] }),
    ).rejects.toThrow("commit failed: HTTP 200 returned JSON object, expected BridgeFrame array");
  });

  it("askMore ignores trailing empty question payloads and preserves partials", async () => {
    const question: AskUserQuestion = {
      id: "q-extra-tone",
      label: "语气偏好",
      kind: { kind: "single" },
      options: [{ value: "warm", label: "温和", description: null, preview: null }],
      placeholder: "",
    };
    const body = makeReadableStream([
      ssePayload({ questions: [question] }, { questions: [] }),
    ]);
    globalThis.fetch = askMoreFetch(body);

    const stream = new ServerStream();
    const progress = vi.fn();

    const result = await stream.askMore("s-1", [], {}, progress);

    expect(result).toEqual([question]);
    expect(progress).toHaveBeenCalledTimes(1);
    expect(progress).toHaveBeenCalledWith([question]);
  });

  it("askMore treats empty question payloads as a successful empty result", async () => {
    const body = makeReadableStream([ssePayload({ questions: [] })]);
    globalThis.fetch = askMoreFetch(body);

    const stream = new ServerStream();
    const progress = vi.fn();

    const result = await stream.askMore("s-1", [], {}, progress);

    expect(result).toEqual([]);
    expect(progress).not.toHaveBeenCalled();
  });
});
