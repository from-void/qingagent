import { describe, expect, it, vi } from "vitest";
import type { BridgeFrame } from "@qingagent/contract-ts";
import { InMemoryFrameLog } from "../frameLog";

function frame(title: string): BridgeFrame {
  return { kind: "sessionMeta", data: { sessionId: title, title } };
}

describe("InMemoryFrameLog", () => {
  it("为同一会话分配单调递增 seq", () => {
    const log = new InMemoryFrameLog();

    expect(log.append("s1", frame("one"))).toBe(1);
    expect(log.append("s1", frame("two"))).toBe(2);

    const read = log.readFrom("s1", 0);
    expect(read.frames.map((entry) => entry.seq)).toEqual([1, 2]);
    expect(read.minSeq).toBe(1);
    expect(read.nextSeq).toBe(3);
    expect(read.gap).toBe(false);
  });

  // 回归(0702 桌面验收):chatMessageAdded 携带的是仍在流式增长的同一消息对象(parts 就地 push)。
  // append 若存活引用,重进重放会拿到"已长满 parts 的 added 帧"+ 再重放全部 append 增量 → 内容双份。
  // append 必须深拷贝快照,追加后生产者继续改原对象不得影响已落日志的帧。
  it("append 深拷贝快照:落日志后原对象再变不影响已记录的帧", () => {
    const log = new InMemoryFrameLog();
    const message = {
      id: "m-live",
      role: { kind: "agent" as const },
      ts: "2026-07-02T00:00:00.000Z",
      parts: [] as Array<{ kind: "text"; data: { body: string } }>,
      chips: null,
    };
    const added = {
      kind: "chatMessageAdded",
      data: { message },
    } as unknown as BridgeFrame;

    log.append("s1", added);
    // 模拟生产者继续流式往同一对象里灌 parts(processAgentStream 的真实行为)
    message.parts.push({ kind: "text", data: { body: "后续增量不该出现在快照里" } });

    const replayed = log.readFrom("s1", 0).frames[0]!.frame as unknown as {
      data: { message: { parts: unknown[] } };
    };
    expect(replayed.data.message.parts).toHaveLength(0);
  });

  it("丢弃 generation 不匹配的 late append", () => {
    const log = new InMemoryFrameLog();
    log.setGeneration("s1", 2);

    expect(log.append("s1", frame("old"), { generation: 1 })).toBeNull();
    expect(log.append("s1", frame("current"), { generation: 2 })).toBe(1);

    expect(log.readFrom("s1", 0).frames).toHaveLength(1);
  });

  it("环形缓冲被截断后能检测 gap", () => {
    const log = new InMemoryFrameLog(2);
    log.append("s1", frame("one"));
    log.append("s1", frame("two"));
    log.append("s1", frame("three"));

    const read = log.readFrom("s1", 0);
    expect(read.frames.map((entry) => entry.seq)).toEqual([2, 3]);
    expect(read.minSeq).toBe(2);
    expect(read.gap).toBe(true);
  });

  it("after 超过当前 nextSeq 时检测为 gap", () => {
    const log = new InMemoryFrameLog();
    const read = log.readFrom("s-restarted", 999);

    expect(read.minSeq).toBe(1);
    expect(read.nextSeq).toBe(1);
    expect(read.gap).toBe(true);
  });

  it("subscribe 先补 delta 再推实时帧，且单个监听异常不影响其它监听", () => {
    const log = new InMemoryFrameLog();
    log.append("s1", frame("one"));
    const broken = vi.fn(() => {
      throw new Error("listener failed");
    });
    const received: number[] = [];
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const unsubscribeBroken = log.subscribe("s1", 0, broken);
    const unsubscribe = log.subscribe("s1", 0, (entry) => received.push(entry.seq));
    log.append("s1", frame("two"));

    unsubscribeBroken();
    unsubscribe();
    consoleSpy.mockRestore();

    expect(broken).toHaveBeenCalled();
    expect(received).toEqual([1, 2]);
  });

  it("append 可把主动生成的恢复帧标成 replay 投递", () => {
    const log = new InMemoryFrameLog();
    const deliveries: string[] = [];
    const unsubscribe = log.subscribe(
      "s1",
      0,
      (_entry, delivery) => deliveries.push(delivery),
    );

    log.append("s1", frame("restore"), { delivery: "replay" });
    log.append("s1", frame("live"));
    unsubscribe();

    expect(deliveries).toEqual(["replay", "live"]);
  });

  it("evict 后同一 session 会获得新的 epoch", () => {
    const log = new InMemoryFrameLog();
    const firstEpoch = log.getEpoch("s1");
    log.evict("s1");
    const secondEpoch = log.getEpoch("s1");

    expect(secondEpoch).toBeGreaterThan(firstEpoch);
  });

  // 回归(0702 review):readFrom/getEpoch 等只读路径也会 ensure() 惰性建条目,且不经
  // SessionManager 驱逐——未认证 GET /events 可用任意 sessionId 无限造条目撑爆内存。
  it("会话条目超过 maxSessions 时从最久未访问端驱逐", () => {
    const log = new InMemoryFrameLog(2_000, 3);
    log.readFrom("s1", 0);
    log.readFrom("s2", 0);
    log.readFrom("s3", 0);
    const epochS1 = log.getEpoch("s1"); // LRU touch:s1 变为最新
    log.readFrom("s4", 0); // 超限,应驱逐最久未访问的 s2

    expect(log.getSessionCountForTest()).toBe(3);
    // s1 被 touch 过仍在(epoch 不变);s2 被驱逐(重新 ensure 会拿到新 epoch)。
    expect(log.getEpoch("s1")).toBe(epochS1);
    expect(log.getSessionCountForTest()).toBe(3);
  });

  it("有订阅者或 activeRunner 的会话不被超限驱逐", () => {
    const log = new InMemoryFrameLog(2_000, 2);
    const unsubscribe = log.subscribe("listened", 0, () => {});
    log.setActiveRunner("running", true);
    log.readFrom("s3", 0); // 超限,但 listened/running 受保护,无可驱逐项

    expect(log.getSessionCountForTest()).toBe(3);
    const epochListened = log.getEpoch("listened");
    log.readFrom("s4", 0);
    expect(log.getEpoch("listened")).toBe(epochListened);

    unsubscribe();
    log.setActiveRunner("running", false);
  });
});
