import { describe, expect, it } from "vitest";
import {
  maskSensitiveAnnotationGroup,
  maskSensitiveValues,
} from "./SensitiveValueMask";
import type { AnnotationGroup } from "./DocSuggestion";

describe("maskSensitiveValues", () => {
  it("打码手机号、身份证、银行卡号和邮箱", () => {
    const input = [
      "手机 13912345678，备用 138-0000-1234。",
      "身份证 11010519491231002X，旧身份证号 130503670401001，身份证编号 11010519491231002X。",
      "银行卡 4222222222222、4532015112830366，会员卡号 6222020200112345678。",
      "邮箱 zhangwei@huasheng.example.com，备用 a@example.com。",
    ].join("\n");

    expect(maskSensitiveValues(input)).toBe([
      "手机 139****5678，备用 138****1234。",
      "身份证 110***********002X，旧身份证号 130********1001，身份证编号 110***********002X。",
      "银行卡 4222*****2222、4532********0366，会员卡号 6222***********5678。",
      "邮箱 zha***@huasheng.example.com，备用 *@example.com。",
    ].join("\n"));
  });

  it("不打码年份、金额、订单号和普通编号", () => {
    const input = [
      "年份 2026，金额 12912345678 元。",
      "订单号 6222020200112345678。",
      "项目编号 11010519491231002X。",
      "普通编号 202608010001234。",
    ].join("\n");

    expect(maskSensitiveValues(input)).toBe(input);
  });

  it("没有校验或类型语境的普通长数字保持原样，已打码文本不会二次处理", () => {
    const input = "统计序列 123456789012345；已处理 139****5678、6222***********5678、zha***@example.com。";
    expect(maskSensitiveValues(input)).toBe(input);
  });

  it("只清洗隐私和敏感审查来源的批注字段", () => {
    const group: AnnotationGroup = {
      id: "g1",
      origin: "sensitive",
      status: "reviewing",
      summary: "手机号 13912345678",
      note: "邮箱 a@example.com",
      suggestion: "银行卡 4532015112830366",
      anchors: [{
        blockId: "b1",
        pmFrom: 1,
        pmTo: 12,
        quote: "13912345678",
        textHash: "hash",
      }],
    };

    expect(maskSensitiveAnnotationGroup(group)).toMatchObject({
      summary: "手机号 139****5678",
      note: "邮箱 *@example.com",
      suggestion: "银行卡 4532********0366",
      anchors: [{ quote: "139****5678", textHash: "span:b1:1:12" }],
    });
    expect(maskSensitiveAnnotationGroup({ ...group, origin: "source-check" })).toEqual({
      ...group,
      origin: "source-check",
    });
  });
});
