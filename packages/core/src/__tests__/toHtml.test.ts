import { describe, expect, it } from "vitest";
import type { LegacySection } from "@qingagent/contract-ts";
import type { PmDoc } from "@qingagent/pm-schema";
import { toHtml } from "../export/toHtml.js";

function doc(content: PmDoc["content"]): PmDoc {
  return { type: "doc", attrs: { schemaVersion: 1 }, content } as unknown as PmDoc;
}

describe("toHtml 文档骨架", () => {
  it("产出自包含 HTML:doctype + 内联样式 + .wf-doc + 标题", () => {
    const html = toHtml(doc([]), { title: "我的文档" });
    expect(html.startsWith("<!DOCTYPE html>")).toBe(true);
    expect(html).toContain("<style>");
    expect(html).toContain(".wf-doc");
    expect(html).toContain('<article class="wf-doc">');
    expect(html).toContain('<h1 class="doc-title">我的文档</h1>');
  });

  it("内嵌 Google Fonts 链接,HTML 导出在浏览器打开命中真实字体", () => {
    const html = toHtml(doc([]), { title: "T" });
    expect(html).toContain("fonts.googleapis.com/css2");
    expect(html).toContain("Noto+Sans+SC");
    expect(html).toContain("Noto+Serif+SC");
  });

  it("正文首块已是同名标题时,不再重复加文档标题(去重)", () => {
    const d = doc([
      { type: "heading", attrs: { blockId: "h", level: 1 }, content: [{ type: "text", text: "我的报告" }] },
      { type: "paragraph", attrs: { blockId: "p" }, content: [{ type: "text", text: "正文" }] },
    ] as never);
    const html = toHtml(d, { title: "我的报告" });
    // 不应出现 doc-title(标题由正文首个 H1 充当)
    expect(html).not.toContain('class="doc-title"');
    // 正文里只有那一个 H1 标题(<head> 的 <title> 标签另算,不在 <article> 内)
    const body = html.slice(html.indexOf("<article"));
    expect((body.match(/我的报告/g) ?? []).length).toBe(1);
    expect(body).toContain("<h1>我的报告</h1>");
  });

  it("正文首块标题与导出标题不同则照常加文档标题", () => {
    const d = doc([
      { type: "heading", attrs: { blockId: "h", level: 1 }, content: [{ type: "text", text: "章节一" }] },
    ] as never);
    const html = toHtml(d, { title: "整本书" });
    expect(html).toContain('<h1 class="doc-title">整本书</h1>');
  });

  it("标题转义,杜绝 XSS 注入", () => {
    const html = toHtml(doc([]), { title: '<img src=x onerror=alert(1)>' });
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img src=x");
  });
});

