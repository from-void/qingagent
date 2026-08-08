export type MarkdownToPmCorpusCase = {
  name: string;
  markdown: string;
};

/**
 * markdownToPm 的冻结输入语料。Golden 一旦生成即不可重写；新增行为另加命名用例。
 */
export const MARKDOWN_TO_PM_CORPUS: readonly MarkdownToPmCorpusCase[] = [
  {
    name: "empty-input",
    markdown: "",
  },
  {
    name: "restricted-block-set",
    markdown: [
      "# 总标题",
      "",
      "### 小节 **加粗**",
      "",
      "普通段落含 *斜体*、~~删除~~、`code` 与 [链接](https://example.com/a_(b))。",
      "",
      "> 第一行引用",
      "> 第二行引用",
      "",
      "- 条目一",
      "- 条目二",
      "",
      "---",
      "",
      "![图片](/api/v1/files/550e8400-e29b-41d4-a716-446655440000/figure.png)",
    ].join("\n"),
  },
  {
    name: "escaped-block-prefixes",
    markdown: [
      String.raw`\# 字面标题`,
      String.raw`\---`,
      String.raw`\- 字面项目`,
      String.raw`1\. 字面编号`,
      String.raw`\> 字面引用`,
      "\\```ts",
      String.raw`\~~~md`,
    ].join("\n\n"),
  },
  {
    name: "fenced-code-long-delimiter",
    markdown: [
      "`````ts",
      "const sample = `ok`;",
      "```",
      "````",
      "return sample;",
      "`````",
    ].join("\n"),
  },
  {
    name: "fenced-code-unclosed",
    markdown: [
      "```text",
      "未闭合围栏仍保留全部正文",
      "最后一行",
    ].join("\n"),
  },
  {
    name: "pipe-table-ragged-and-breaks",
    markdown: [
      "| **列 A** | 列 B |",
      "| --- | --- |",
      "| 1 |",
      "| x\\|y | 甲<br>乙 | 多余列 |",
      "",
      "A | B 只是普通句子",
    ].join("\n"),
  },
  {
    name: "html-table-rich-safe",
    markdown: [
      '<table><thead><tr><th colspan="2" colwidth="120,180" data-bg-color="rose"><p><b>结论</b></p><ul><li><p>依据</p></li></ul></th></tr></thead>',
      '<tbody><tr><td><p>甲<br>乙</p></td><td><p><a href="https://example.com">链接</a></p></td></tr></tbody></table>',
    ].join("\n"),
  },
  {
    name: "html-table-dangerous-content-sanitized",
    markdown: '<table><tr><td onclick="alert(1)"><script>alert(2)</script><a href="javascript:alert(3)">安全文字</a></td></tr></table>',
  },
  {
    name: "html-table-malformed-fallback",
    markdown: '<table><tr><td colspan="2" colwidth="100"><p>错宽整段按纯文本安全降级</p></td></tr></table>',
  },
  {
    name: "deep-nested-task-and-lists",
    markdown: [
      "- [ ] 父任务",
      "  - [x] 子任务",
      "    - 普通三级项",
      "      7. 七起始四级项",
      "        - [ ] 五级任务",
      "  - 普通补充项",
      "    3. 嵌套编号",
      "- [X] 已完成父任务",
    ].join("\n"),
  },
  {
    name: "ordered-list-starts-and-mixed-children",
    markdown: [
      "0. 零起始",
      "1. 第二项",
      "  9. 九起始子项",
      "    - 子弹项",
      "      - [x] 已完成深层任务",
    ].join("\n"),
  },
  {
    name: "math-block-inline-and-nested-marks",
    markdown: [
      "正文含 $E=mc^2$、*斜体 $y$* 与 **粗体内 `code`**。",
      "",
      "$$",
      String.raw`\frac{1}{2} + \sqrt{x}`,
      "$$",
      "",
      String.raw`$$\int_0^1 x^2\,dx$$`,
    ].join("\n"),
  },
  {
    name: "mermaid-fence-upgrades-to-diagram",
    markdown: [
      "```mermaid",
      "flowchart TD",
      "  A[开始] --> B{判断}",
      "  B -->|是| C[结束]",
      "```",
    ].join("\n"),
  },
  {
    name: "drawio-fence-upgrades-to-diagram",
    markdown: [
      "```drawio",
      '<mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/></root></mxGraphModel>',
      "```",
    ].join("\n"),
  },
  {
    name: "windows-newlines-and-blank-lines",
    markdown: "## Windows 标题\r\n\r\n第一段\r\n\r\n第二段",
  },
];
