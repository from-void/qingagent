import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type { BridgeFrame, Command } from "@qingagent/contract-ts";
import { app } from "../app";
import {
  forgetSession,
  handleCommand,
  getSession,
  sessionManager,
} from "../gateway/bridgeHandler";
import {
  clientMessageIdempotency,
  type ClientMessageIdempotencyStore,
} from "../gateway/clientMessageIdempotency";
import { authenticatedCommandRequest } from "./commandTestRequest";
import type { LoggedFrame } from "../gateway/frameLog";

// 0702 review 回归:startSession 命令的入参校验与覆写防护。
// - 此前 mode.data 缺失 → prepareCommandForActor 抛 TypeError → 500(应 400);
// - mode.kind 任意值(如 "nonsense")被静默当作 new 受理并真的创建会话;
// - startSession(new) 带已存在 sessionId 会用全新空会话顶掉内存态(聊天记录"消失"),
//   后续 persist 还可能把空态写回持久层。

async function collectFrames(gen: AsyncGenerator<BridgeFrame>): Promise<BridgeFrame[]> {
  const frames: BridgeFrame[] = [];
  for await (const frame of gen) frames.push(frame);
  return frames;
}

async function request(body: unknown): Promise<Response> {
  return authenticatedCommandRequest("/api/v1/commands", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/v1/commands startSession 校验", () => {
  it("拒绝不受信 Origin 的命令写入口", async () => {
    const res = await app.request("/api/v1/commands", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "https://evil.test",
      },
      body: JSON.stringify({
        kind: "startSession",
        data: { mode: { kind: "new", data: { template: null } } },
      }),
    });

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "跨站请求被拒绝" });
  });

  it("拒绝不受信 Origin 的 events 订阅入口", async () => {
    const res = await app.request("/api/v1/events?sessionId=csrf-events&after=0", {
      method: "GET",
      headers: { Origin: "https://evil.test" },
    });

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "跨站请求被拒绝" });
  });

  it("mode.data 缺失 → 400(而非 TypeError 500)", async () => {
    const res = await request({
      kind: "startSession",
      data: { mode: { kind: "existing" } },
    });
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string };
    expect(json.error).toContain("startSession.data.mode.data");
  });

  it("existing 缺 id → 400", async () => {
    const res = await request({
      kind: "startSession",
      data: { mode: { kind: "existing", data: {} } },
    });
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string };
    expect(json.error).toContain("mode.data.id");
  });

  it("未知 mode.kind → 400(而非静默按 new 创建会话)", async () => {
    const res = await request({
      kind: "startSession",
      data: { mode: { kind: "nonsense", data: {} } },
    });
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string };
    expect(json.error).toContain("mode.kind");
  });

  it("new 带非法 sessionId(非字符串/空) → 400", async () => {
    for (const sessionId of [42, "", null]) {
      const res = await request({
        kind: "startSession",
        data: { mode: { kind: "new", data: { template: null, sessionId } } },
      });
      expect(res.status).toBe(400);
    }
  });
});

describe("POST /api/v1/commands startSession(new) 覆写防护", () => {
  const sessionIds: string[] = [];

  afterEach(() => {
    for (const sessionId of sessionIds.splice(0)) {
      forgetSession(sessionId);
      sessionManager.frameLog.evict(sessionId);
    }
  });

  it("对已存在(内存)的 sessionId 发 new → 409,原会话不被顶掉", async () => {
    const sessionId = "start-session-clobber-guard";
    sessionIds.push(sessionId);
    await collectFrames(
      handleCommand({
        kind: "startSession",
        data: { mode: { kind: "new", data: { sessionId, template: null } } },
      } as Command),
    );
    const original = getSession(sessionId);
    expect(original).toBeDefined();

    const res = await request({
      kind: "startSession",
      data: { mode: { kind: "new", data: { template: null, sessionId } } },
    });
    expect(res.status).toBe(409);
    // 内存里的仍是原对象,没有被空会话替换。
    expect(getSession(sessionId)).toBe(original);
  });

  it("并发窗口第二道防线:handleCommand 执行期同 id 已在内存 → 抛错不覆写", async () => {
    const sessionId = "start-session-clobber-inner-guard";
    sessionIds.push(sessionId);
    await collectFrames(
      handleCommand({
        kind: "startSession",
        data: { mode: { kind: "new", data: { sessionId, template: null } } },
      } as Command),
    );
    const original = getSession(sessionId);

    await expect(
      collectFrames(
        handleCommand({
          kind: "startSession",
          data: { mode: { kind: "new", data: { sessionId, template: null } } },
        } as Command),
      ),
    ).rejects.toThrow(/already exists/);
    expect(getSession(sessionId)).toBe(original);
  });
});

