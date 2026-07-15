import { describe, expect, it } from "vitest";
import type { LexiconEntry } from "@qingagent/db";
import { scanText } from "./sensitiveScan.js";

function entry(word: string, replacement: string | null = null, resourceId = "r", note: string | null = null): LexiconEntry {
  return { id: `${resourceId}-${word}`, resourceId, word, replacement, enabled: true, note };
}

describe("scanText", () => {
  it("长词优先并占用内部短词区间", () => {
    expect(scanText("全网最低价", [entry("最低"), entry("全网最低价", "价格优惠")])).toEqual([
      expect.objectContaining({ word: "全网最低价", count: 1 }),
    ]);
  });

  it("短词仍可命中长词区间之外的位置", () => {
    const hits = scanText("全网最低价，另一个最低", [entry("最低"), entry("全网最低价")]);
    expect(hits.map((hit) => [hit.word, hit.count])).toEqual([["全网最低价", 1], ["最低", 1]]);
  });

  it("同词多处累计", () => expect(scanText("蛮好，真的蛮好", [entry("蛮好")])[0]?.count).toBe(2));

  it("同词多库重复取先到的规则", () => {
    const hit = scanText("搞活动", [entry("搞活动", "开展活动", "a"), entry("搞活动", "举办活动", "b")])[0];
    expect(hit?.replacement).toBe("开展活动");
  });

  it("保留仅标记型 note", () => {
    expect(scanText("老一套", [entry("老一套", null, "r", "口语化")])[0]).toMatchObject({
      replacement: null,
      reviewAction: "annotate",
      note: "口语化",
    });
  });

  it("确定性区分直接替换与必须批注，语境不参与豁免", () => {
    expect(scanText("2020年上线第一版产品，并宣称全网最低价", [
      entry("第一", null, "r", "结合语境人工判断"),
      entry("全网最低价", "价格优惠"),
    ])).toEqual([
      expect.objectContaining({ word: "第一", replacement: null, reviewAction: "annotate" }),
      expect.objectContaining({ word: "全网最低价", replacement: "价格优惠", reviewAction: "replace" }),
    ]);
  });

  it("空文本、空词安全返回", () => {
    expect(scanText("", [entry("词")])).toEqual([]);
    expect(scanText("正文", [entry("")])).toEqual([]);
  });

  it("上下文每侧最多 15 字", () => {
    const hit = scanText(`${"前".repeat(20)}词${"后".repeat(20)}`, [entry("词")])[0]!;
    expect(hit.samples[0]).toBe(`${"前".repeat(15)}【词】${"后".repeat(15)}`);
  });

  it("样例最多三条且用书名括号标注命中词", () => {
    const hit = scanText("词。词。词。词。", [entry("词")])[0]!;
    expect(hit.samples).toHaveLength(3);
    expect(hit.samples.every((sample) => sample.includes("【词】"))).toBe(true);
  });
});
