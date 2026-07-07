import { describe, expect, it } from "vitest";
import { writeDraftInternals } from "../tools/writeDraft.js";

const { failureKindFromError } = writeDraftInternals;

describe("failureKindFromError:区分超时被掐 vs 真 QingML 结构错", () => {
  it("thinkTimer/hardTimer budget 超时 abort → reason_budget_exceeded(不是 QingML)", () => {
    expect(failureKindFromError(new Error("reason thinking budget exceeded"), "stop")).toBe("reason_budget_exceeded");
    expect(failureKindFromError(new Error("reason hard budget exceeded"), null)).toBe("reason_budget_exceeded");
  });

  it("通用 AbortError → reason_budget_exceeded", () => {
    const err = new Error("aborted");
    err.name = "AbortError";
    expect(failureKindFromError(err, null)).toBe("reason_budget_exceeded");
  });

  it("真 QingML 结构错(diagnostics.failureKind)→ 保留原 kind,不被超时口径覆盖", () => {
    const err = Object.assign(new Error("QingML bad-block"), { diagnostics: { failureKind: "compile_failed" } });
    expect(failureKindFromError(err, null)).toBe("compile_failed");
  });

  it("JSON 括号/引号错仍各自归类;length 截断优先", () => {
    expect(failureKindFromError(new Error("Unexpected end of JSON"), null)).toBe("unclosed_brackets");
    expect(failureKindFromError(new Error("unterminated string"), null)).toBe("unescaped_quote");
    expect(failureKindFromError(new Error("whatever"), "length")).toBe("length_truncated");
  });
});