describe("POST /api/v1/commands sendMessage 幂等", () => {
  let restoreStore: (() => void) | null = null;

  beforeEach(() => {
    const records = new Map<string, {
      id: string;
      sessionId: string;
      messageId: string;
      createdAt: number;
      lastTouched: number;
      completedAt: number | null;
    }>();
    const recordKey = (sessionId: string, id: string): string =>
      JSON.stringify([sessionId, id]);
    const store: ClientMessageIdempotencyStore = {
      async claim(input) {
        const key = recordKey(input.sessionId, input.id);
        const current = records.get(key);
        if (current) return { claimed: false, record: current };
        const record = {
          id: input.id,
          sessionId: input.sessionId,
          messageId: input.messageId,
          createdAt: input.now,
          lastTouched: input.now,
          completedAt: null,
        };
        records.set(key, record);
        return { claimed: true, record };
      },
      async touch(input) {
        const current = records.get(recordKey(input.sessionId, input.id));
        if (
          current?.sessionId !== input.sessionId ||
          current.messageId !== input.messageId ||
          current.createdAt !== input.createdAt ||
          current.completedAt !== null
        ) {
          return false;
        }
        current.lastTouched = Math.max(current.lastTouched, input.now);
        return true;
      },
      async complete(input) {
        const current = records.get(recordKey(input.sessionId, input.id));
        if (
          current?.sessionId !== input.sessionId ||
          current.messageId !== input.messageId ||
          current.createdAt !== input.createdAt ||
          current.completedAt !== null
        ) {
          return false;
        }
        current.lastTouched = Math.max(current.lastTouched, input.now);
        current.completedAt = input.now;
        return true;
      },
      async release(input) {
        const key = recordKey(input.sessionId, input.id);
        const current = records.get(key);
        if (
          current?.sessionId !== input.sessionId ||
          current.messageId !== input.messageId ||
          current.createdAt !== input.createdAt
        ) {
          return false;
        }
        records.delete(key);
        return true;
      },
    };
    restoreStore = clientMessageIdempotency.useStoreForTest(store);
  });

  afterEach(() => {
    restoreStore?.();
    restoreStore = null;
    vi.restoreAllMocks();
  });

  it("两个会话先后提交同一 clientMessageId 时分别入队且互不判 duplicate", async () => {
    let finishCompletion!: () => void;
    const completion = new Promise<never>((_resolve) => {
      finishCompletion = () => {
        // 测试只需终止 maintain 的心跳；后台 completion 的值不会被路由读取。
        (_resolve as (value: never) => void)([] as never);
      };
    });
    const submitQueued = vi
      .spyOn(sessionManager, "submitQueued")
      .mockResolvedValue({ completion });
    const send = (sessionId: string) =>
      request({
        kind: "sendMessage",
        data: {
          sessionId,
          text: "克隆标签的同一首提",
          mentions: [],
          skills: [],
          chips: [],
          fileIds: [],
          clientMessageId: "cloned-first-message",
        },
      });

    const responses = [
      await send("cloned-session-a"),
      await send("cloned-session-b"),
    ];
    const bodies = await Promise.all(
      responses.map((response) => response.json()) as Array<Promise<{
        accepted: boolean;
        duplicate?: boolean;
        sessionId?: string;
        messageId?: string;
      }>>,
    );

    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    expect(submitQueued).toHaveBeenCalledTimes(2);
    expect(submitQueued.mock.calls.map((call) => call[0]).sort()).toEqual([
      "cloned-session-a",
      "cloned-session-b",
    ]);
    expect(bodies).toEqual([
      expect.objectContaining({
        accepted: true,
      }),
      expect.objectContaining({
        accepted: true,
      }),
    ]);
    expect(bodies.every((body) => body.duplicate !== true)).toBe(true);
    finishCompletion();
    await Promise.resolve();
  });

  it("未 release 的 claim 在 HTTP 层短路，失败释放后同一重试才进入编排队列", async () => {
    const sessionId = "retry-claim-boundary-session";
    const clientMessageId = "retry-claim-boundary-message";
    const firstClaim = await clientMessageIdempotency.claim(
      clientMessageId,
      sessionId,
    );
    expect(firstClaim.kind).toBe("claimed");
    if (firstClaim.kind !== "claimed") {
      throw new Error("首轮必须取得 clientMessageId claim");
    }

    let finishFailedTurn!: (frames: LoggedFrame[]) => void;
    const failedTurnCompletion = new Promise<LoggedFrame[]>((resolve) => {
      finishFailedTurn = resolve;
    });
    const maintainedFailedTurn = clientMessageIdempotency.maintain(
      clientMessageId,
      sessionId,
      firstClaim.token,
      failedTurnCompletion,
    );
    const releaseClaim = vi.spyOn(clientMessageIdempotency, "release");
    const submitQueued = vi.spyOn(sessionManager, "submitQueued").mockResolvedValue({
      completion: Promise.resolve([{
        seq: 1,
        epoch: 0,
        generation: 1,
        frame: {
          kind: "stream",
          data: {
            kind: "end",
            data: {
              streamId: "retry-success-stream",
              reason: { kind: "done" },
            },
          },
        },
      }]),
    });
    const send = () => request({
      kind: "sendMessage",
      data: {
        sessionId,
        text: "重新生成这条失败消息",
        mentions: [],
        skills: [],
        chips: [],
        fileIds: [],
        clientMessageId,
      },
    });

    const duplicateResponse = await send();
    expect(duplicateResponse.status).toBe(200);
    expect(await duplicateResponse.json()).toMatchObject({
      accepted: true,
      duplicate: true,
      sessionId,
      messageId: clientMessageId,
    });
    expect(submitQueued).not.toHaveBeenCalled();

    finishFailedTurn([{
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
    }]);
    await maintainedFailedTurn;
    expect(releaseClaim).toHaveBeenCalledOnce();
    expect(releaseClaim).toHaveBeenCalledWith(
      clientMessageId,
      sessionId,
      firstClaim.token,
    );

    const retryResponse = await send();
    expect(retryResponse.status).toBe(200);
    const retryBody = await retryResponse.json() as Record<string, unknown>;
    expect(retryBody).toMatchObject({ accepted: true });
    expect(retryBody).not.toHaveProperty("duplicate");
    expect(submitQueued).toHaveBeenCalledOnce();
    expect(submitQueued).toHaveBeenCalledWith(
      sessionId,
      expect.objectContaining({
        command: expect.objectContaining({
          kind: "sendMessage",
          data: expect.objectContaining({ clientMessageId }),
        }),
      }),
    );
  });
});
