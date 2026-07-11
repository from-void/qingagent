import { describe, expect, it } from "vitest";
import { aiIrToPm, qingmlParse, type AiDocument } from "@qingagent/pm-schema";
import {
  AiDocumentParseError,
  buildQingmlSteeringTail,
  buildQingmlRetryUserPrompt,
  compileAiDocumentWithBlockRetry,
  materialContextFrom,
  parseAiDocumentFromQingml,
} from "../tools/generateDoc.js";
import { AIIR_SYSTEM_PROMPT } from "../prompts/system.js";
import type { Material } from "../types/material.js";

const validImage = "/api/v1/files/550e8400-e29b-41d4-a716-446655440000/figure.png";

type NodeLike = {
  type?: string;
  content?: readonly NodeLike[];
};

function countNestedListItems(node: NodeLike, insideListItem = false): number {
  const self = insideListItem && node.type === "listItem" ? 1 : 0;
  const nextInside = insideListItem || node.type === "listItem";
  return self + (node.content ?? []).reduce((sum, child) => sum + countNestedListItems(child, nextInside), 0);
}

describe("generateDoc QingML helpers", () => {
  it("retries only invalid blocks and compiles to PM canonical", async () => {
    const retried: number[] = [];
    const result = await compileAiDocumentWithBlockRetry(
      {
        title: "测试",
        blocks: [
          {
            type: "paragraph",
            runs: [{ text: "保留加粗", marks: [{ type: "bold" }] }],
          },
          {
            type: "image",
            src: "https://example.com/not-allowed.png",
            alt: "坏图",
          },
        ],
      },
      async ({ index }) => {
        retried.push(index);
        return {
          type: "image",
          src: validImage,
          alt: "好图",
        };
      },
      1,
    );

    expect(retried).toEqual([1]);
    expect(result.success).toBe(true);
    if (!result.success) throw new Error(result.error);
    expect(result.doc.content[0]?.type).toBe("paragraph");
    const firstInline = result.doc.content[0]?.type === "paragraph" ? result.doc.content[0].content?.[0] : null;
    expect(firstInline?.type === "text" ? firstInline.marks : []).toEqual([
      { type: "bold" },
    ]);
    expect(result.doc.content[1]).toMatchObject({
      type: "image",
      attrs: { src: validImage },
    });
  });

  it("returns blockErrors without producing a doc when retry is unavailable", async () => {
    const result = await compileAiDocumentWithBlockRetry(
      {
        blocks: [
          { type: "paragraph", runs: [{ text: "正文" }] },
          { type: "image", src: "https://example.com/not-allowed.png", alt: "坏图" },
        ],
      },
      undefined,
      0,
    );

    expect(result.success).toBe(false);
    if (result.success) throw new Error("expected failure");
    expect(result.doc).toBeUndefined();
    expect(result.blockErrors).toEqual([expect.objectContaining({ index: 1 })]);
  });

  it("parseAiDocumentFromQingml:正常 QingML 解析为 document.blocks", () => {
    const parsed = parseAiDocumentFromQingml(
      `<title>QingML 标题</title><h2>小节</h2><p>正文 <b>重点</b></p>`,
      "回退标题",
    );

    expect(parsed.document.title).toBe("QingML 标题");
    expect(parsed.document.blocks).toMatchObject([
      { type: "heading", level: 2, runs: [{ text: "小节" }] },
      { type: "paragraph", runs: [{ text: "正文 " }, { text: "重点", marks: [{ type: "bold" }] }] },
    ]);
    expect(parsed.diagnostics).toMatchObject({ extracted: expect.stringContaining("<p>正文"), repaired: false });
  });

  it("parseAiDocumentFromQingml:剥离 fence/前导话,但 bad-block fail-closed", () => {
    const fenced = parseAiDocumentFromQingml("前导\n```qingml\n<p>正文</p>\n```\n收尾", "围栏");
    expect(fenced.document.blocks).toEqual([{ type: "paragraph", runs: [{ text: "正文" }] }]);

    expect(() => parseAiDocumentFromQingml(`<pre>text<p>block</p></pre>`, "坏块")).toThrow(AiDocumentParseError);
    try {
      parseAiDocumentFromQingml(`<pre>text<p>block</p></pre>`, "坏块");
      throw new Error("expected parse failure");
    } catch (error) {
      expect(error).toBeInstanceOf(AiDocumentParseError);
      expect((error as AiDocumentParseError).diagnostics.failureKind).toBe("qingml_bad_block");
      expect((error as Error).message).toContain("raw-text-child-tag");
    }
  });

  it("parseAiDocumentFromQingml:空 blocks 映射为 qingml_empty", () => {
    try {
      parseAiDocumentFromQingml("", "空文档");
      throw new Error("expected parse failure");
    } catch (error) {
      expect(error).toBeInstanceOf(AiDocumentParseError);
      expect((error as AiDocumentParseError).diagnostics.failureKind).toBe("qingml_empty");
    }
  });

  it("普通正文比较符与 & 经实体转义后可逆解析", () => {
    const parsed = parseAiDocumentFromQingml("<p>1 &lt; 2 &amp; 甲乙</p>", "转义");
    expect(parsed.document.blocks[0]).toEqual({
      type: "paragraph",
      runs: [{ text: "1 < 2 & 甲乙" }],
    });
    expect(AIIR_SYSTEM_PROMPT).toContain("普通段落、标题、列表、表格与提示框");
  });

  // 回归 search-ref-not-citation-block:首稿生成 prompt 必须含『检索来源引用』范本,
  // 把 webSearch 来源 URL 落为可点击链接,不能只写纯文本来源名。
  it("主 system 含检索来源引用范本", () => {
    const prompt = AIIR_SYSTEM_PROMPT;
    expect(prompt).toContain("检索来源引用");
    expect(prompt).toContain("可点击 <a href");
    expect(prompt).toContain("真实URL");
  });

  it("主 system 含目录 anchor 与 href 对应的可执行范本", () => {
    const prompt = AIIR_SYSTEM_PROMPT;
    expect(prompt).toContain('<h2 anchor="market">市场分析</h2>');
    expect(prompt).toContain('<a href="#market">市场分析</a>');
    expect(prompt).toContain("禁止只写纯文本目录");
  });

  // 回归 search-ref-not-citation-block(数据链路):抓取类素材的来源 URL 必须进生成 material
  // context,否则模型看不到 url 无法挂链接。上传类(sourceUrl=null)不加 URL 标注。
  it("materialContextFrom 把抓取素材的来源URL喂进生成上下文", () => {
    const baseMeta = { pages: null, wordCount: 10, title: null };
    const materials = new Map<string, Material>([
      ["m1", {
        id: "m1", filename: "中汽协报告", mimeType: "text/html", text: "正文A",
        summary: null, fileId: null,
        metadata: { ...baseMeta, sourceUrl: "https://auto.example.com/report" },
        createdAt: "", updatedAt: "",
      }],
      ["m2", {
        id: "m2", filename: "本地上传.md", mimeType: "text/markdown", text: "正文B",
        summary: null, fileId: null,
        metadata: { ...baseMeta, sourceUrl: null },
        createdAt: "", updatedAt: "",
      }],
    ]);
    const ctx = materialContextFrom(materials);
    expect(ctx).toContain("来源URL: https://auto.example.com/report");
    expect(ctx).toContain("素材: 本地上传.md\n正文B");
    expect(ctx).not.toContain("本地上传.md（来源URL");
  });

  it("materialContextFrom 把图像识别摘要放在素材正文前", () => {
    const materials = new Map<string, Material>([
      ["img-1", {
        id: "img-1",
        filename: "照片.png",
        mimeType: "image/png",
        text: "图片素材正文占位",
        summary: null,
        visionSummary: "图中是一张活动签到表。",
        fileId: "file-img-1",
        metadata: { pages: null, wordCount: 8, title: null },
        createdAt: "",
        updatedAt: "",
      }],
    ]);

    const ctx = materialContextFrom(materials);

    expect(ctx).toBe("素材: 照片.png\n【图像识别摘要】图中是一张活动签到表。\n图片素材正文占位");
  });

  it("writeDraft 尾巴只带素材、任务与输出扭转，不复制 QingML 总规", () => {
    const tail = buildQingmlSteeringTail("素材: 报告\n正文", "标题: 测试");
    expect(tail).toContain("不要调用任何工具");
    expect(tail).toContain("素材: 报告");
    expect(tail).toContain("标题: 测试");
    expect(tail).toContain("主 system 的 QingML 生成总规");
    expect(tail).not.toContain("允许的块级标签与基础形状");
    expect(tail.length).toBeLessThan(500);
  });

  it("含 blockquote/list/hr 的文档:legacySections 通过 output 校验(真 bug 回归)", async () => {
    // 长新闻稿会用引用块/列表/分隔线 → pmToLegacySections 转出 quote/list/hr,
    // 此前 docSectionSchema/LegacySection 漏了这些 kind → output validation 失败、generateDoc 挂。
    const result = await compileAiDocumentWithBlockRetry({
      title: "测试",
      blocks: [
        { type: "heading", level: 1, runs: [{ text: "标题" }] },
        { type: "blockquote", runs: [{ text: "引用素材原话" }] },
        { type: "bulletList", items: [{ runs: [{ text: "要点一" }] }, { runs: [{ text: "要点二" }] }] },
        { type: "horizontalRule" },
        { type: "paragraph", runs: [{ text: "正文" }] },
      ],
    });
    expect(result.success).toBe(true);
    if (!result.success) throw new Error(result.error);
    const kinds = (result.legacySections ?? []).map((s) => s.kind);
    expect(kinds).toContain("quote");
    expect(kinds).toContain("list");
    expect(kinds).toContain("hr");
  });

  it("QingML 嵌套列表会保留并编译成真实嵌套列表", () => {
    const parsed = parseAiDocumentFromQingml(`
      <ul>
        <li>一级事项
          <ol>
            <li>二级事项
              <ul><li>三级事项</li></ul>
            </li>
          </ol>
        </li>
      </ul>
    `, "嵌套列表");

    expect(parsed.document.blocks).toMatchObject([
      {
        type: "bulletList",
        items: [
          {
            runs: [{ text: "一级事项" }],
            children: [
              {
                type: "orderedList",
                items: [
                  {
                    runs: [{ text: "二级事项" }],
                    children: [{ type: "bulletList" }],
                  },
                ],
              },
            ],
          },
        ],
      },
    ]);

    const doc = aiIrToPm(parsed.document as AiDocument);
    expect(countNestedListItems(doc as unknown as NodeLike)).toBeGreaterThan(1);
  });

  it("主 system 富格式提示词契约:高级块说明与示例可解析", () => {
    const prompt = AIIR_SYSTEM_PROMPT;
    const alignMathBlockExample = [
      "<math-block>\\begin{align}",
      "\\nabla \\cdot \\mathbf{E} &amp;= \\frac{\\rho}{\\varepsilon_0} \\\\",
      "\\nabla \\times \\mathbf{B} &amp;= \\mu_0\\mathbf{J}+\\mu_0\\varepsilon_0\\frac{\\partial \\mathbf{E}}{\\partial t}",
      "\\end{align}</math-block>",
    ].join("\n");

    expect(prompt).toContain("<tasks>");
    expect(prompt).toContain("<callout");
    expect(prompt).toContain("<math-block>");
    expect(prompt).toContain("<columns>");
    expect(prompt).toContain("多级列表必须用 <li> 内嵌子 <ul>/<ol>");
    expect(prompt).toContain("提示框 <callout");
    expect(prompt).toContain("tone 只允许 info/success/warning/danger/neutral");
    expect(prompt).toContain("## 展示公式硬规则");
    expect(prompt).toContain("多行公式");
    expect(prompt).toContain("\\begin{align|aligned|equation|gather");
    expect(prompt).toContain("绝不把这类公式写成普通 <p> 段落文本");
    expect(prompt).toContain("分栏必须用 <columns>");
    expect(prompt).not.toContain("items+depth");
    expect(prompt).not.toContain("必须用扁平");

    const examples = [
      "<tasks><task>待办项</task></tasks>",
      "<callout emoji=\"💡\" tone=\"info\">提示内容</callout>",
      "<math-block>E = mc^2</math-block>",
      alignMathBlockExample,
      "<columns><column ratio=\"0.5\"><p>左栏</p></column><column ratio=\"0.5\"><p>右栏</p></column></columns>",
    ];
    for (const example of examples) {
      expect(prompt).toContain(example.split(">")[0]);
      const parsed = qingmlParse(example);
      expect(parsed.warnings.filter((warning) => warning.severity === "bad-block")).toEqual([]);
      expect(parsed.blocks.length).toBeGreaterThan(0);
    }

    const alignExample = qingmlParse(alignMathBlockExample);
    expect(alignExample.blocks[0]).toMatchObject({
      type: "blockMath",
      latex: expect.stringContaining("\\begin{align}"),
    });
  });

  it("QingML 解析失败重试时追加严格自解析修复指令", () => {
    const retryPrompt = buildQingmlRetryUserPrompt("标题: 测试", 1, "raw-text-child-tag");

    expect(retryPrompt).toContain("上一轮输出未通过 QingML 解析或校验");
    expect(retryPrompt).toContain("完整、闭合的 QingML");
    expect(retryPrompt).toContain("&lt; / &amp;");
    expect(retryPrompt).toContain("不要输出 markdown fence");
  });
});
