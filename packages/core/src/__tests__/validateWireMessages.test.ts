import { describe, expect, it } from "vitest";
import { validateWireMessages } from "../llm/modelConfig.js";

// 跨序列化边界的形态卡:覆盖本次事故形态(arguments 缺失)与近邻畸形。
describe("validateWireMessages", () => {
  const call = (over: Record<string, unknown> = {}) => ({
    id: "call_1",
    type: "function",
    function: { name: "webSearch", arguments: "{\"q\":\"世界杯\"}", ...(over.function as object ?? {}) },
    ...over,
  });

  it("合法序列(含 tool_calls 与配对 tool 结果)返回 null", () => {
    expect(validateWireMessages([
      { role: "system", content: "s" },
      { role: "user", content: "u" },
      { role: "assistant", content: null, tool_calls: [call()] },
      { role: "tool", tool_call_id: "call_1", content: "结果" },
      { role: "assistant", content: "回答" },
    ])).toBeNull();
  });

  it("事故形态:function.arguments 缺失被点名", () => {
    const bad = { id: "call_1", type: "function", function: { name: "webSearch" } };
    expect(validateWireMessages([
      { role: "assistant", tool_calls: [bad] },
    ])).toContain("arguments 缺失");
  });

  it("function.name 缺失被点名", () => {
    const bad = { id: "call_1", type: "function", function: { arguments: "{}" } };
    expect(validateWireMessages([{ role: "assistant", tool_calls: [bad] }])).toContain("name 缺失");
  });

  it("孤儿 tool 结果被点名", () => {
    expect(validateWireMessages([
      { role: "tool", tool_call_id: "call_ghost", content: "x" },
    ])).toContain("孤儿 tool 结果");
  });

  it("非法 role 与非对象消息被点名", () => {
    expect(validateWireMessages([{ role: "robot", content: "x" }])).toContain("role 非法");
    expect(validateWireMessages(["oops"])).toContain("非对象");
  });
});
