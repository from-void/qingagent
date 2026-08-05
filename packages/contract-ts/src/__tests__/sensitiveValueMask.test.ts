import { describe, expect, it } from "vitest";
import {
  maskPersistedReviewIgnoreValue,
  maskSensitiveValues,
} from "../SensitiveValueMask";

describe("敏感值脱敏优先级", () => {
  it.each([
    ["订单号", "订单号:13912345678"],
    ["订单编号", "订单编号 13912345678"],
    ["金额", "金额 13912345678 元"],
    ["误填说明", "订单号疑似被误填成了手机号 13912345678"],
  ])("完整手机号形态反压%s标签：%s", (_label, input) => {
    expect(maskSensitiveValues(input)).toBe(input.replace("13912345678", "139****5678"));
    expect(maskPersistedReviewIgnoreValue(input)).toBe(
      input.replace("13912345678", "139****5678"),
    );
  });

  it("完整手机号的保护强度不低于带业务标签的截断片段", () => {
    expect(maskPersistedReviewIgnoreValue("编号 139123456")).toBe("编号 139123456");
    expect(maskPersistedReviewIgnoreValue("编号 13912345678")).toBe("编号 139****5678");
  });

  it.each([
    "订单号:1234567890123",
    "合同编号 HT-20260806-001",
    "金额 1380013800 元",
    "快递单号 SF1234567890",
    "年份 2026",
  ])("正常业务数字继续原样保留：%s", (input) => {
    expect(maskPersistedReviewIgnoreValue(input)).toBe(input);
  });

  it("豁免只认同一行紧邻左侧，不吞掉后续手机号片段", () => {
    expect(maskPersistedReviewIgnoreValue("订单号:1234,联系电话 137654321"))
      .toBe("订单号:1234,联系电话 137******");
    expect(maskPersistedReviewIgnoreValue("(订单号)137654321"))
      .toBe("(订单号)137******");
    expect(maskPersistedReviewIgnoreValue("订单号:\n137654321"))
      .toBe("订单号:\n137******");
  });
});
