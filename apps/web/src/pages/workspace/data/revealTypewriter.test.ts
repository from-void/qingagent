import { describe, expect, it } from "vitest";
import {
  planRevealTypewriter,
  revealNewPartLen,
  type RevealFrame,
} from "./revealTypewriter";

function lastFrame(frames: RevealFrame[]): RevealFrame {
  return frames[frames.length - 1]!;
}

function typedMap(frame: RevealFrame): Map<string, number> {
  return new Map(frame.typed);
}

describe("revealNewPartLen", () => {
  it("counts only the appended tail for pure additions", () => {
    // after = before + "新增" → 只数追加的 2 字
    expect(revealNewPartLen("原文", "原文新增内容")).toBe(4);
  });

  it("counts the whole replacement text otherwise", () => {
    expect(revealNewPartLen("旧", "全新文案")).toBe(4);
  });

  it("returns 0 for pure deletion (empty after)", () => {
    expect(revealNewPartLen("要删的", "")).toBe(0);
  });

  it("counts by code point so emoji are not split", () => {
    // "👍🏽" 是 2 个 code point;此处只验证不按 UTF-16 code unit 多算
    expect(revealNewPartLen("", "👍")).toBe(1);
  });
});

describe("planRevealTypewriter", () => {
  const targets = (m: Record<string, number>) => (id: string) => m[id] ?? 0;

  it("types a single patch one char per tick, cursor present until done", () => {
    const frames = planRevealTypewriter(["a"], targets({ a: 3 }), 1, 1);
    // 首帧 typed=0 + 之后 3 拍打 3 字;光标带通道号(lane=1)
    expect(frames[0]).toEqual({
      revealed: ["a"],
      typed: [["a", 0]],
      cursors: [{ id: "a", lane: 1 }],
    });
    expect(frames.map((f) => typedMap(f).get("a"))).toEqual([0, 1, 2, 3]);
    // 打字过程中有光标,末帧无光标
    expect(frames[1]!.cursors).toEqual([{ id: "a", lane: 1 }]);
    expect(lastFrame(frames).cursors).toEqual([]);
  });

  it("assigns stable Agent lanes and reuses them as heads free up", () => {
    // 并发=2,三处各 2 字。a/b 占 lane 1/2;a 打完释放 lane 1,c 复用 lane 1。
    const frames = planRevealTypewriter(
      ["a", "b", "c"],
      targets({ a: 2, b: 2, c: 2 }),
      2,
      1,
    );
    expect(frames[0]!.cursors).toEqual([
      { id: "a", lane: 1 },
      { id: "b", lane: 2 },
    ]);
    // 找到 c 开始打字的那一帧,断言它复用了被释放的 lane 1
    const cFrame = frames.find((f) => f.cursors.some((c) => c.id === "c"));
    expect(cFrame).toBeTruthy();
    const cCursor = cFrame!.cursors.find((c) => c.id === "c")!;
    expect(cCursor.lane).toBe(1);
    // 任一帧 lane 不重复
    for (const f of frames) {
      const lanes = f.cursors.map((c) => c.lane);
      expect(new Set(lanes).size).toBe(lanes.length);
      for (const l of lanes) expect(l).toBeLessThanOrEqual(2);
    }
  });

  it("respects charsPerTick", () => {
    const frames = planRevealTypewriter(["a"], targets({ a: 5 }), 1, 2);
    expect(frames.map((f) => typedMap(f).get("a"))).toEqual([0, 2, 4, 5]);
  });

  it("never exceeds the concurrency cap of simultaneous cursors", () => {
    const frames = planRevealTypewriter(
      ["a", "b", "c", "d"],
      targets({ a: 4, b: 4, c: 4, d: 4 }),
      2,
      1,
    );
    for (const f of frames) {
      expect(f.cursors.length).toBeLessThanOrEqual(2);
    }
    // 最终每处都打满
    const last = typedMap(lastFrame(frames));
    expect([last.get("a"), last.get("b"), last.get("c"), last.get("d")]).toEqual([
      4, 4, 4, 4,
    ]);
    expect(lastFrame(frames).revealed.sort()).toEqual(["a", "b", "c", "d"]);
  });

  it("processes patches in FIFO order (later patch starts only after a head frees up)", () => {
    const frames = planRevealTypewriter(["a", "b"], targets({ a: 2, b: 2 }), 1, 1);
    // 并发=1:a 打完(2拍)后 b 才开始
    const aDoneIdx = frames.findIndex((f) => typedMap(f).get("a") === 2);
    const bStartIdx = frames.findIndex((f) => (typedMap(f).get("b") ?? 0) > 0);
    expect(bStartIdx).toBeGreaterThan(aDoneIdx - 1);
    // b 在 a 完成前不应有进度
    expect(typedMap(frames[1]!).get("b") ?? 0).toBe(0);
  });

  it("reveals zero-target patches instantly without consuming a typing head", () => {
    // a 纯删除(0),b 有 2 字。并发=1:a 应立即入场且不挡住 b 的打字
    const frames = planRevealTypewriter(["a", "b"], targets({ a: 0, b: 2 }), 1, 1);
    // 首帧:a 已入场(revealed),光标在 b(因为 a 不占头)
    expect(frames[0]!.revealed).toContain("a");
    expect(frames[0]!.cursors).toEqual([{ id: "b", lane: 1 }]);
    expect(lastFrame(frames).revealed.sort()).toEqual(["a", "b"]);
  });

  it("returns a single frame when there is nothing to type", () => {
    const frames = planRevealTypewriter(["a", "b"], targets({ a: 0, b: 0 }), 1, 1);
    expect(frames).toHaveLength(1);
    expect(frames[0]!.cursors).toEqual([]);
    expect(frames[0]!.revealed.sort()).toEqual(["a", "b"]);
  });

  it("clamps degenerate concurrency/charsPerTick to at least 1", () => {
    const frames = planRevealTypewriter(["a"], targets({ a: 2 }), 0, 0);
    expect(frames.map((f) => typedMap(f).get("a"))).toEqual([0, 1, 2]);
  });
});