describe("toHtml 块级", () => {
  it("标题级别与对齐", () => {
    const html = toHtml(
      doc([
        { type: "heading", attrs: { blockId: "h", level: 3, textAlign: "center" }, content: [{ type: "text", text: "三级居中" }] },
      ] as never),
    );
    expect(html).toContain('<h3 style="text-align:center">三级居中</h3>');
  });

  it("段落正文转义 < > &", () => {
    const html = toHtml(
      doc([{ type: "paragraph", attrs: { blockId: "p" }, content: [{ type: "text", text: "a < b && c > d" }] }] as never),
    );
    expect(html).toContain("a &lt; b &amp;&amp; c &gt; d");
  });

  it("行内 marks 嵌套包裹", () => {
    const html = toHtml(
      doc([
        {
          type: "paragraph",
          attrs: { blockId: "p" },
          content: [
            { type: "text", text: "粗斜", marks: [{ type: "bold" }, { type: "italic" }] },
            { type: "text", text: "码", marks: [{ type: "code" }] },
          ],
        },
      ] as never),
    );
    expect(html).toContain("<em><strong>粗斜</strong></em>");
    expect(html).toContain('<code class="inline-code">码</code>');
  });

  it("代码块:转义且不当 HTML 解释", () => {
    const html = toHtml(
      doc([
        { type: "codeBlock", attrs: { blockId: "c" }, content: [{ type: "text", text: "<div>{a:1}</div>" }] },
      ] as never),
    );
    // 无语言 → 不高亮,纯转义文本;class 带 hljs(有语言时才上色)
    expect(html).toContain('<pre class="code-block hljs"><code>&lt;div&gt;{a:1}&lt;/div&gt;</code></pre>');
  });

  it("代码块带语言 → highlight.js 语法高亮(hljs span)", () => {
    const html = toHtml(
      doc([
        { type: "codeBlock", attrs: { blockId: "c", language: "javascript" }, content: [{ type: "text", text: "const x = 42; // 注释" }] },
      ] as never),
    );
    expect(html).toContain('<pre class="code-block hljs"');
    expect(html).toContain('class="hljs-keyword"'); // const
    expect(html).toContain('class="hljs-comment"'); // // 注释
    expect(html).toContain("42");
    // 语言必须透传到导出 DOM(data-language + code.language-<lang>),
    // 否则导出 HTML 丢失代码块语言信息(e2e R32-R36 反复确认的回归)。
    expect(html).toContain('data-language="javascript"');
    expect(html).toContain('<code class="language-javascript">');
  });

  it("代码块带语言但 highlight.js 不识别时,仍透传 data-language/code class(语言不丢)", () => {
    const html = toHtml(
      doc([
        { type: "codeBlock", attrs: { blockId: "c", language: "foolang" }, content: [{ type: "text", text: "plain body here" }] },
      ] as never),
    );
    expect(html).toContain('data-language="foolang"');
    expect(html).toContain('<code class="language-foolang">');
    expect(html).toContain("plain body here");
  });

  it("代码块无语言:不输出 data-language/language- class", () => {
    const html = toHtml(
      doc([
        { type: "codeBlock", attrs: { blockId: "c" }, content: [{ type: "text", text: "plain text" }] },
      ] as never),
    );
    expect(html).not.toContain("data-language");
    expect(html).toContain("<code>plain text</code>");
  });

  it("有序列表 start 与嵌套子列表", () => {
    const html = toHtml(
      doc([
        {
          type: "orderedList",
          attrs: { blockId: "ol", start: 3 },
          content: [
            {
              type: "listItem",
              attrs: { blockId: "li" },
              content: [
                { type: "paragraph", attrs: { blockId: "lp" }, content: [{ type: "text", text: "外层" }] },
                {
                  type: "bulletList",
                  attrs: { blockId: "ul" },
                  content: [
                    { type: "listItem", attrs: { blockId: "li2" }, content: [{ type: "paragraph", attrs: { blockId: "lp2" }, content: [{ type: "text", text: "内层" }] }] },
                  ],
                },
              ],
            },
          ],
        },
      ] as never),
    );
    expect(html).toContain('<ol start="3">');
    expect(html).toContain("外层");
    expect(html).toContain("<ul><li><p>内层</p></li></ul>");
  });

  it("表格 th/td 与 colspan", () => {
    const html = toHtml(
      doc([
        {
          type: "table",
          attrs: { blockId: "t" },
          content: [
            { type: "tableRow", content: [{ type: "tableHeader", attrs: { colspan: 2 }, content: [{ type: "paragraph", attrs: { blockId: "th" }, content: [{ type: "text", text: "表头" }] }] }] },
            { type: "tableRow", content: [
              { type: "tableCell", content: [{ type: "paragraph", attrs: { blockId: "a" }, content: [{ type: "text", text: "A" }] }] },
              { type: "tableCell", content: [{ type: "paragraph", attrs: { blockId: "b" }, content: [{ type: "text", text: "B" }] }] },
            ] },
          ],
        },
      ] as never),
    );
    expect(html).toContain('<th colspan="2"><p>表头</p></th>');
    expect(html).toContain("<td><p>A</p></td>");
  });

  it("callout 带 tone class + emoji", () => {
    const html = toHtml(
      doc([
        { type: "callout", attrs: { blockId: "co", tone: "warning", emoji: "⚠️" }, content: [{ type: "paragraph", attrs: { blockId: "cp" }, content: [{ type: "text", text: "注意" }] }] },
      ] as never),
    );
    expect(html).toContain('class="pm-callout pm-callout--warning"');
    expect(html).toContain('<span class="pm-callout-emoji">⚠️</span>');
    expect(html).toContain('<div class="pm-callout-body"><p>注意</p></div>');
  });

  it("任务清单勾选态", () => {
    const html = toHtml(
      doc([
        {
          type: "taskList",
          attrs: { blockId: "tl" },
          content: [
            { type: "taskItem", attrs: { blockId: "t1", checked: true }, content: [{ type: "paragraph", attrs: { blockId: "tp1" }, content: [{ type: "text", text: "完成" }] }] },
            { type: "taskItem", attrs: { blockId: "t2", checked: false }, content: [{ type: "paragraph", attrs: { blockId: "tp2" }, content: [{ type: "text", text: "待办" }] }] },
          ],
        },
      ] as never),
    );
    expect(html).toContain('<li class="is-checked"><span class="pm-task-checkbox">');
    expect(html).toContain("完成");
    expect(html).toContain('<li class=""><span class="pm-task-checkbox">');
  });

  it("分栏 widthRatio → flex-grow", () => {
    const html = toHtml(
      doc([
        {
          type: "columnList",
          attrs: { blockId: "cl" },
          content: [
            { type: "column", attrs: { blockId: "c1", widthRatio: 0.4 }, content: [{ type: "paragraph", attrs: { blockId: "cp1" }, content: [{ type: "text", text: "左" }] }] },
            { type: "column", attrs: { blockId: "c2", widthRatio: 0.6 }, content: [{ type: "paragraph", attrs: { blockId: "cp2" }, content: [{ type: "text", text: "右" }] }] },
          ],
        },
      ] as never),
    );
    expect(html).toContain('<div class="pm-column" style="flex-grow:0.4">');
    expect(html).toContain('<div class="pm-column" style="flex-grow:0.6">');
  });

  it("penNote / blockMath / 分隔线 / 附件", () => {
    const html = toHtml(
      doc([
        { type: "penNote", attrs: { blockId: "pn" }, content: [{ type: "text", text: "落款" }] },
        { type: "blockMath", attrs: { blockId: "bm", latex: "x^2" } },
        { type: "horizontalRule", attrs: { blockId: "hr" } },
        { type: "fileAttachment", attrs: { blockId: "fa", fileId: "f", filename: "报告.pdf", mimeType: "application/pdf", size: 1 } },
      ] as never),
    );
    expect(html).toContain('<aside class="pm-pen-note">落款</aside>');
    // 公式经 KaTeX 渲染(不再是 LaTeX 源码),并注入内嵌字体的 KaTeX 样式
    expect(html).toContain('<div class="block-math">');
    expect(html).toContain('class="katex"');
    expect(html).toContain("data:font/woff2;base64,");
    expect(html).toContain("<hr>");
    expect(html).toContain("报告.pdf");
  });

  it("无公式的文档不注入 KaTeX 样式(避免无谓体积)", () => {
    const html = toHtml(doc([{ type: "paragraph", attrs: { blockId: "p" }, content: [{ type: "text", text: "无公式" }] }] as never));
    expect(html).not.toContain("data:font/woff2;base64,");
    expect(html).not.toContain("class=\"katex\"");
  });
});

