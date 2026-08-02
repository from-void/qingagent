import { describe, expect, it } from "vitest";
import { normalizeAnnotationSuggestion } from "./DocSuggestion";

describe("normalizeAnnotationSuggestion", () => {
  const note = "改写会丢失具体违规词、破坏取证原意，故不提供整句替换建议。";

  it.each([undefined, null, "", " \n\t "])("把缺失或空白建议归一为空：%j", (suggestion) => {
    expect(normalizeAnnotationSuggestion(note, suggestion)).toBeUndefined();
  });

  it("把首尾空白不同但正文与原因相同的建议归一为空", () => {
    expect(normalizeAnnotationSuggestion(note, `  ${note}\n`)).toBeUndefined();
  });

  it("保留并裁剪真实改写建议", () => {
    expect(normalizeAnnotationSuggestion(note, "  改为『价格以取证记录为准』。 \n"))
      .toBe("改为『价格以取证记录为准』。");
  });
});
