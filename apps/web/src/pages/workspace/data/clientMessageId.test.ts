import { describe, expect, it } from "vitest";
import { newClientMessageId } from "./clientMessageId";

describe("newClientMessageId", () => {
  it("连续生成的用户消息 ID 不重复且保持协议前缀", () => {
    const first = newClientMessageId();
    const second = newClientMessageId();

    expect(first).not.toBe(second);
    expect(first).toMatch(
      /^m-user-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(second).toMatch(
      /^m-user-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  });
});
