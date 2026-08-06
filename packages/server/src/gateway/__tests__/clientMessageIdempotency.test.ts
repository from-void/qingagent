import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ClientMessageIdempotencyRegistry,
  CLIENT_MESSAGE_IDEMPOTENCY_TOUCH_INTERVAL_MS,
  type ClientMessageIdempotencyStore,
} from "../clientMessageIdempotency";
import type { LoggedFrame } from "../frameLog";

afterEach(() => {
  vi.useRealTimers();
});

function createSessionScopedStore(): ClientMessageIdempotencyStore {
  const records = new Map<
    string,
    Parameters<ClientMessageIdempotencyStore["claim"]>[0]
  >();
  return {
    async claim(input) {
      const key = JSON.stringify([input.sessionId, input.id]);
      const current = records.get(key);
      if (current) {
        return {
          claimed: false,
          record: {
            id: current.id,
            sessionId: current.sessionId,
            messageId: current.messageId,
            createdAt: current.now,
            lastTouched: current.now,
            completedAt: null,
          },
        };
      }
      records.set(key, input);
      return {
        claimed: true,
        record: {
          id: input.id,
          sessionId: input.sessionId,
          messageId: input.messageId,
          createdAt: input.now,
          lastTouched: input.now,
          completedAt: null,
        },
      };
    },
    touch: async () => true,
    complete: async () => true,
    release: async () => true,
  };
}

describe("clientMessageId 会话作用域", () => {
  it("不同会话的同一 clientMessageId 都返回 claimed 与各自 sessionId", async () => {
    const registry = new ClientMessageIdempotencyRegistry(
      () => 1_000,
      createSessionScopedStore(),
    );

    await expect(registry.claim(
      "shared-client-message",
      "session-a",
      "message-a",
    )).resolves.toMatchObject({
      kind: "claimed",
      sessionId: "session-a",
      messageId: "message-a",
    });
    await expect(registry.claim(
      "shared-client-message",
      "session-b",
      "message-b",
    )).resolves.toMatchObject({
      kind: "claimed",
      sessionId: "session-b",
      messageId: "message-b",
    });
  });

  it("同一会话重复 claim 时返回第一次的 messageId", async () => {
    const registry = new ClientMessageIdempotencyRegistry(
      () => 1_000,
      createSessionScopedStore(),
    );

    await expect(registry.claim(
      "same-client-message",
      "same-session",
      "original-message",
    )).resolves.toMatchObject({
      kind: "claimed",
      sessionId: "same-session",
      messageId: "original-message",
    });
    await expect(registry.claim(
      "same-client-message",
      "same-session",
      "replacement-message",
    )).resolves.toEqual({
      kind: "duplicate",
      sessionId: "same-session",
      messageId: "original-message",
    });
  });
});

