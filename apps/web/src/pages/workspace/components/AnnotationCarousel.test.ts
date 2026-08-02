import { describe, expect, it } from "vitest";
import type { AnnotationGroup } from "@qingagent/contract-ts";
import {
  buildAnnotationInstruction,
  reviewOriginLabel,
} from "./AnnotationCarousel";

const groups: AnnotationGroup[] = [
  {
    id: "g1",
    summary: "事实有误",
    note: "时间与资料不一致",
    origin: "source-check",
    suggestion: "改为四月发布",
    status: "reviewing",
    anchors: [{
      blockId: "block-028f9a090d2269fd",
      pmFrom: 449,
      pmTo: 458,
      quote: "甲组原句",
      textHash: "h1",
    }],
  },
  {
    id: "g2",
    summary: "表述重复",
    note: "与上一段语义重复",
    origin: "consistency",
    suggestion: "删去重复句",
    status: "reviewing",
    anchors: [{
      blockId: "block-internal-2",
      pmFrom: 20,
      pmTo: 26,
      quote: "",
      textHash: "h2",
    }],
  },
];

describe("buildAnnotationInstruction", () => {
  it("单条只保留摘要、建议和短原文，不重复原因或泄漏内部定位", () => {
    const instruction = buildAnnotationInstruction(groups[0]!);

    expect(instruction).toBe("按批注修改：事实有误——改为四月发布（原文：『甲组原句』）");
    expect(instruction).not.toContain("时间与资料不一致");
    expect(instruction).not.toContain("block-028f9a090d2269fd");
    expect(instruction).not.toMatch(/\bPM\b/u);
    expect(instruction).not.toContain("449");
    expect(instruction).not.toContain("458");
  });

  it("多条可按统一小块格式用空行分隔，无引文时不输出空括注", () => {
    const instructions = groups
      .map((group) => buildAnnotationInstruction(group))
      .join("\n\n");

    expect(instructions).toBe([
      "按批注修改：事实有误——改为四月发布（原文：『甲组原句』）",
      "按批注修改：表述重复——删去重复句",
    ].join("\n\n"));
    expect(instructions).not.toContain("原文：『』");
    expect(instructions).not.toContain("block-internal-2");
    expect(instructions).not.toMatch(/\bPM\b/u);
  });

  it("原文按 30 个字符截短，文案中的换行压成空格", () => {
    const longQuote = "一二三四五六七八九十一二三四五六七八九十一二三四五六七八九十一";
    const instruction = buildAnnotationInstruction({
      ...groups[0]!,
      summary: "事实\n有误",
      suggestion: "改为\n四月发布",
      anchors: [{ ...groups[0]!.anchors[0]!, quote: longQuote }],
    });

    expect(instruction).toBe(
      "按批注修改：事实 有误——改为 四月发布（原文：『一二三四五六七八九十一二三四五六七八九十一二三四五六七八九十…』）",
    );
  });
});

describe("reviewOriginLabel", () => {
  it("全量固定审查来源与历史兼容值均显示中文", () => {
    expect([
      "sensitive",
      "deai",
      "source",
      "source-check",
      "consistency",
      "privacy",
      "format",
      "role",
      "role-review",
      "custom",
      "custom-review",
      "system-parse-error",
    ].map(reviewOriginLabel)).toEqual([
      "敏感词",
      "去 AI 味",
      "来源核查",
      "来源核查",
      "一致性",
      "隐私",
      "格式",
      "角色审查",
      "角色审查",
      "自定义审查",
      "自定义审查",
      "审查异常",
    ]);
  });

  it("角色与自定义审查名保持原样，未知英文来源不直出", () => {
    expect(reviewOriginLabel("角色审查:法务")).toBe("角色审查:法务");
    expect(reviewOriginLabel("自定义审查:对外发布")).toBe("自定义审查:对外发布");
    expect(reviewOriginLabel("future-review-origin")).toBe("其他审查");
  });
});
