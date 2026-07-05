import { describe, expect, it } from "vitest";
import {
  buildStateChangeSpanInput,
  buildStateChangeSpanMetadata,
} from "../bridge/agentSpans.js";

// 0603 — 会话状态机转换 span(enter_review 等)的 input 构造纯函数单测。
describe("buildStateChangeSpanInput", () => {
  it("enter_review 字段完整透出", () => {
    expect(
      buildStateChangeSpanInput({ transition: "enter_review", hunkCount: 13, docVersion: 2 }),
    ).toEqual({ transition: "enter_review", hunkCount: 13, docVersion: 2 });
  });

  it("缺省 hunkCount / docVersion → 0(不放文档正文等大字段)", () => {
    expect(buildStateChangeSpanInput({ transition: "enter_review" })).toEqual({
      transition: "enter_review",
      hunkCount: 0,
      docVersion: 0,
    });
  });

  it("metadata 带 streamId / runId / origin", () => {
    expect(
      buildStateChangeSpanMetadata(
        { sessionId: "s1", clientTraceId: "ct1", origin: "agent" },
        { transition: "enter_review" },
        { streamId: "stream-1", runId: "run-1" },
      ),
    ).toEqual({
      eventKind: "state_change",
      transition: "enter_review",
      sessionId: "s1",
      clientTraceId: "ct1",
      streamId: "stream-1",
      runId: "run-1",
      origin: "agent",
    });
  });
});
