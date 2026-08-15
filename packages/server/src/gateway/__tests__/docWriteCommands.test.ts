import { describe, expect, it } from "vitest";
import { compileExternalQingmlDraft } from "../docWriteCommands";

describe("compileExternalQingmlDraft", () => {
  it("编译失败使用 compile_failed，且不伪造 QingML warning 与位置", () => {
    const result = compileExternalQingmlDraft("<p>正文</p>", () => ({
      ok: false,
      doc: null,
      blockErrors: [{ index: 0, message: "compile failed" }],
    }));

    expect(result).toEqual({
      ok: false,
      diagnostic: {
        failureKind: "compile_failed",
        warningKinds: [],
        tagSkeleton: "<p></p>",
        errorLocations: [],
      },
    });
  });
});
