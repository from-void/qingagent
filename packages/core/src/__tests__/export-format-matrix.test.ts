// 导出格式覆盖矩阵 —— 单一真源,防止"又漏了某格式/某 target"。
//
// 两条核心保证:
// 1. 【完备性守卫】schema 里每个块类型(PM_SCHEMA_NODE_NAMES)要么被本矩阵覆盖、
//    要么在 EXCLUDED(容器/内联)里显式登记。新增块类型却忘了接导出 → 本测试直接红。
// 2. 【内容不静默丢失】每个可导出块都带唯一 sentinel,断言其内容在 md/html 必现;
//    docx 取代表块抽查;txt 仅报告(本就有意丢弃部分结构)。
//
// 末尾会打印一张 块×target 的人读矩阵表(满足"把所有格式列一遍检查")。
import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import type { PmDoc } from "@qingagent/pm-schema";
import { PM_SCHEMA_NODE_NAMES } from "@qingagent/pm-schema";
import { toDocx, toHtml, toMarkdown, toTxt } from "../export/index.js";

// 唯一可识别 sentinel(纯字母数字,绝大多数序列化器不会转义/拆分)
const S = (name: string) => `zZmx${name}xZz`;

// —— 每个可导出块的最小合法构造,sentinel 埋在其文本承载处 ——
type BlockDef = {
  name: string;
  node: PmDoc["content"][number];
  /** sentinel 文本(无文本承载的块为 null,改用结构探针) */
  sentinel: string | null;
  /** 结构探针:无文本块靠它判定 target 是否产出(md/html) */
  probe?: { md: RegExp; html: RegExp };
};

const para = (id: string, text: string) => ({
  type: "paragraph" as const,
  attrs: { blockId: id },
  content: [{ type: "text" as const, text }],
});

const BLOCKS: BlockDef[] = [
  { name: "heading", sentinel: S("heading"), node: { type: "heading", attrs: { blockId: "h", level: 2 }, content: [{ type: "text", text: S("heading") }] } },
  { name: "paragraph", sentinel: S("paragraph"), node: para("p", S("paragraph")) },
  { name: "blockquote", sentinel: S("blockquote"), node: { type: "blockquote", attrs: { blockId: "bq" }, content: [para("bqp", S("blockquote"))] } },
  { name: "bulletList", sentinel: S("bulletList"), node: { type: "bulletList", attrs: { blockId: "ul" }, content: [{ type: "listItem", attrs: { blockId: "li1" }, content: [para("li1p", S("bulletList"))] }] } },
  { name: "orderedList", sentinel: S("orderedList"), node: { type: "orderedList", attrs: { blockId: "ol", start: 1 }, content: [{ type: "listItem", attrs: { blockId: "li2" }, content: [para("li2p", S("orderedList"))] }] } },
  { name: "horizontalRule", sentinel: null, probe: { md: /^(---|\*\*\*|___)\s*$/m, html: /<hr\b/ }, node: { type: "horizontalRule", attrs: { blockId: "hr" } } },
  { name: "codeBlock", sentinel: S("codeBlock"), node: { type: "codeBlock", attrs: { blockId: "cb", language: "ts" }, content: [{ type: "text", text: S("codeBlock") }] } },
  { name: "table", sentinel: S("table"), node: { type: "table", attrs: { blockId: "tb" }, content: [{ type: "tableRow", content: [{ type: "tableHeader", attrs: {}, content: [para("th", S("table"))] }] }, { type: "tableRow", content: [{ type: "tableCell", attrs: {}, content: [para("td", "cell")] }] }] } },
  { name: "taskList", sentinel: S("taskList"), node: { type: "taskList", attrs: { blockId: "tl" }, content: [{ type: "taskItem", attrs: { blockId: "ti", checked: false }, content: [para("tip", S("taskList"))] }] } },
  { name: "image", sentinel: S("image"), node: { type: "image", attrs: { blockId: "img", src: "data:image/svg+xml;utf8,<svg/>", alt: S("image"), title: null, caption: S("image") } } },
  { name: "diagram", sentinel: S("diagram"), node: { type: "diagram", attrs: { blockId: "dg", lang: "mermaid", source: `flowchart LR\n  ${S("diagram")}-->B`, svg: null } } },
  { name: "fileAttachment", sentinel: S("fileAttachment"), node: { type: "fileAttachment", attrs: { blockId: "fa", fileId: "f1", filename: `${S("fileAttachment")}.pdf`, mimeType: "application/pdf", size: 123 } } },
  { name: "penNote", sentinel: S("penNote"), node: { type: "penNote", attrs: { blockId: "pn" }, content: [{ type: "text", text: S("penNote") }] } },
  { name: "callout", sentinel: S("callout"), node: { type: "callout", attrs: { blockId: "co", tone: "info", emoji: "ℹ️" }, content: [para("cop", S("callout"))] } },
  { name: "columnList", sentinel: S("columnList"), node: { type: "columnList", attrs: { blockId: "cl" }, content: [{ type: "column", attrs: { blockId: "c1" }, content: [para("c1p", S("columnList"))] }, { type: "column", attrs: { blockId: "c2" }, content: [para("c2p", "col2")] }] } },
  { name: "blockMath", sentinel: S("blockMath"), node: { type: "blockMath", attrs: { blockId: "bm", latex: `\\text{${S("blockMath")}}` } } },
  { name: "inlineMath", sentinel: S("inlineMath"), node: { type: "paragraph", attrs: { blockId: "imp" }, content: [{ type: "text", text: "x " }, { type: "inlineMath", attrs: { latex: `\\text{${S("inlineMath")}}` } }] } },
];

