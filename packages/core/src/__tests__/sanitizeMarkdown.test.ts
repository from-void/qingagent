import { describe, expect, it } from "vitest";
import {
  sanitizeMarkdownInline,
  sanitizeSectionMarkdown,
} from "../utils/sanitizeMarkdown.js";
import type { LegacySection } from "@qingagent/contract-ts";

describe("sanitizeMarkdownInline", () => {
  it("strips conservative Markdown markers from plain prose", () => {
    expect(sanitizeMarkdownInline("## x")).toBe("x");
    expect(sanitizeMarkdownInline("**x**")).toBe("x");
    expect(sanitizeMarkdownInline("__x__")).toBe("x");
    expect(sanitizeMarkdownInline("- x")).toBe("· x");
  });

  it("does not touch single markers or inline code spans", () => {
    const text = "a*b foo_bar *.ts `**x**` `## y`";
    expect(sanitizeMarkdownInline(text)).toBe(text);
  });

  it("does not touch fenced code blocks", () => {
    const text = "前言\n```ts\n## x\nconst value = '**x**';\n```\n- 尾注";
    expect(sanitizeMarkdownInline(text)).toBe(
      "前言\n```ts\n## x\nconst value = '**x**';\n```\n· 尾注",
    );
  });

  it("不同字符的围栏不会关闭当前代码块", () => {
    const text = [
      "~~~md",
      "```ts",
      "## code heading",
      "**code emphasis**",
      "```",
      "~~~",
      "- 尾注",
    ].join("\n");

    expect(sanitizeMarkdownInline(text)).toBe([
      "~~~md",
      "```ts",
      "## code heading",
      "**code emphasis**",
      "```",
      "~~~",
      "· 尾注",
    ].join("\n"));
  });

  it("较短的同字符围栏不会关闭更长 opener", () => {
    const text = [
      "````md",
      "```ts",
      "## code heading",
      "**code emphasis**",
      "```",
      "````",
      "- 尾注",
    ].join("\n");

    expect(sanitizeMarkdownInline(text)).toBe([
      "````md",
      "```ts",
      "## code heading",
      "**code emphasis**",
      "```",
      "````",
      "· 尾注",
    ].join("\n"));
  });

  it("同字符且不短于 opener 的围栏可以关闭代码块", () => {
    const text = "```md\n## code heading\n````\n- 尾注";
    expect(sanitizeMarkdownInline(text)).toBe(
      "```md\n## code heading\n````\n· 尾注",
    );
  });
});

describe("sanitizeSectionMarkdown", () => {
  it("sanitizes table head and cells", () => {
    const section: LegacySection = {
      kind: "table",
      data: {
        head: ["**列**"],
        rows: [["## 单元格", "- 条目"]],
      },
    };

    expect(sanitizeSectionMarkdown(section)).toEqual({
      kind: "table",
      data: {
        head: ["列"],
        rows: [["单元格", "· 条目"]],
      },
    });
  });

  it("leaves code sections unchanged", () => {
    const section: LegacySection = {
      kind: "code",
      data: { body: "## x\nconst value = '**x**';\n- item" },
    };

    expect(sanitizeSectionMarkdown(section)).toEqual(section);
  });
});
