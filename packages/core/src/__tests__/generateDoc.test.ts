import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { aiIrToPm, type AiDocument } from "@qingagent/pm-schema";
import { extractJson } from "../bridge/docGenerator.js";
import {
  buildAiIrPrompt,
  buildAiIrRetryUserPrompt,
  compileAiDocumentWithBlockRetry,
  materialContextFrom,
  parseAiDocumentFromText,
  parseAiDocumentFromTextDetailed,
} from "../tools/generateDoc.js";
import type { Material } from "../types/material.js";
import { repairModelJson } from "../llm/repairToolCallJson.js";

const validImage = "/api/v1/files/550e8400-e29b-41d4-a716-446655440000/figure.png";
const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../../../..");

type NodeLike = {
  type?: string;
  content?: readonly NodeLike[];
};

function countNestedListItems(node: NodeLike, insideListItem = false): number {
  const self = insideListItem && node.type === "listItem" ? 1 : 0;
  const nextInside = insideListItem || node.type === "listItem";
  return self + (node.content ?? []).reduce((sum, child) => sum + countNestedListItems(child, nextInside), 0);
}

describe("generateDoc PM AI-IR helpers", () => {
  it("retries only invalid AI-IR blocks and compiles to PM canonical", async () => {
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

  it("parseAiDocumentFromText:保守修复字符串值里的裸半角引号", () => {
    const badJson =
      '[{"type":"heading","level":1,"runs":[{"text":"AI落地的"最后一公里"为什么卡在流程上"}]},' +
      '{"type":"paragraph","textAlign":"left","runs":[{"text":"数据像石油,流程就是管道。"}]}]';

    expect(() => JSON.parse(badJson)).toThrow();
    const parsed = parseAiDocumentFromText(badJson, "测试");
    expect(parsed.blocks[0]).toMatchObject({
      type: "heading",
      runs: [{ text: 'AI落地的"最后一公里"为什么卡在流程上' }],
    });
  });

  it("extractJson:真实 flat-04 裸引号失败样本可由真实解析器修复", () => {
    const raw = readFileSync(new URL("./fixtures/flat-04-bare-quote.txt", import.meta.url), "utf8");

    const extracted = extractJson(raw);
    const parsed = JSON.parse(extracted) as { items: Array<{ depth: number; text: string }> };

    expect(parsed.items.length).toBeGreaterThan(40);
    expect(parsed.items.some((item) => item.text.includes('高效输出"'))).toBe(true);
  });

  it("parseAiDocumentFromText: 解析失败时先修复字符串值内裸双引号", () => {
    const dirtyJson =
      '[{"type":"heading","level":1,"runs":[{"text":"AI落地的"最后一公里"为什么卡在流程上"}]},' +
      '{"type":"paragraph","textAlign":"left","runs":[{"text":"数据像石油,流程就是管道。"}]}]';

    expect(() => JSON.parse(dirtyJson)).toThrow();
    const result = parseAiDocumentFromText(dirtyJson, "测试");

    expect(result.blocks).toHaveLength(2);
    expect(JSON.stringify(result.blocks[0])).toContain('\\"最后一公里\\"');
  });

  it("parseAiDocumentFromText: 非 length 的缺右括号可修复；finish_reason=length 仍 fail-closed", () => {
    const truncatedJson = '[{"type":"paragraph","runs":[{"text":"未闭合"}]';
    const syntacticallyValidJson = '[{"type":"paragraph","runs":[{"text":"语法完整但上游截断"}]}]';

    expect(() => JSON.parse(truncatedJson)).toThrow();
    expect(repairModelJson(truncatedJson).ok).toBe(false);
    expect(parseAiDocumentFromText(truncatedJson, "测试").blocks).toHaveLength(1);
    expect(() =>
      parseAiDocumentFromTextDetailed(syntacticallyValidJson, "测试", { finishReason: "length" }),
    ).toThrow(/finish_reason=length/);
    expect(() =>
      parseAiDocumentFromTextDetailed(truncatedJson, "测试", { finishReason: "length" }),
    ).toThrow(/finish_reason=length/);
  });

  // 回归 search-ref-not-citation-block:首稿生成 prompt 必须含『检索来源引用』范本,
  // 把 webSearch 来源 URL 落为 link mark,不能只写纯文本来源名。
  it("buildAiIrPrompt 含检索来源引用范本(link mark,禁纯文本来源)", () => {
    const prompt = buildAiIrPrompt("");
    expect(prompt).toContain("检索来源引用");
    expect(prompt).toContain("可点击");
    expect(prompt).toContain("link mark");
  });

  // 回归 search-ref-not-citation-block(数据链路):抓取类素材的来源 URL 必须进生成 material
  // context,否则模型看不到 url 无法挂 link mark。上传类(sourceUrl=null)不加 URL 标注。
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
    // 上传类无 URL,不应捏造来源标注
    expect(ctx).toContain("素材: 本地上传.md\n正文B");
    expect(ctx).not.toContain("本地上传.md（来源URL");
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

  it("parseAiDocumentFromText: extracts the balanced AI-IR array when prose follows JSON", () => {
    const validJson =
      '[{"type":"heading","level":1,"runs":[{"text":"标题"}]},' +
      '{"type":"paragraph","textAlign":"left","runs":[{"text":"正文"}]}]';
    const raw = `${validJson}\n\n已生成,共 2 段。`;

    const result = parseAiDocumentFromText(raw, "测试");

    expect(result.blocks).toHaveLength(2);
  });

  it.each([
    "V4-800xD1-3-a2.json",
    "V4-800xD1-5-a2.json",
  ])("parseAiDocumentFromText:真实 %s 失败 raw 可由结构修复器挽回并通过 PM 编译", async (filename) => {
    const fixture = JSON.parse(
      readFileSync(join(repoRoot, "packages/core/src/__tests__/fixtures/generateDoc", filename), "utf8"),
    ) as { raw: string; responseJson?: { choices?: Array<{ finish_reason?: string | null }> } };
    const finishReason = fixture.responseJson?.choices?.[0]?.finish_reason ?? null;

    expect(() =>
      parseAiDocumentFromTextDetailed(fixture.raw, "远程办公改变城市空间", {
        finishReason,
        repairSyntax: false,
      }),
    ).toThrow();

    const parsed = parseAiDocumentFromTextDetailed(fixture.raw, "远程办公改变城市空间", { finishReason });
    expect(parsed.diagnostics.repaired).toBe(true);
    expect(parsed.diagnostics.repairKinds.length).toBeGreaterThan(0);
    const compiled = await compileAiDocumentWithBlockRetry(parsed.document, undefined, 0);

    expect(compiled.success).toBe(true);
    if (!compiled.success) throw new Error(compiled.error);
    expect(compiled.doc.content.length).toBeGreaterThan(0);
  });

  it("parseAiDocumentFromText:尾逗号和缺闭合可修复,但 length 截断不伪装成功", () => {
    const trailingComma = '[{"type":"paragraph","runs":[{"text":"尾逗号"}],}]';
    const missingClosers = '[{"type":"paragraph","runs":[{"text":"缺闭合"}]';

    expect(parseAiDocumentFromText(trailingComma, "尾逗号").blocks).toHaveLength(1);
    expect(parseAiDocumentFromText(missingClosers, "缺闭合").blocks).toHaveLength(1);
    expect(() =>
      parseAiDocumentFromTextDetailed(missingClosers, "流断", {
        failOnMissingFinishReasonForCloserRepair: true,
      }),
    ).toThrow(/ended before finish_reason/);
    expect(() =>
      parseAiDocumentFromTextDetailed(missingClosers, "截断", { finishReason: "length" }),
    ).toThrow(/finish_reason=length/);
    expect(() =>
      parseAiDocumentFromTextDetailed(missingClosers, "截断", { finishReason: "max_tokens" }),
    ).toThrow(/finish_reason=max_tokens/);
    expect(() =>
      parseAiDocumentFromTextDetailed('[{"type":"paragraph","runs":[{"text":"完整 JSON"}]}]', "截断", {
        finishReason: "max_tokens",
      }),
    ).toThrow(/finish_reason=max_tokens/);
  });

  it("parseAiDocumentFromText:清理尾逗号时不改写字符串里的逗号和括号", () => {
    const raw = '[{"type":"paragraph","runs":[{"text":"保留 ,] 和 ,} 作为正文"}],}]';

    const parsed = parseAiDocumentFromText(raw, "尾逗号");

    expect(parsed.blocks[0]).toMatchObject({
      type: "paragraph",
      runs: [{ text: "保留 ,] 和 ,} 作为正文" }],
    });
  });

  it("parseAiDocumentFromText:模型风格 JSON 中的 list item children 会保留并编译成真实嵌套列表", () => {
    const raw = `\`\`\`json
[
  {
    "type": "bulletList",
    "items": [
      {
        "runs": [{ "text": "一级事项" }],
        "children": [
          {
            "type": "orderedList",
            "items": [
              {
                "runs": [{ "text": "二级事项" }],
                "children": [
                  {
                    "type": "bulletList",
                    "items": [{ "runs": [{ "text": "三级事项" }] }]
                  }
                ]
              }
            ]
          }
        ]
      }
    ]
  }
]
\`\`\`

已生成。`;

    const parsed = parseAiDocumentFromText(raw, "嵌套列表");
    expect(parsed.blocks).toMatchObject([
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

    const doc = aiIrToPm(parsed as AiDocument);
    expect(countNestedListItems(doc as unknown as NodeLike)).toBeGreaterThan(1);
  });

  it.each([
    "glm-writedraft-20260619164621-1-long-report-r1.txt",
    "glm-writedraft-20260619164621-2-long-report-r2.txt",
    "glm-writedraft-20260619164621-4-quoted-essay-r4.txt",
  ])("GLM writeDraft 真实失败样本可先修复再解析: %s", (filename) => {
    const raw = readFileSync(join(fixturesDir, filename), "utf8");
    const jsonStr = extractJson(raw);

    expect(() => JSON.parse(jsonStr)).toThrow();
    const repaired = repairModelJson(jsonStr);
    expect(repaired.ok).toBe(true);

    const parsed = parseAiDocumentFromText(raw, filename);
    expect(parsed.blocks.length).toBeGreaterThan(0);
  });

  it("GLM writeDraft 缺右括号样本可被结构修复后解析", () => {
    const raw = readFileSync(
      join(fixturesDir, "glm-writedraft-20260619164621-3-quoted-essay-r3.txt"),
      "utf8",
    );
    const jsonStr = extractJson(raw);

    expect(repairModelJson(jsonStr).ok).toBe(false);
    expect(parseAiDocumentFromText(raw, "glm-r3").blocks.length).toBeGreaterThan(0);
  });

  it("prompt 要求保留富文本结构,多级列表/提示框/分栏使用真实 AI-IR 结构", () => {
    const prompt = buildAiIrPrompt("");

    expect(prompt).toContain("必须保留原文中的 table / blockquote / bulletList / orderedList / taskList / callout / columnList");
    expect(prompt).toContain("多级清单必须用 children 递归表达");
    expect(prompt).toContain("必须真的出现 children 子列表");
    expect(prompt).toContain("正文字符串里严禁裸半角双引号");
    expect(prompt).toContain("错误示例");
    expect(prompt).toContain("用户要求\"提示框/注意/风险/结论卡片/高亮框/强调块\"时必须用 callout");
    expect(prompt).toContain("用户要求分栏/双栏/三栏/左右对照时必须用真实 columnList");
    expect(prompt).not.toContain("TODO: 嵌套有序列表支持另行立项");
    expect(prompt).not.toContain("请平铺");
    expect(prompt).not.toContain("不要输出递归嵌套结构");
    expect(prompt).not.toContain("扁平 items + depth");
    expect(prompt).not.toContain("不支持分栏");
    expect(prompt).not.toContain("没有 columnList");
    expect(prompt).not.toContain("无法生成");
  });

  it("坏 JSON/解析失败重试时追加严格自解析修复指令", () => {
    const retryPrompt = buildAiIrRetryUserPrompt("标题: 测试", 1, "Unexpected end of JSON input");

    expect(retryPrompt).toContain("上一轮输出未通过 JSON 解析");
    expect(retryPrompt).toContain("JSON.parse");
    expect(retryPrompt).toContain("不要输出 markdown fence");
  });
});
