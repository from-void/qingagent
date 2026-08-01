import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const baseCssPath = fileURLToPath(
  new URL("../../../../packages/ui-kit/src/base.css", import.meta.url),
);

describe("全局字体继承基线", () => {
  const baseCss = readFileSync(baseCssPath, "utf8");

  it("让 body 以中文衬线字体兜底", () => {
    expect(baseCss).toMatch(
      /body\s*\{[^}]*font-family:\s*var\(--font-zh-serif\)\s*;/s,
    );
  });

  it("让所有原生表单控件继承所在作用域的完整字体", () => {
    expect(baseCss).toMatch(
      /button\s*,\s*input\s*,\s*select\s*,\s*textarea\s*,\s*optgroup\s*\{[^}]*font:\s*inherit\s*;/s,
    );
  });
});
