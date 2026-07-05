import { describe, expect, it } from "vitest";
import { validateCommandKind } from "../routes/stream";

describe("R0 cancelAskUser stream route red tests", () => {
  it("R4-1 accepts cancelAskUser at the stream route whitelist and validates payload shape", () => {
    // 校验已 zod 化(D6):错误文案不再逐字兼容,断言放宽为"通过=null / 拒绝含字段路径"。
    expect(
      validateCommandKind({
        kind: "cancelAskUser",
        data: { sessionId: "session-1", toolCallId: "ask-1" },
      }),
    ).toBeNull();
    expect(
      validateCommandKind({ kind: "cancelAskUser", data: { toolCallId: "ask-1" } }),
    ).toContain("cancelAskUser.data.sessionId");
    expect(
      validateCommandKind({ kind: "cancelAskUser", data: { sessionId: "session-1" } }),
    ).toContain("cancelAskUser.data.toolCallId");
  });
});
