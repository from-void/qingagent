import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ClientMessageIdempotencyRegistry,
  CLIENT_MESSAGE_IDEMPOTENCY_TOUCH_INTERVAL_MS,
  type ClientMessageIdempotencyStore,
} from "../clientMessageIdempotency";

afterEach(() => {
  vi.useRealTimers();
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

    let finish!: (value: string) => void;
    const completion = new Promise<string>((resolve) => {
      finish = resolve;
    });
    const maintained = registry.maintain(
      "client-message-active",
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

    finish("done");
    await expect(maintained).resolves.toBe("done");
    expect(complete).toHaveBeenCalledOnce();
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
      "session-duplicate",
    );
    await expect(duplicate).resolves.toMatchObject({ kind: "duplicate" });
    releaseFirst();
    await expect(owner).resolves.toMatchObject({
      kind: "claimed",
      sessionId: "session-owner",
    });
  });
});
