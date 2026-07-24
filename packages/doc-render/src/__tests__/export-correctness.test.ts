import { describe, expect, it } from "vitest";
import type { LegacySection } from "@qingagent/contract-ts";
import type { PmDoc } from "@qingagent/pm-schema";
import { toMarkdown, toTxt } from "../export/index.js";

function doc(content: PmDoc["content"]): PmDoc {
  return { type: "doc", attrs: { schemaVersion: 1 }, content };
}

describe("R20门 Markdown URL 导出正确性", () => {
  it("相对 /api/ 图片与附件按 baseUrl 绝对化，绝对 URL 与 data URI 不二次拼接", () => {
    const source = doc([
      { type: "image", attrs: { blockId: "relative", src: "/api/v1/files/a/image.svg", alt: "相对图", title: null, caption: null } },
      { type: "image", attrs: { blockId: "http", src: "http://cdn.example.com/a.png", alt: "HTTP 图", title: null, caption: null } },
      { type: "image", attrs: { blockId: "https", src: "https://cdn.example.com/b.png", alt: "HTTPS 图", title: null, caption: null } },
      { type: "image", attrs: { blockId: "data", src: "data:image/png;base64,AAAA", alt: "内联图", title: null, caption: null } },
      { type: "fileAttachment", attrs: { blockId: "file", fileId: "file-1", filename: "报告.pdf", mimeType: "application/pdf", size: 1 } },
    ] as PmDoc["content"]);

    const markdown = toMarkdown(source, { baseUrl: "https://qing.example.com:8443/workspace" });
    expect(markdown).toContain("![相对图](https://qing.example.com:8443/api/v1/files/a/image.svg)");
    expect(markdown).toContain("[附件: 报告.pdf](https://qing.example.com:8443/api/v1/files/file-1)");
    expect(markdown).toContain("![HTTP 图](http://cdn.example.com/a.png)");
    expect(markdown).toContain("![HTTPS 图](https://cdn.example.com/b.png)");
    expect(markdown).toContain("![内联图](data:image/png;base64,AAAA)");
    expect(markdown).not.toContain("https://qing.example.com:8443/http");
    expect(markdown).not.toContain("https://qing.example.com:8443/data:");

    expect(toMarkdown(source)).toContain("![相对图](/api/v1/files/a/image.svg)");
  });
});

describe("R20门 TXT 字面尖括号正确性", () => {
  it("PM 结构化纯文本保留用户手打的 <xxx> 占位符", () => {
    const source = doc([
      {
        type: "paragraph",
        attrs: { blockId: "placeholder" },
        content: [{ type: "text", text: "请填写 <name>、<你的名字> 与 <占位符>。" }],
      },
    ]);

    expect(toTxt(source)).toBe("请填写 <name>、<你的名字> 与 <占位符>。");
  });

  it("legacy 富文本剥离已知 HTML 标签但保留字面 <xxx>", () => {
    const sections: LegacySection[] = [
      {
        kind: "p",
        data: { text: '正文 <span data-note="1 > 0"><strong>加粗</strong></span><br>下一行 <name> <你的名字> 1 < 2' },
      },
    ];

    expect(toTxt(sections)).toBe("正文 加粗下一行 <name> <你的名字> 1 < 2");
  });
});
