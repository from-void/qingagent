import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  isStreamStalled,
  ServerStream,
  STREAM_STALL_TIMEOUT_MS,
} from "../serverStream";
import type { AskUserQuestion, BridgeFrame, Command } from "@qingagent/contract-ts";
import type { WorkspaceLocalAction } from "../protocol";
import {
  buildAttachFolderCommand,
  FolderAttachTimeoutError,
  submitAttachFolderCommand,
  type FolderAttachSelection,
} from "../folderAttach";

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

  /** 服务端 15s 心跳帧(stream.ts 的 `event: ping`)。 */
  emitPing(): void {
    if (this.closed) return;
    this.dispatchEvent(new MessageEvent("ping", { data: "{}" }));
  }
}

function commandResponse(body: unknown = { accepted: true, sessionId: "s-1", epoch: 1 }, status = 200) {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as unknown as Response);
}

function commandResponseFrom(factory: (command: Command) => unknown) {
  return vi.fn().mockImplementation((_url: string, init?: RequestInit) => {
    const command = JSON.parse(String(init?.body)) as Command;
    return Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve(factory(command)),
    } as unknown as Response);
  });
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

describe("isStreamStalled", () => {
  it("阈值是 3 个心跳周期(45 秒)", () => {
    expect(STREAM_STALL_TIMEOUT_MS).toBe(45_000);
  });

  it("刚好卡在阈值上不判死，超过才判死", () => {
    expect(isStreamStalled(45_000, 1)).toBe(false);
    expect(isStreamStalled(45_002, 1)).toBe(true);
  });

  it("没有活动基线(尚未建立连接)时永不判死", () => {
    expect(isStreamStalled(10_000_000, 0)).toBe(false);
    expect(isStreamStalled(10_000_000, Number.NaN)).toBe(false);
  });
});

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
    vi.unstubAllGlobals();
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

  it("素材摘要命令必须等匹配的 resourceUpdated 权威帧后才确认", async () => {
    globalThis.fetch = commandResponse();
    const stream = new ServerStream();
    let settled = false;
    const pending = stream
      .updateMaterialSummary("s-1", "mat-1", "新摘要")
      .then(() => {
        settled = true;
      });
    const source = await waitForEventSource();
    await Promise.resolve();
    expect(settled).toBe(false);

    source.emitFrame({
      kind: "resourceUpdated",
      data: {
        resourceRef: { id: "mat-1", domain: { kind: "file" } },
        summary: "其他摘要",
        metadata: {},
      },
    } satisfies BridgeFrame, "1");
    await Promise.resolve();
    expect(settled).toBe(false);

    source.emitFrame({
      kind: "resourceUpdated",
      data: {
        resourceRef: { id: "mat-1", domain: { kind: "file" } },
        summary: "新摘要",
        metadata: {},
      },
    } satisfies BridgeFrame, "2");
    await expect(pending).resolves.toBeUndefined();
    expect(settled).toBe(true);
    stream.dispose();
  });

  it("忽略批注命令必须等目标组的 ignored 权威帧后才确认", async () => {
    globalThis.fetch = commandResponse();
    const stream = new ServerStream();
    let settled = false;
    const pending = stream
      .ignoreAnnotationGroups("s-1", "item_ignored", {
        groupIds: ["annotation-1"],
      })
      .then(() => {
        settled = true;
      });
    const source = await waitForEventSource();
    source.emitFrame({
      kind: "annotationGroupsReady",
      data: {
        groups: [{
          id: "annotation-1",
          origin: "consistency",
          status: "reviewing",
          summary: "待核对",
          note: "尚未忽略",
          anchors: [{
            blockId: "p-1",
            pmFrom: 1,
            pmTo: 2,
            quote: "甲",
            textHash: "hash-1",
          }],
        }],
      },
    } satisfies BridgeFrame, "1");
    await Promise.resolve();
    expect(settled).toBe(false);

    source.emitFrame({
      kind: "annotationGroupsReady",
      data: {
        groups: [{
          id: "annotation-1",
          origin: "consistency",
          status: "ignored",
          summary: "待核对",
          note: "已忽略",
          anchors: [{
            blockId: "p-1",
            pmFrom: 1,
            pmTo: 2,
            quote: "甲",
            textHash: "hash-1",
          }],
        }],
      },
    } satisfies BridgeFrame, "2");
    await expect(pending).resolves.toBeUndefined();
    expect(settled).toBe(true);
    stream.dispose();
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

  it("旧确认走 session-scoped 上行时不重绑当前共享 EventSource", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ accepted: true, remembered: false }),
    } as Response);
    const stream = new ServerStream();

    await stream.resolveConfirm({
      sessionId: "old-session",
      toolCallId: "old-tool",
      decisionId: "old-decision",
      decision: { id: "old-confirm", accepted: true },
    }, { activateSession: false });

    expect(MockEventSource.instances).toHaveLength(0);
    expect(globalThis.fetch).toHaveBeenCalledWith(
      "/api/v1/confirms/decision",
      expect.objectContaining({
        method: "POST",
        body: expect.stringContaining('"sessionId":"old-session"'),
      }),
    );
  });

  it("确认提交读取 remembered，错误只显示服务端人话而不泄漏 HTTP 状态码", async () => {
    globalThis.fetch = commandResponse({ accepted: true, remembered: true });
    const stream = new ServerStream();

    await expect(stream.resolveConfirm({
      sessionId: "session-confirm",
      toolCallId: "tool-confirm",
      decisionId: "decision-confirm",
      decision: { id: "confirm-id", accepted: true },
    })).resolves.toEqual({ accepted: true, remembered: true });

    globalThis.fetch = commandResponse({ error: "这张确认已处理或已失效，请查看命令结果。" }, 409);
    await expect(stream.resolveConfirm({
      sessionId: "session-confirm",
      toolCallId: "tool-confirm",
      decisionId: "decision-confirm-2",
      decision: { id: "confirm-id", accepted: true },
    })).rejects.toThrow("这张确认已处理或已失效，请查看命令结果。");

    globalThis.fetch = commandResponse({}, 500);
    await expect(stream.resolveConfirm({
      sessionId: "session-confirm",
      toolCallId: "tool-confirm",
      decisionId: "decision-confirm-3",
      decision: { id: "confirm-id", accepted: true },
    })).rejects.toThrow(
      "确认没有提交成功，命令尚未确定是否执行。请先查看命令卡，不要连续重复点击。",
    );
  });

  it("卡级停止使用独立 toolCallId 上行", async () => {
    globalThis.fetch = commandResponse({ accepted: true }, 202);
    const stream = new ServerStream();

    await stream.cancelConfirmedCommand({
      sessionId: "session-confirm",
      toolCallId: "tool-exact",
    });

    expect(globalThis.fetch).toHaveBeenCalledWith(
      "/api/v1/confirms/cancel",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          sessionId: "session-confirm",
          toolCallId: "tool-exact",
        }),
      }),
    );
  });

  it("draftTemplate 将调用方 abortSignal 传给请求并立即拒绝", async () => {
    let requestSignal: AbortSignal | undefined;
    globalThis.fetch = vi.fn().mockImplementation((_url: string, init: RequestInit) => {
      requestSignal = init.signal as AbortSignal;
      return new Promise((_resolve, reject) => {
        requestSignal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
      });
    });
    const stream = new ServerStream();
    const controller = new AbortController();
    const promise = stream.draftTemplate({
      sessionId: "s-1",
      scene: { kind: "review", type: "role", label: "角色审查" },
      intent: { name: "", prompt: "" },
    }, controller.signal);
    controller.abort();
    expect(requestSignal?.aborted).toBe(true);
    await expect(promise).rejects.toMatchObject({ name: "AbortError" });
  });

  it("draftTemplate 等待 90 秒后会中止对应 HTTP 请求", async () => {
    vi.useFakeTimers();
    let requestSignal: AbortSignal | undefined;
    globalThis.fetch = vi.fn().mockImplementation((_url: string, init: RequestInit) => {
      const signal = init.signal as AbortSignal;
      // 只认第一发(draftTemplate 命令本身)：等待期间心跳看门狗会补发 /health 探活。
      requestSignal ??= signal;
      return new Promise((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(signal?.reason), {
          once: true,
        });
      });
    });
    const stream = new ServerStream();
    const pending = stream.draftTemplate({
      sessionId: "s-1",
      scene: { kind: "review", type: "role", label: "角色审查" },
      intent: { name: "", prompt: "" },
    });
    const rejection = expect(pending).rejects.toThrow(
      "draftTemplate completed without receiving templateDrafted frame",
    );

    await vi.advanceTimersByTimeAsync(90_000);

    expect(requestSignal?.aborted).toBe(true);
    await rejection;
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

  it("规划期 cancel() 会把 session 级取消实际 POST 到服务端并复位本地流状态", async () => {
    let capturedBody: string | undefined;
    globalThis.fetch = vi.fn().mockImplementation((_url: string, init: RequestInit) => {
      capturedBody = init.body as string;
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ accepted: true }),
      } as unknown as Response);
    });
    const localActions: WorkspaceLocalAction[] = [];
    const stream = new ServerStream((action) => localActions.push(action));

    await stream.cancel([{
      kind: "cancelStream",
      data: { sessionId: "session-planning" },
    }]);

    expect(globalThis.fetch).toHaveBeenCalledWith(
      "/api/v1/commands",
      expect.objectContaining({ method: "POST" }),
    );
    expect(JSON.parse(capturedBody!)).toEqual({
      kind: "cancelStream",
      data: { sessionId: "session-planning" },
    });
    expect(localActions).toContainEqual({
      kind: "streamTerminated",
      reason: "stop",
    });
  });

  it("写作期 cancel() 保留 streamId 定向取消和局部状态复位", async () => {
    let capturedBody: string | undefined;
    globalThis.fetch = vi.fn().mockImplementation((_url: string, init: RequestInit) => {
      capturedBody = init.body as string;
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ accepted: true }),
      } as unknown as Response);
    });
    const localActions: WorkspaceLocalAction[] = [];
    const stream = new ServerStream((action) => localActions.push(action));

    await stream.cancel([{
      kind: "cancelStream",
      data: { sessionId: "session-writing", streamId: "stream-writing" },
    }]);

    expect(JSON.parse(capturedBody!)).toEqual({
      kind: "cancelStream",
      data: { sessionId: "session-writing", streamId: "stream-writing" },
    });
    expect(localActions).toContainEqual({
      kind: "streamTerminated",
      reason: "stop",
      streamIds: ["stream-writing"],
    });
  });

  it("dispose() detaches EventSource and clears listeners", async () => {
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

  it("EventSource 错误只用 health HEAD 探活，并按游标退避正式重连", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(
        JSON.stringify({ accepted: true, sessionId: "s-1", epoch: 1 }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ))
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
    globalThis.fetch = fetchMock as typeof fetch;
    const stream = new ServerStream();
    const started = stream.startSession({ mode: { kind: "new", data: { template: null } } });
    const source = await waitForEventSource();
    source.emitFrame(VALID_FRAME, "7");
    await started;

    source.onerror?.(new Event("error"));
    await Promise.resolve();
    await Promise.resolve();
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "/health",
      expect.objectContaining({
        method: "HEAD",
        signal: expect.any(AbortSignal),
      }),
    );
    expect(source.closed).toBe(true);
    expect(MockEventSource.instances).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(999);
    expect(MockEventSource.instances).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(MockEventSource.instances).toHaveLength(2);
    expect(MockEventSource.instances[1]!.url).toContain("after=7");

    stream.dispose();
  });

  it("心跳 ping 持续到达时看门狗不误判半开", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ accepted: true, sessionId: "s-1", epoch: 1 }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    ));
    globalThis.fetch = fetchMock as typeof fetch;
    const stream = new ServerStream();
    const started = stream.startSession({ mode: { kind: "new", data: { template: null } } });
    const source = await waitForEventSource();
    source.emitFrame(VALID_FRAME, "7");
    await started;

    // 只有心跳、没有业务帧的静默期(真实场景:AI 还在思考)不得被判死。
    for (let i = 0; i < 8; i += 1) {
      await vi.advanceTimersByTimeAsync(14_000);
      source.emitPing();
    }

    expect(source.closed).toBe(false);
    expect(MockEventSource.instances).toHaveLength(1);
    // 只有 startSession 的命令请求，没有 /health 探活。
    expect(fetchMock).toHaveBeenCalledTimes(1);

    stream.dispose();
  });

  it("半开连接下 45 秒无任何帧会主动断开并走既有退避重连", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(
        JSON.stringify({ accepted: true, sessionId: "s-1", epoch: 1 }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ))
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
    globalThis.fetch = fetchMock as typeof fetch;
    const stream = new ServerStream();
    const started = stream.startSession({ mode: { kind: "new", data: { template: null } } });
    const source = await waitForEventSource();
    source.emitFrame(VALID_FRAME, "9");
    await started;

    // 阈值内不动手(onerror 在半开时永不触发，这里全靠时间判定)。
    await vi.advanceTimersByTimeAsync(40_000);
    expect(source.closed).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(10_000);
    expect(source.closed).toBe(true);
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "/health",
      expect.objectContaining({ method: "HEAD", signal: expect.any(AbortSignal) }),
    );
    expect(MockEventSource.instances).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(MockEventSource.instances).toHaveLength(2);
    // 续传游标带上，服务端按 after 补发漏掉的帧(有 gap/epoch 变更时补 restoreReset + 权威快照)。
    expect(MockEventSource.instances[1]!.url).toContain("after=9");

    stream.dispose();
  });

  it("标签页从后台切回且超阈值时立即补判半开", async () => {
    vi.useFakeTimers();
    const doc = new EventTarget() as EventTarget & { visibilityState: string };
    doc.visibilityState = "visible";
    vi.stubGlobal("document", doc);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(
        JSON.stringify({ accepted: true, sessionId: "s-1", epoch: 1 }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ))
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
    globalThis.fetch = fetchMock as typeof fetch;
    const stream = new ServerStream();
    const started = stream.startSession({ mode: { kind: "new", data: { template: null } } });
    const source = await waitForEventSource();
    source.emitFrame(VALID_FRAME, "3");
    await started;

    // 模拟休眠/后台降频：墙钟前进 5 分钟但定时器没被调度。
    doc.visibilityState = "hidden";
    vi.setSystemTime(Date.now() + 300_000);
    doc.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(0);
    expect(source.closed).toBe(false);

    doc.visibilityState = "visible";
    doc.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(0);
    expect(source.closed).toBe(true);
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "/health",
      expect.objectContaining({ method: "HEAD", signal: expect.any(AbortSignal) }),
    );

    stream.dispose();
  });

  it("dispose() 停掉心跳看门狗，不留定时器也不再重连", async () => {
    vi.useFakeTimers();
    const doc = new EventTarget() as EventTarget & { visibilityState: string };
    doc.visibilityState = "visible";
    vi.stubGlobal("document", doc);
    globalThis.fetch = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ accepted: true, sessionId: "s-1", epoch: 1 }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    )) as typeof fetch;
    const stream = new ServerStream();
    const started = stream.startSession({ mode: { kind: "new", data: { template: null } } });
    const source = await waitForEventSource();
    source.emitFrame(VALID_FRAME, "1");
    await started;
    expect(vi.getTimerCount()).toBeGreaterThan(0);

    stream.dispose();
    expect(vi.getTimerCount()).toBe(0);
    expect(source.closed).toBe(true);

    await vi.advanceTimersByTimeAsync(300_000);
    doc.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(0);
    expect(MockEventSource.instances).toHaveLength(1);
  });

  it("会话切换后旧连接的看门狗不残留", async () => {
    vi.useFakeTimers();
    globalThis.fetch = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ accepted: true, sessionId: "s-1", epoch: 1 }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    )) as typeof fetch;
    const stream = new ServerStream();
    const started = stream.startSession({ mode: { kind: "new", data: { template: null } } });
    const source = await waitForEventSource();
    source.emitFrame(VALID_FRAME, "1");
    await started;

    stream.detach();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(MockEventSource.instances).toHaveLength(1);

    stream.dispose();
  });

  it("dispose() aborts active client requests without sending a cancel command", async () => {
    let requestSignal: AbortSignal | undefined;
    globalThis.fetch = vi.fn((_url: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        requestSignal = init?.signal ?? undefined;
        requestSignal?.addEventListener("abort", () => {
          reject(new DOMException("Aborted", "AbortError"));
        });
      }));
    const stream = new ServerStream();
    const promise = stream.startSession({
      mode: { kind: "new", data: { template: null } },
    });
    await vi.waitFor(() => expect(requestSignal).toBeDefined());

    stream.dispose();

    expect(requestSignal?.aborted).toBe(true);
    await expect(promise).rejects.toThrow("startSession aborted before sessionMeta received");
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
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

  it("attach HTTP 永不返回时在 deadline 后 abort 并报超时", async () => {
    vi.useFakeTimers();
    let requestSignal: AbortSignal | undefined;
    globalThis.fetch = vi.fn((_url: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        requestSignal = init?.signal ?? undefined;
        requestSignal?.addEventListener("abort", () => {
          reject(new DOMException("Aborted", "AbortError"));
        });
      }));
    const stream = new ServerStream();
    const selection: FolderAttachSelection = {
      provider: "desktop-local",
      selectionToken: "selection-http-timeout",
    };
    const command = buildAttachFolderCommand("s-1", selection, "request-http-timeout");
    const pending = submitAttachFolderCommand(stream, command, selection, {
      timeoutMs: 1_000,
    });
    const rejected = expect(pending).rejects.toBeInstanceOf(FolderAttachTimeoutError);
    await waitForEventSource();

    await vi.advanceTimersByTimeAsync(1_000);

    await rejected;
    expect(requestSignal?.aborted).toBe(true);
    stream.dispose();
  });

  it("attach HTTP 成功但结果帧缺失时在 deadline 后 reject", async () => {
    vi.useFakeTimers();
    globalThis.fetch = commandResponse();
    const stream = new ServerStream();
    const selection: FolderAttachSelection = {
      provider: "desktop-local",
      selectionToken: "selection-frame-timeout",
    };
    const command = buildAttachFolderCommand("s-1", selection, "request-frame-timeout");
    const pending = submitAttachFolderCommand(stream, command, selection, {
      timeoutMs: 1_000,
    });
    const rejected = expect(pending).rejects.toBeInstanceOf(FolderAttachTimeoutError);
    await waitForEventSource();

    await vi.advanceTimersByTimeAsync(1_000);

    await rejected;
    stream.dispose();
  });

  it("attach 在 deadline 内收到精确匹配结果帧后成功", async () => {
    globalThis.fetch = commandResponse();
    const stream = new ServerStream();
    const selection: FolderAttachSelection = {
      provider: "desktop-local",
      selectionToken: "selection-success",
    };
    const command = buildAttachFolderCommand("s-1", selection, "request-success");
    const pending = submitAttachFolderCommand(stream, command, selection, {
      timeoutMs: 1_000,
    });
    const source = await waitForEventSource();
    source.emitFrame({
      kind: "folderSourceOperationResult",
      data: {
        ok: true,
        op: "attach",
        requestId: "other-request",
        clientSourceId: null,
        folderId: "folder-other",
      },
    } satisfies BridgeFrame, "1");
    source.emitFrame({
      kind: "folderSourceOperationResult",
      data: {
        ok: true,
        op: "attach",
        requestId: "request-success",
        clientSourceId: null,
        folderId: "folder-success",
      },
    } satisfies BridgeFrame, "2");

    await expect(pending).resolves.toMatchObject({
      ok: true,
      folderId: "folder-success",
    });
    stream.dispose();
  });

  it("attach 手动取消会 abort HTTP、结算 waiter 且迟到帧不再命中", async () => {
    let requestSignal: AbortSignal | undefined;
    globalThis.fetch = vi.fn((_url: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        requestSignal = init?.signal ?? undefined;
        requestSignal?.addEventListener("abort", () => {
          reject(new DOMException("Aborted", "AbortError"));
        });
      }));
    const stream = new ServerStream();
    const selection: FolderAttachSelection = {
      provider: "desktop-local",
      selectionToken: "selection-cancel",
    };
    const command = buildAttachFolderCommand("s-1", selection, "request-cancel");
    const controller = new AbortController();
    const pending = submitAttachFolderCommand(stream, command, selection, {
      signal: controller.signal,
      timeoutMs: 30_000,
    });
    const source = await waitForEventSource();

    controller.abort(new DOMException("Stopped waiting", "AbortError"));

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(requestSignal?.aborted).toBe(true);
    source.emitFrame({
      kind: "folderSourceOperationResult",
      data: {
        ok: true,
        op: "attach",
        requestId: "request-cancel",
        clientSourceId: null,
        folderId: "folder-late",
      },
    } satisfies BridgeFrame, "1");
    stream.dispose();
  });

  it("waitForFrame 超时后清理订阅和 timer，迟到帧不再执行 predicate", async () => {
    vi.useFakeTimers();
    const stream = new ServerStream();
    const predicate = vi.fn(() => true);
    const pending = stream.waitForFrame(predicate, "frame timeout", 10);
    const rejected = expect(pending).rejects.toThrow("frame timeout");

    await vi.advanceTimersByTimeAsync(10);
    await rejected;
    (stream as unknown as { emit: (frame: BridgeFrame) => void }).emit(VALID_FRAME);

    expect(predicate).not.toHaveBeenCalled();
    stream.dispose();
  });

  it("renameSession 等不依赖成功帧的命令遇到 422 时不再误判成功", async () => {
    globalThis.fetch = commandResponse({
      error: {
        code: "COMMAND_FAILED",
        message: "名称未能保存，请稍后重试",
      },
    }, 422);
    const stream = new ServerStream();

    await expect(stream.renameSession("s-1", "新名称")).rejects.toMatchObject({
      code: "COMMAND_FAILED",
      message: "名称未能保存，请稍后重试",
    });
  });

  it("derivative 类命令遇到业务失败时立即 reject，不再等待成功帧超时", async () => {
    globalThis.fetch = commandResponse({
      error: {
        code: "COMMAND_FAILED",
        message: "衍生稿不存在或不属于当前会话",
      },
      requestId: "request-derivative-failure",
    }, 422);
    const stream = new ServerStream();

    await expect(stream.getDerivativeDoc("s-1", "missing-doc")).rejects.toMatchObject({
      code: "COMMAND_FAILED",
      message: "衍生稿不存在或不属于当前会话",
      requestId: "request-derivative-failure",
    });
  });

  it("衍生稿列表只收到 HTTP 成功帧时立即返回空列表，不依赖 EventSource 副本", async () => {
    globalThis.fetch = commandResponseFrom((command) => [{
      kind: "derivativesListed",
      data: {
        requestId: (command.data as { requestId: string }).requestId,
        items: [],
      },
    } satisfies BridgeFrame]);
    const stream = new ServerStream();

    await expect(stream.listDerivatives("s-1")).resolves.toEqual([]);
    expect(MockEventSource.instances).toHaveLength(1);
  });

  it("HTTP 成功帧的 requestId 不匹配时立即报协议错误", async () => {
    globalThis.fetch = commandResponse([{
      kind: "derivativesListed",
      data: { requestId: "wrong-request-id", items: [] },
    } satisfies BridgeFrame]);
    const stream = new ServerStream();

    await expect(stream.listDerivatives("s-1")).rejects.toThrow(
      "derivativesListed response missing",
    );
  });

  it("HTTP 200 缺少目标成功帧时立即报协议错误", async () => {
    globalThis.fetch = commandResponse([]);
    const stream = new ServerStream();

    await expect(stream.listDerivatives("s-1")).rejects.toThrow(
      "derivativesListed response missing",
    );
  });

  it("cancelAskUser 的专项失败标记由统一 422 协议保留", async () => {
    globalThis.fetch = commandResponse({
      error: {
        code: "COMMAND_FAILED",
        message: "模型服务暂时不可用，请稍后重试",
      },
    }, 422);

    const stream = new ServerStream();
    await expect(
      stream.sendCommand({
        kind: "cancelAskUser",
        data: { sessionId: "s-1", toolCallId: "ask-1" },
      }),
    ).rejects.toMatchObject({
      code: "COMMAND_FAILED",
      cancelAskUserServerFailure: true,
      message: "模型服务暂时不可用，请稍后重试",
    });
  });

  it("P1-11: cancelAskUser 空帧数组表示幂等成功", async () => {
    globalThis.fetch = commandResponse([]);
    const stream = new ServerStream();

    await expect(
      stream.sendCommand({
        kind: "cancelAskUser",
        data: { sessionId: "s-1", toolCallId: "ask-1" },
      }),
    ).resolves.toEqual([]);
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

    await expect(promise).resolves.toEqual([{ kind: "docWriteResult" }]);
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

  it("审查模板与文档补充命令使用各自 HTTP 响应帧返回持久化结果", async () => {
    globalThis.fetch = commandResponseFrom((command) => {
      const requestId = (command.data as { requestId: string }).requestId;
      if (command.kind === "listReviewTemplates") {
        return [{
          kind: "reviewTemplatesListed",
          data: {
            requestId,
            items: [{ id: "source-default", type: "source", name: "标准来源核查", prompt: "核对金额", builtin: true, createdAt: "t", updatedAt: "t" }],
            selectedTemplateId: "source-default",
          },
        } satisfies BridgeFrame];
      }
      if (command.kind === "getReviewSupplement") {
        return [{
          kind: "reviewSupplementLoaded",
          data: { requestId, type: "source", supplement: "只看金额" },
        } satisfies BridgeFrame];
      }
      if (command.kind === "deleteReviewTemplate") {
        return [{
          kind: "reviewTemplateDeleted",
          data: { requestId, id: "source-default", selectedTemplateId: "source-default", error: "每类至少保留一个模板" },
        } satisfies BridgeFrame];
      }
      return [{
        kind: "styleTemplateDeleted",
        data: { requestId, id: "gzh-layout-classic", error: "每类至少保留一个模板" },
      } satisfies BridgeFrame];
    });
    const stream = new ServerStream();

    await expect(stream.listReviewTemplates("s-1", "source")).resolves.toMatchObject({
      selectedTemplateId: "source-default",
    });
    await expect(stream.getReviewSupplement("s-1", "source")).resolves.toBe("只看金额");
    await expect(stream.deleteReviewTemplate("s-1", "source-default"))
      .rejects.toThrow("每类至少保留一个模板");
    await expect(stream.deleteStyleTemplate("s-1", "gzh-layout-classic"))
      .rejects.toThrow("每类至少保留一个模板");
  });

  it("两个并发衍生稿列表的 HTTP 响应乱序时仍按 requestId 结算", async () => {
    const pending: Array<{
      command: Extract<Command, { kind: "listDerivatives" }>;
      resolve: (response: Response) => void;
    }> = [];
    globalThis.fetch = vi.fn().mockImplementation((_url: string, init?: RequestInit) =>
      new Promise<Response>((resolve) => {
        pending.push({
          command: JSON.parse(String(init?.body)) as Extract<Command, { kind: "listDerivatives" }>,
          resolve,
        });
      }),
    );
    const stream = new ServerStream();
    const listA = stream.listDerivatives("session-a");
    const listB = stream.listDerivatives("session-b");
    await Promise.resolve();
    expect(pending).toHaveLength(2);

    for (const request of [...pending].reverse()) {
      const suffix = request.command.data.sessionId === "session-a" ? "a" : "b";
      request.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve([{
          kind: "derivativesListed",
          data: {
            requestId: request.command.data.requestId,
            items: [{
              docId: `derivative-${suffix}`,
              dtype: "translate",
              templateId: "template",
              templateName: "模板",
              privatePrompt: "",
              sourceVersion: null,
              currentSourceVersion: 0,
              generatedAt: null,
              stale: false,
            }],
          },
        } satisfies BridgeFrame]),
      } as unknown as Response);
    }

    await expect(listA).resolves.toMatchObject([{ docId: "derivative-a" }]);
    await expect(listB).resolves.toMatchObject([{ docId: "derivative-b" }]);
  });

  it("并发同类请求按各自 HTTP requestId 接收乱序响应，不会串稿或串模板", async () => {
    const pending: Array<{
      command: Extract<Command, { kind: "getDerivativeDoc" | "getStyleTemplate" }>;
      resolve: (response: Response) => void;
    }> = [];
    globalThis.fetch = vi.fn().mockImplementation((_url: string, init?: RequestInit) =>
      new Promise<Response>((resolve) => {
        pending.push({
          command: JSON.parse(String(init?.body)) as Extract<
            Command,
            { kind: "getDerivativeDoc" | "getStyleTemplate" }
          >,
          resolve,
        });
      }),
    );
    const stream = new ServerStream();
    const docA = stream.getDerivativeDoc("s-1", "derivative-a");
    const docB = stream.getDerivativeDoc("s-1", "derivative-b");
    const styleA = stream.getStyleTemplate("s-1", "style-a");
    const styleB = stream.getStyleTemplate("s-1", "style-b");
    await Promise.resolve();
    expect(pending).toHaveLength(4);
    const derivative = (docId: string) => ({
      docId, dtype: "translate", templateId: "template", templateName: "模板", privatePrompt: "",
      sourceVersion: null, currentSourceVersion: 0, generatedAt: null, stale: false,
    });

    for (const request of [...pending].reverse()) {
      const requestId = (request.command.data as { requestId: string }).requestId;
      const frame: BridgeFrame = request.command.kind === "getDerivativeDoc"
        ? {
            kind: "derivativeDocLoaded",
            data: {
              requestId,
              meta: derivative(request.command.data.docId),
              docPm: "{}",
              docVersion: 1,
              title: request.command.data.docId === "derivative-a" ? "A" : "B",
            },
          }
        : {
            kind: "styleTemplateLoaded",
            data: {
              requestId,
              item: {
                id: request.command.data.id,
                dtype: "gzh",
                slot: "writing",
                name: request.command.data.id === "style-a" ? "A" : "B",
                detail: "",
                prompt: "",
                builtin: false,
              },
            },
          };
      request.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve([frame]),
      } as unknown as Response);
    }

    await expect(docA).resolves.toMatchObject({ meta: { docId: "derivative-a" }, title: "A" });
    await expect(docB).resolves.toMatchObject({ meta: { docId: "derivative-b" }, title: "B" });
    await expect(styleA).resolves.toMatchObject({ id: "style-a", name: "A" });
    await expect(styleB).resolves.toMatchObject({ id: "style-b", name: "B" });
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
    expect(source.closed).toBe(true);
    expect(MockEventSource.instances).toHaveLength(2);
    expect(MockEventSource.instances[1]!.url).toContain("after=2");
    expect(MockEventSource.instances[1]!.url).toContain("epoch=2");
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
    const restoredSource = MockEventSource.instances.at(-1)!;
    expect(restoredSource).not.toBe(source);
    expect(restoredSource.url).toContain("epoch=2");
    expect(restoredSource.url).toContain("after=3");

    // 其后的恢复帧(seq 继续从小处递增)也必须送达
    restoredSource.emitFrame(VALID_FRAME, "4");
    expect(frames).toHaveLength(4);
    expect(frames.at(-1)).toEqual(VALID_FRAME);

    // 去重语义仍在:重复 seq 不重复分发
    restoredSource.emitFrame(VALID_FRAME, "4");
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

  it("commands 的删除领域错误直接透传服务端 message", async () => {
    globalThis.fetch = commandResponse({
      error: {
        code: "SESSION_DELETED",
        message: "会话已删除，无法继续操作",
      },
    }, 410);
    const localActions: WorkspaceLocalAction[] = [];
    const stream = new ServerStream((action) => localActions.push(action));

    await expect(
      stream.sendCommand({
        kind: "sendMessage",
        data: {
          sessionId: "s-1",
          text: "继续",
          mentions: [],
          skills: [],
          chips: [],
          fileIds: [],
        },
      }),
    ).rejects.toThrow("会话已删除，无法继续操作");
    expect(localActions).toContainEqual({
      kind: "streamErrorSet",
      error: expect.objectContaining({
        reason: "会话已删除，无法继续操作",
        retriable: false,
        userMessage: "会话已删除，无法继续操作",
      }),
    });
  });

  it("commit 的删除中领域错误直接透传服务端 message", async () => {
    globalThis.fetch = commandResponse({
      error: {
        code: "SESSION_DELETION_IN_PROGRESS",
        message: "会话正在删除，请稍后再试",
      },
    }, 409);
    const stream = new ServerStream();

    await expect(
      stream.commitReviewGroups("s-1", { acceptReviewBatchIds: ["review-1"] }),
    ).rejects.toThrow("会话正在删除，请稍后再试");
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

    const result = await stream.askMore("s-1", "plan-1", [], {}, progress);

    expect(result).toEqual([question]);
    expect(JSON.parse(String(vi.mocked(globalThis.fetch).mock.calls[0]?.[1]?.body))).toMatchObject({
      sessionId: "s-1",
      toolCallId: "plan-1",
    });
    expect(progress).toHaveBeenCalledTimes(1);
    expect(progress).toHaveBeenCalledWith([question]);
  });

  it("askMore treats empty question payloads as a successful empty result", async () => {
    const body = makeReadableStream([ssePayload({ questions: [] })]);
    globalThis.fetch = askMoreFetch(body);

    const stream = new ServerStream();
    const progress = vi.fn();

    const result = await stream.askMore("s-1", "plan-1", [], {}, progress);

    expect(result).toEqual([]);
    expect(progress).not.toHaveBeenCalled();
  });

  it.each(["stop", "dispose"] as const)(
    "%s() 会 abort ask-more fetch 并 cancel 在途 reader",
    async (method) => {
      let requestSignal: AbortSignal | undefined;
      let finishRead: ((result: ReadableStreamReadResult<Uint8Array>) => void) | null = null;
      const reader = {
        read: vi.fn(
          () =>
            new Promise<ReadableStreamReadResult<Uint8Array>>((resolve) => {
              finishRead = resolve;
            }),
        ),
        cancel: vi.fn(async () => {
          finishRead?.({ done: true, value: undefined });
        }),
      };
      globalThis.fetch = vi.fn(async (_url, init) => {
        requestSignal = init?.signal ?? undefined;
        return {
          ok: true,
          status: 200,
          body: { getReader: () => reader },
          json: async () => ({}),
        } as unknown as Response;
      });

      const stream = new ServerStream();
      const pending = stream.askMore("s-1", "plan-cancel", [], {});
      await vi.waitFor(() => expect(reader.read).toHaveBeenCalledOnce());

      stream[method]();

      await expect(pending).rejects.toMatchObject({ name: "AbortError" });
      expect(requestSignal?.aborted).toBe(true);
      expect(reader.cancel).toHaveBeenCalled();
    },
  );

  it("切换会话会取消旧会话 ask-more，不让迟到问题写回新会话", async () => {
    let finishRead: ((result: ReadableStreamReadResult<Uint8Array>) => void) | null = null;
    const reader = {
      read: vi.fn(
        () =>
          new Promise<ReadableStreamReadResult<Uint8Array>>((resolve) => {
            finishRead = resolve;
          }),
      ),
      cancel: vi.fn(async () => {
        finishRead?.({ done: true, value: undefined });
      }),
    };
    globalThis.fetch = vi.fn(async (url) => {
      if (String(url).includes("/ask-more")) {
        return {
          ok: true,
          status: 200,
          body: { getReader: () => reader },
          json: async () => ({}),
        } as unknown as Response;
      }
      return new Response(JSON.stringify({ accepted: true, epoch: 1 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    const stream = new ServerStream();
    await stream.sendCommand({
      kind: "renameSession",
      data: { sessionId: "s-old", title: "旧会话" },
    });
    const pending = stream.askMore("s-old", "plan-switch", [], {});
    await vi.waitFor(() => expect(reader.read).toHaveBeenCalledOnce());

    await stream.sendCommand({
      kind: "renameSession",
      data: { sessionId: "s-new", title: "新会话" },
    });

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(reader.cancel).toHaveBeenCalled();
    stream.dispose();
  });
});
