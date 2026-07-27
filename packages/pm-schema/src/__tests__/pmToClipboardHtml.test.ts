import { describe, expect, it } from "vitest";
import { pmToClipboardHtml } from "../clipboard/pmToClipboardHtml";
import { pmToPlainText } from "../pmToPlainText";
import type { PmDoc } from "../types";

// F3 剪切板 HTML 序列化:含脏路径(危险 href、HTML 注入文本、未知节点)。
const doc = (content: unknown[]): PmDoc => ({ type: "doc", content }) as unknown as PmDoc;

describe("pmToClipboardHtml", () => {
  it("标题/段落/粗斜体/下划线", () => {
    const html = pmToClipboardHtml(
      doc([
        { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "标题" }] },
        {
          type: "paragraph",
          content: [
            { type: "text", text: "加粗", marks: [{ type: "bold" }] },
            { type: "text", text: "斜体", marks: [{ type: "italic" }] },
            { type: "text", text: "划线", marks: [{ type: "underline" }] },
          ],
        },
      ]),
    );
    expect(html).toBe("<h2>标题</h2><p><strong>加粗</strong><em>斜体</em><u>划线</u></p>");
  });

  it("表格输出语义 table/tr/th/td", () => {
    const tableDoc = doc([
      {
        type: "table",
        content: [
          {
            type: "tableRow",
            content: [
              { type: "tableHeader", attrs: {}, content: [{ type: "paragraph", content: [{ type: "text", text: "列A" }] }] },
              { type: "tableHeader", attrs: {}, content: [{ type: "paragraph", content: [{ type: "text", text: "列B" }] }] },
            ],
          },
          {
            type: "tableRow",
            content: [
              { type: "tableCell", attrs: {}, content: [{ type: "paragraph", content: [{ type: "text", text: "1" }] }] },
              { type: "tableCell", attrs: {}, content: [{ type: "paragraph", content: [{ type: "text", text: "2" }] }] },
            ],
          },
        ],
      },
    ]);
    const html = pmToClipboardHtml(tableDoc);
    expect(html).toBe(
      "<table><tr><th><p>列A</p></th><th><p>列B</p></th></tr><tr><td><p>1</p></td><td><p>2</p></td></tr></table>",
    );
    expect(pmToPlainText(tableDoc)).toBe("列A\t列B\n1\t2");
  });

  it("表格只输出安全白名单属性", () => {
    const html = pmToClipboardHtml(
      doc([
        {
          type: "table",
          content: [
            {
              type: "tableRow",
              content: [
                {
                  type: "tableCell",
                  attrs: { colspan: 2, rowspan: 3, colwidth: [120], "data-x": "x", onclick: "alert(1)" },
                  content: [{ type: "paragraph", content: [{ type: "text", text: "合并" }] }],
                },
              ],
            },
          ],
        },
      ]),
    );
    expect(html).toBe('<table><tr><td colspan="2" rowspan="3"><p>合并</p></td></tr></table>');
    expect(html).not.toContain("data-x");
    expect(html).not.toContain("onclick");
  });

  it("文字色、高亮色和表格单元格底色输出主题色样式", () => {
    const html = pmToClipboardHtml(
      doc([
        {
          type: "paragraph",
          content: [
            { type: "text", text: "红字", marks: [{ type: "textColor", attrs: { color: "red" } }] },
            { type: "text", text: "底色", marks: [{ type: "highlight", attrs: { color: "rose" } }] },
          ],
        },
        {
          type: "table",
          content: [
            {
              type: "tableRow",
              content: [
                {
                  type: "tableCell",
                  attrs: { backgroundColor: "sky" },
                  content: [{ type: "paragraph", content: [{ type: "text", text: "格" }] }],
                },
              ],
            },
          ],
        },
      ]),
    );

    expect(html).toContain('data-text-color="red"');
    expect(html).toContain("color:#a33a2a");
    expect(html).toContain('data-color="rose"');
    expect(html).toContain("background-color:#f3d3d9");
    expect(html).toContain('data-bg-color="sky"');
    expect(html).toContain("background-color:#d7e7f6");
  });

  it("文本中的 HTML 特殊字符被转义(注入防护)", () => {
    const html = pmToClipboardHtml(
      doc([{ type: "paragraph", content: [{ type: "text", text: '<script>alert("x")</script>' }] }]),
    );
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("R2-24 公式复制到 HTML 时保留 latex，并转义属性/兜底文本", () => {
    const html = pmToClipboardHtml(
      doc([
        {
          type: "paragraph",
          content: [
            { type: "text", text: "能量 " },
            { type: "inlineMath", attrs: { latex: 'E=mc^2 & "safe"' } },
          ],
        },
        { type: "blockMath", attrs: { latex: "x < y" } },
      ]),
    );

    expect(html).toContain(
      '<span data-type="inline-math" data-latex="E=mc^2 &amp; &quot;safe&quot;">$E=mc^2 &amp; &quot;safe&quot;$</span>',
    );
    expect(html).toContain('<div data-type="block-math" data-latex="x &lt; y">$$x &lt; y$$</div>');
  });

  it("javascript: 链接只留文字不输出 <a>", () => {
    const html = pmToClipboardHtml(
      doc([
        {
          type: "paragraph",
          content: [
            { type: "text", text: "点我", marks: [{ type: "link", attrs: { href: "javascript:alert(1)" } }] },
          ],
        },
      ]),
    );
    expect(html).toBe("<p>点我</p>");
  });

  it("合法 https 链接输出 <a href>", () => {
    const html = pmToClipboardHtml(
      doc([
        {
          type: "paragraph",
          content: [
            { type: "text", text: "官网", marks: [{ type: "link", attrs: { href: "https://example.com/a?b=1" } }] },
          ],
        },
      ]),
    );
    expect(html).toBe('<p><a href="https://example.com/a?b=1">官网</a></p>');
  });

  it("href 属性会 trim 并转义引号/尖括号/amp/单引号", () => {
    const html = pmToClipboardHtml(
      doc([
        {
          type: "paragraph",
          content: [
            { type: "text", text: "官网", marks: [{ type: "link", attrs: { href: " https://example.com/a?x=\"<>&' " } }] },
          ],
        },
      ]),
    );
    expect(html).toBe('<p><a href="https://example.com/a?x=&quot;&lt;&gt;&amp;&#39;">官网</a></p>');
  });

  it("输出安全的列表样式、文本对齐与链接 title", () => {
    const html = pmToClipboardHtml(
      doc([
        {
          type: "heading",
          attrs: { level: 2, textAlign: "center" },
          content: [{ type: "text", text: "居中标题" }],
        },
        {
          type: "paragraph",
          attrs: { textAlign: "justify" },
          content: [{
            type: "text",
            text: "说明",
            marks: [{ type: "link", attrs: { href: "https://example.com", title: '提示 "<>&\'' } }],
          }],
        },
        {
          type: "orderedList",
          attrs: { start: 3, listStyle: "upper-roman" },
          content: [
            { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "第三项" }] }] },
          ],
        },
      ]),
    );

    expect(html).toContain('<h2 style="text-align:center">居中标题</h2>');
    expect(html).toContain('<p style="text-align:justify"><a href="https://example.com" title="提示 &quot;&lt;&gt;&amp;&#39;">说明</a></p>');
    expect(html).toContain('<ol start="3" data-list-style="upper-roman" style="list-style-type:upper-roman">');
  });

  it("非法列表样式和文本对齐不进入 HTML 属性", () => {
    const html = pmToClipboardHtml(
      doc([
        {
          type: "paragraph",
          attrs: { textAlign: "left;color:red" },
          content: [{ type: "text", text: "正文" }],
        },
        {
          type: "orderedList",
          attrs: { listStyle: "none;color:red" },
          content: [
            { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "条目" }] }] },
          ],
        },
      ]),
    );

    expect(html).toBe("<p>正文</p><ol><li><p>条目</p></li></ol>");
    expect(html).not.toContain("color:red");
  });

  it("penNote 降级为段落;图片降级为说明文字;未知节点输出空", () => {
    const html = pmToClipboardHtml(
      doc([
        { type: "penNote", attrs: {}, content: [{ type: "text", text: "批注" }] },
        { type: "image", attrs: { src: "asset://x", alt: "示意图", caption: null, width: null, height: null } },
        { type: "unknownFancyBlock", content: [] },
      ]),
    );
    expect(html).toBe("<p>批注</p><p>[图: 示意图]</p>");
  });

  it("无说明图片也输出安全占位,避免回退默认 img HTML", () => {
    const html = pmToClipboardHtml(
      doc([{ type: "image", attrs: { src: "asset://x", alt: null, caption: null, width: null, height: null } }]),
    );
    expect(html).toBe("<p>[图]</p>");
  });

  it("合法图片输出 align 与 width,供编辑器内复制粘贴往返", () => {
    const html = pmToClipboardHtml(
      doc([{
        type: "image",
        attrs: {
          src: "/api/v1/files/550e8400-e29b-41d4-a716-446655440000/figure.png",
          alt: "示意图",
          caption: "图 1",
          width: 320,
          height: null,
          align: "right",
        },
      }]),
    );

    expect(html).toContain('data-pm-node="image"');
    expect(html).toContain('data-align="right"');
    expect(html).toContain('width="320"');
    expect(html).toContain("margin-left:auto");
    expect(html).toContain("<figcaption>图 1</figcaption>");
  });

  it("代码块转义并保留换行结构", () => {
    const html = pmToClipboardHtml(
      doc([
        { type: "codeBlock", attrs: { language: "javascript" }, content: [{ type: "text", text: "if (a<b) {\n  run();\n}" }] },
      ]),
    );
    expect(html).toBe('<pre data-language="javascript"><code class="language-javascript">if (a&lt;b) {\n  run();\n}</code></pre>');
  });

  it("嵌套列表", () => {
    const html = pmToClipboardHtml(
      doc([
        {
          type: "bulletList",
          content: [
            {
              type: "listItem",
              content: [
                { type: "paragraph", content: [{ type: "text", text: "一" }] },
                {
                  type: "orderedList",
                  content: [
                    { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "1.1" }] }] },
                  ],
                },
              ],
            },
          ],
        },
      ]),
    );
    expect(html).toBe("<ul><li><p>一</p><ol><li><p>1.1</p></li></ol></li></ul>");
  });

  it("非 1 起始的有序列表输出 start 属性", () => {
    const html = pmToClipboardHtml(
      doc([{
        type: "orderedList",
        attrs: { start: 5 },
        content: [
          { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "第五项" }] }] },
        ],
      }]),
    );

    expect(html).toBe('<ol start="5"><li><p>第五项</p></li></ol>');
  });

  it.each([0, -3])("有序列表 start=%i 原样输出为 HTML 整数属性", (start) => {
    const html = pmToClipboardHtml(
      doc([{
        type: "orderedList",
        attrs: { start },
        content: [
          { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "条目" }] }] },
        ],
      }]),
    );

    expect(html).toBe(`<ol start="${start}"><li><p>条目</p></li></ol>`);
  });

  it("R3-15 taskList/callout 内部复制不吞块", () => {
    const html = pmToClipboardHtml(
      doc([
        {
          type: "taskList",
          attrs: {},
          content: [
            {
              type: "taskItem",
              attrs: { checked: true },
              content: [{ type: "paragraph", content: [{ type: "text", text: "已完成" }] }],
            },
          ],
        },
        {
          type: "callout",
          attrs: { emoji: "!", tone: "warning" },
          content: [{ type: "paragraph", content: [{ type: "text", text: "注意事项" }] }],
        },
      ]),
    );

    expect(html).toContain('<ul data-type="taskList">');
    expect(html).toContain('<li data-type="taskItem" data-checked="true">');
    expect(html).toContain('data-pm-node="callout"');
    expect(html).toContain("注意事项");
  });
});