describe("toHtml 图表与图片", () => {
  const GOOD_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 60" width="120" height="60"><rect width="120" height="60"/></svg>';

  it("合法 SVG 图表内联进 .pm-diagram", () => {
    const html = toHtml(doc([{ type: "diagram", attrs: { blockId: "d", lang: "mermaid", source: "flowchart TD\n A-->B", svg: GOOD_SVG } }] as never));
    expect(html).toContain('<div class="pm-diagram"><svg');
    expect(html).toContain("viewBox");
  });

  it("坏 SVG 图表回退源码代码块", () => {
    const html = toHtml(doc([{ type: "diagram", attrs: { blockId: "d", lang: "mermaid", source: "flowchart TD\n A-->B", svg: "<svg onload=x></svg>" } }] as never));
    expect(html).not.toContain("onload");
    expect(html).toContain('<pre class="code-block">');
    expect(html).toContain("flowchart TD");
  });

  it("带 viewBox 的恶意图表 SVG 不得原样内联(回归 codex 端到端 blocker)", () => {
    const evil = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 40"><script>alert(9)</script><rect width="10" height="10" onload="alert(8)"/></svg>';
    const html = toHtml(doc([{ type: "diagram", attrs: { blockId: "d", lang: "mermaid", source: "flowchart TD\n A-->B", svg: evil } }] as never));
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("onload");
    expect(html).not.toContain("alert(9)");
    // 加固后仍是合法图表(保留 rect),内联进 .pm-diagram
    expect(html).toContain("pm-diagram");
    expect(html).toMatch(/<rect/);
  });

  it("带 viewBox 的恶意 data:image/svg+xml 图片不得原样内联", () => {
    const evil = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 50 50"><script>steal()</script><rect width="5" height="5" onclick="x()"/></svg>';
    const src = `data:image/svg+xml,${encodeURIComponent(evil)}`;
    const html = toHtml(doc([{ type: "image", attrs: { blockId: "i", src, alt: "图" } }] as never));
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("steal()");
    expect(html).not.toContain("onclick");
  });

  it("data URL png 直接内嵌", () => {
    const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";
    const html = toHtml(doc([{ type: "image", attrs: { blockId: "i", src: `data:image/png;base64,${png}`, alt: "猫", caption: "图1" } }] as never));
    expect(html).toContain('<figure class="doc-image">');
    expect(html).toContain(`<img src="data:image/png;base64,${png}" alt="猫">`);
    expect(html).toContain("<figcaption>图1</figcaption>");
  });
});

describe("toHtml legacy 段", () => {
  it("legacy 段映射为对应 HTML", () => {
    const sections: LegacySection[] = [
      { kind: "h1", data: { text: "大标题" } },
      { kind: "p", data: { text: "段落" } },
      { kind: "quote", data: { text: "引用" } },
      { kind: "code", data: { body: "const a=1;", language: "ts" } },
      { kind: "list", data: { ordered: false, items: ["一", "二"] } },
      { kind: "hr", data: {} },
    ];
    const html = toHtml(sections);
    expect(html).toContain("<h1>大标题</h1>");
    expect(html).toContain("<p>段落</p>");
    expect(html).toContain("<blockquote><p>引用</p></blockquote>");
    expect(html).toContain('<pre class="code-block"><code>const a=1;</code></pre>');
    expect(html).toContain("<ul><li>一</li><li>二</li></ul>");
    expect(html).toContain("<hr>");
  });
});
