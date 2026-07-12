import { afterEach, describe, expect, it } from "vitest";
import type { BridgeFrame, Command } from "@qingagent/contract-ts";
import { app } from "../app";
import {
  forgetSession,
  handleCommand,
  getSession,
  sessionManager,
} from "../gateway/bridgeHandler";

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
  return app.request("/api/v1/commands", {
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
