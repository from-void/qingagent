import { describe, expect, it } from "vitest";
import { normalizeClientMessageId } from "../clientMessageId.js";

describe("normalizeClientMessageId", () => {
  it("接受客户端 UUID 用户消息 ID", () => {
    const id = "m-user-123e4567-e89b-42d3-a456-426614174000";

    expect(normalizeClientMessageId(id)).toBe(id);
  });

  it.each([
    ["非字符串", null],
    ["空串", ""],
    ["纯空白", "   "],
    ["超过长度上限", `m-user-${"a".repeat(58)}`],
  ])("拒绝%s", (_label, value) => {
    expect(normalizeClientMessageId(value)).toBeNull();
  });

  it("保留既有首尾空白归一化行为", () => {
    expect(normalizeClientMessageId("  m-user-safe  ")).toBe("m-user-safe");
  });
});