describe("clientMessageId 在途心跳", () => {
  it("命令执行期间周期性 touch，完成后停止并标记 completed", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const touch = vi.fn<ClientMessageIdempotencyStore["touch"]>(
      async () => true,
    );
    const complete = vi.fn<ClientMessageIdempotencyStore["complete"]>(
      async () => true,
    );
    const store: ClientMessageIdempotencyStore = {
      async claim(input) {
        return {
          claimed: true,
          record: {
            id: input.id,
            sessionId: input.sessionId,
            messageId: input.messageId,
            createdAt: input.now,
            lastTouched: input.now,
            completedAt: null,
          },
        };
      },
      touch,
      complete,
      release: async () => true,
    };
    const registry = new ClientMessageIdempotencyRegistry(Date.now, store);
    const claim = await registry.claim(
      "client-message-active",
      "session-active",
    );
    expect(claim.kind).toBe("claimed");
    if (claim.kind !== "claimed") return;

    let finish!: (value: LoggedFrame[]) => void;
    const completion = new Promise<LoggedFrame[]>((resolve) => {
      finish = resolve;
    });
    const maintained = registry.maintain(
      "client-message-active",
      "session-active",
      claim.token,
      completion,
    );

    await vi.advanceTimersByTimeAsync(
      CLIENT_MESSAGE_IDEMPOTENCY_TOUCH_INTERVAL_MS,
    );
    expect(touch).toHaveBeenCalledOnce();
    expect(touch).toHaveBeenLastCalledWith(expect.objectContaining({
      id: "client-message-active",
      now: 1_000 + CLIENT_MESSAGE_IDEMPOTENCY_TOUCH_INTERVAL_MS,
    }));

    const successFrames: LoggedFrame[] = [{
      seq: 1,
      epoch: 0,
      generation: 1,
      frame: {
        kind: "stream",
        data: {
          kind: "end",
          data: { streamId: "successful-stream", reason: { kind: "done" } },
        },
      },
    }];
    finish(successFrames);
    await expect(maintained).resolves.toEqual(successFrames);
    expect(complete).toHaveBeenCalledOnce();
    await expect(registry.claim(
      "client-message-active",
      "session-active",
    )).resolves.toMatchObject({
      kind: "duplicate",
      sessionId: "session-active",
    });
    await vi.advanceTimersByTimeAsync(
      CLIENT_MESSAGE_IDEMPOTENCY_TOUCH_INTERVAL_MS * 2,
    );
    expect(touch).toHaveBeenCalledOnce();
  });

  it("持久层 claimer 晚返回时仍由真正取得 claim 的请求执行", async () => {
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let claimCalls = 0;
    const store: ClientMessageIdempotencyStore = {
      async claim(input) {
        claimCalls += 1;
        const claimed = claimCalls === 1;
        if (claimed) await firstGate;
        return {
          claimed,
          record: {
            id: input.id,
            sessionId: "session-owner",
            messageId: input.messageId,
            createdAt: input.now,
            lastTouched: input.now,
            completedAt: null,
          },
        };
      },
      touch: async () => true,
      complete: async () => true,
      release: async () => true,
    };
    const registry = new ClientMessageIdempotencyRegistry(() => 1_000, store);

    const owner = registry.claim("client-message-race", "session-owner");
    const duplicate = registry.claim(
      "client-message-race",
      "session-owner",
    );
    await expect(duplicate).resolves.toMatchObject({ kind: "duplicate" });
    releaseFirst();
    await expect(owner).resolves.toMatchObject({
      kind: "claimed",
      sessionId: "session-owner",
    });
  });

  it("轮次正常返回 draftingFailed 帧时释放 claim，而不是误标 completed", async () => {
    const complete = vi.fn<ClientMessageIdempotencyStore["complete"]>(
      async () => true,
    );
    const release = vi.fn<ClientMessageIdempotencyStore["release"]>(
      async () => true,
    );
    const store: ClientMessageIdempotencyStore = {
      async claim(input) {
        return {
          claimed: true,
          record: {
            id: input.id,
            sessionId: input.sessionId,
            messageId: input.messageId,
            createdAt: input.now,
            lastTouched: input.now,
            completedAt: null,
          },
        };
      },
      touch: async () => true,
      complete,
      release,
    };
    const registry = new ClientMessageIdempotencyRegistry(() => 1_000, store);
    const claim = await registry.claim("retry-after-failure", "session-retry");
    expect(claim.kind).toBe("claimed");
    if (claim.kind !== "claimed") return;
    const failureFrames: LoggedFrame[] = [{
      seq: 1,
      epoch: 0,
      generation: 1,
      frame: {
        kind: "stream",
        data: {
          kind: "draftingFailed",
          data: {
            streamId: "failed-stream",
            reason: "模型服务暂时不可用，请稍后重试",
            retriable: true,
          },
        },
      },
    }];

    await expect(registry.maintain(
      "retry-after-failure",
      "session-retry",
      claim.token,
      Promise.resolve(failureFrames),
    )).resolves.toEqual(failureFrames);

    expect(release).toHaveBeenCalledOnce();
    expect(complete).not.toHaveBeenCalled();
  });

  it("轮次 promise rejected 时同样释放 claim", async () => {
    const complete = vi.fn<ClientMessageIdempotencyStore["complete"]>(
      async () => true,
    );
    const release = vi.fn<ClientMessageIdempotencyStore["release"]>(
      async () => true,
    );
    const store: ClientMessageIdempotencyStore = {
      async claim(input) {
        return {
          claimed: true,
          record: {
            id: input.id,
            sessionId: input.sessionId,
            messageId: input.messageId,
            createdAt: input.now,
            lastTouched: input.now,
            completedAt: null,
          },
        };
      },
      touch: async () => true,
      complete,
      release,
    };
    const registry = new ClientMessageIdempotencyRegistry(() => 1_000, store);
    const claim = await registry.claim("retry-after-rejection", "session-retry");
    expect(claim.kind).toBe("claimed");
    if (claim.kind !== "claimed") return;

    await expect(registry.maintain(
      "retry-after-rejection",
      "session-retry",
      claim.token,
      Promise.reject(new Error("actor failed")),
    )).rejects.toThrow("actor failed");

    expect(release).toHaveBeenCalledOnce();
    expect(complete).not.toHaveBeenCalled();
  });
});
