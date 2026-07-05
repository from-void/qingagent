import { describe, expect, it } from "vitest";
import type { WriteDraftCardBody } from "@qingagent/contract-ts";
import { lengthStatusLabel, progressLine } from "./DraftMiniCard";

// 写稿小卡片的文案逻辑(渲染走 node 环境纯函数测试)

const body = (over: Partial<WriteDraftCardBody>): WriteDraftCardBody => ({
  title: "t",
  phase: "writing",
  charCount: 320,
  excerpt: "……",
  targetLength: 1500,
  minLength: 1350,
  maxLength: 1650,
  revisionCount: 0,
  lengthStatus: null,
  ...over,
});

describe("lengthStatusLabel", () => {
  it("达标/略偏/未达标分级,not_requested 不显示", () => {
    expect(lengthStatusLabel("accepted_first_pass")?.tone).toBe("ok");
    expect(lengthStatusLabel("accepted_after_revision")?.tone).toBe("ok");
    expect(lengthStatusLabel("near_after_revision")?.tone).toBe("warn");
    expect(lengthStatusLabel("failed_after_revision")?.tone).toBe("bad");
    expect(lengthStatusLabel("not_requested")).toBeNull();
    expect(lengthStatusLabel(null)).toBeNull();
  });
});

describe("progressLine", () => {
  it("writing 带实时字数与目标区间", () => {
    expect(progressLine(body({}))).toBe("正在写作 · 已写 320 字 / 目标 1350–1650 字");
  });
  it("revising 标修订轮次", () => {
    expect(progressLine(body({ phase: "revising", revisionCount: 1, charCount: 80 }))).toBe(
      "字数修订中(第 1 轮) · 已写 80 字 / 目标 1350–1650 字",
    );
  });
  it("finalizing 显示定稿中", () => {
    expect(progressLine(body({ phase: "finalizing", charCount: 100 }))).toBe(
      "定稿中 · 已写 100 字 / 目标 1350–1650 字",
    );
  });
  it("无长度规格时不显示目标区间", () => {
    expect(progressLine(body({ minLength: null, maxLength: null }))).toBe(
      "正在写作 · 已写 320 字",
    );
  });
});