// 容器/内联节点:不作为独立块导出,显式登记。新增 schema 节点必须落进 BLOCKS 或这里。
const EXCLUDED = new Set(["doc", "text", "hardBreak", "tableRow", "tableCell", "tableHeader", "listItem", "taskItem", "column"]);

const megaDoc: PmDoc = {
  type: "doc",
  attrs: { schemaVersion: 1 },
  content: BLOCKS.map((b) => b.node),
};

describe("导出格式覆盖矩阵", () => {
  it("schema 每个块类型都被矩阵覆盖或显式排除(防新增格式漏接导出)", () => {
    const covered = new Set(BLOCKS.map((b) => b.name));
    const missing = PM_SCHEMA_NODE_NAMES.filter((n) => !covered.has(n) && !EXCLUDED.has(n));
    expect(missing, `这些块类型未纳入导出矩阵也未排除,新增格式必须接入: ${missing.join(", ")}`).toEqual([]);
  });

  it("每个块的内容在 markdown / html 不静默丢失", () => {
    const md = toMarkdown(megaDoc);
    const html = toHtml(megaDoc);
    for (const b of BLOCKS) {
      if (b.sentinel) {
        expect(md.includes(b.sentinel), `markdown 丢了 ${b.name}`).toBe(true);
        expect(html.includes(b.sentinel), `html 丢了 ${b.name}`).toBe(true);
      } else if (b.probe) {
        expect(b.probe.md.test(md), `markdown 缺 ${b.name} 结构`).toBe(true);
        expect(b.probe.html.test(html), `html 缺 ${b.name} 结构`).toBe(true);
      }
    }
  });

  it("docx 富路径成立:产出非空 + 代表块内容存活", async () => {
    const buf = await toDocx(megaDoc);
    expect(buf.length).toBeGreaterThan(0);
    const xml = await new JSZip().loadAsync(buf).then((z) => z.file("word/document.xml")!.async("string"));
    for (const name of ["heading", "paragraph", "table", "callout", "blockquote", "codeBlock"]) {
      expect(xml.includes(S(name)), `docx 丢了 ${name}`).toBe(true);
    }
  });

  it("打印 块×target 覆盖矩阵(人读)", async () => {
    const md = toMarkdown(megaDoc);
    const html = toHtml(megaDoc);
    const txt = toTxt(megaDoc);
    const xml = await new JSZip().loadAsync(await toDocx(megaDoc)).then((z) => z.file("word/document.xml")!.async("string"));
    const mark = (present: boolean) => (present ? "✓" : "·");
    const rows = BLOCKS.map((b) => {
      const hit = (out: string) => (b.sentinel ? out.includes(b.sentinel) : b.probe ? b.probe.md.test(out) || b.probe.html.test(out) : false);
      return `  ${b.name.padEnd(16)} md:${mark(hit(md))}  html:${mark(hit(html))}  docx:${mark(b.sentinel ? xml.includes(b.sentinel) : false)}  txt:${mark(b.sentinel ? txt.includes(b.sentinel) : false)}`;
    });
    // eslint-disable-next-line no-console
    console.log("\n=== 导出格式覆盖矩阵(块 × target;· = 该 target 无此块内容,可能为有意丢弃)===\n" + rows.join("\n") + "\n");
    expect(rows.length).toBe(BLOCKS.length);
  });
});
