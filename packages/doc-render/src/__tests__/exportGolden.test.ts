import { DOMParser, XMLSerializer, type Element as XmlElement } from "@xmldom/xmldom";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import JSZip from "jszip";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PmDoc } from "@qingagent/pm-schema";
import { toDocx, toHtml, toMarkdown, toTxt, type ExportDegradation } from "../export/index.js";

const FIXTURE_ROOT = fileURLToPath(new URL("./__fixtures__/export-golden/", import.meta.url));
const UPDATE_GOLDEN = process.env.UPDATE_EXPORT_GOLDEN === "1";
const LOCAL_MEDIA_ID = "550e8400-e29b-41d4-a716-446655440000";
const LOCAL_MEDIA_FILENAME = "golden-pixel.gif";
const LOCAL_MEDIA_SRC = `/api/v1/files/${LOCAL_MEDIA_ID}/${LOCAL_MEDIA_FILENAME}`;
const LOCAL_GIF_BASE64 = "R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==";

type GoldenCaseName = "title-rich-local-media" | "cached-diagram";
type TextFormat = "html" | "md" | "txt";

const paragraph = (blockId: string, text: string) => ({
  type: "paragraph" as const,
  attrs: { blockId },
  content: [{ type: "text" as const, text }],
});

const GOLDEN_DOCUMENTS: Record<GoldenCaseName, PmDoc> = {
  "title-rich-local-media": {
    type: "doc",
    attrs: { schemaVersion: 1 },
    content: [
      {
        type: "heading",
        attrs: { blockId: "golden-title", level: 1 },
        content: [{ type: "text", text: "Golden Export", marks: [{ type: "bold" }] }],
      },
      {
        type: "paragraph",
        attrs: { blockId: "golden-intro" },
        content: [
          { type: "text", text: "Alpha " },
          { type: "text", text: "link", marks: [{ type: "link", attrs: { href: "#golden-title" } }] },
          { type: "hardBreak" },
          { type: "text", text: "Beta", marks: [{ type: "code" }] },
        ],
      },
      {
        type: "blockquote",
        attrs: { blockId: "golden-quote" },
        content: [
          paragraph("golden-quote-p", "Quoted evidence"),
          {
            type: "columnList",
            attrs: { blockId: "golden-nested-columns" },
            content: [{
              type: "column",
              attrs: { blockId: "golden-nested-column-a", widthRatio: 1 },
              content: [paragraph("golden-nested-column-a-p", "Nested left")],
            }, {
              type: "column",
              attrs: { blockId: "golden-nested-column-b", widthRatio: 1 },
              content: [paragraph("golden-nested-column-b-p", "Nested right")],
            }],
          },
        ],
      },
      {
        type: "orderedList",
        attrs: { blockId: "golden-list", start: 3, listStyle: "lower-alpha" },
        content: [{
          type: "listItem",
          attrs: { blockId: "golden-list-item" },
          content: [
            paragraph("golden-list-p", "First item"),
            {
              type: "bulletList",
              attrs: { blockId: "golden-nested-list" },
              content: [{
                type: "listItem",
                attrs: { blockId: "golden-nested-item" },
                content: [paragraph("golden-nested-p", "Nested item")],
              }],
            },
          ],
        }],
      },
      {
        type: "table",
        attrs: { blockId: "golden-table" },
        content: [
          {
            type: "tableRow",
            content: [{
              type: "tableHeader",
              attrs: { colspan: 1, rowspan: 1, colwidth: [180] },
              content: [paragraph("golden-table-head", "Metric")],
            }, {
              type: "tableHeader",
              attrs: { colspan: 1, rowspan: 1, colwidth: [120] },
              content: [paragraph("golden-table-value-head", "Value")],
            }],
          },
          {
            type: "tableRow",
            content: [{
              type: "tableCell",
              attrs: { colspan: 1, rowspan: 1, colwidth: [180] },
              content: [paragraph("golden-table-cell", "Coverage")],
            }, {
              type: "tableCell",
              attrs: { colspan: 1, rowspan: 1, colwidth: [120], backgroundColor: "yellow" },
              content: [paragraph("golden-table-value", "100%")],
            }],
          },
        ],
      },
      { type: "horizontalRule", attrs: { blockId: "golden-rule" } },
      {
        type: "codeBlock",
        attrs: { blockId: "golden-code", language: "ts" },
        content: [{ type: "text", text: "const stable = true;" }],
      },
      {
        type: "columnList",
        attrs: { blockId: "golden-columns" },
        content: [{
          type: "column",
          attrs: { blockId: "golden-column-a", widthRatio: 2 },
          content: [paragraph("golden-column-a-p", "Left column")],
        }, {
          type: "column",
          attrs: { blockId: "golden-column-b", widthRatio: 1 },
          content: [paragraph("golden-column-b-p", "Right column")],
        }],
      },
      {
        type: "image",
        attrs: {
          blockId: "golden-local-image",
          src: LOCAL_MEDIA_SRC,
          alt: "Local pixel",
          title: null,
          caption: "Local media caption",
          width: 32,
          height: 24,
          align: "right",
        },
      },
    ],
  } as PmDoc,
  "cached-diagram": {
    type: "doc",
    attrs: { schemaVersion: 1 },
    content: [
      paragraph("diagram-intro", "Cached diagram follows"),
      {
        type: "diagram",
        attrs: {
          blockId: "cached-diagram",
          lang: "mermaid",
          source: "flowchart LR\n  Start --> Finish",
          svg: [
            '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="120" viewBox="0 0 320 120">',
            '<rect x="1" y="1" width="318" height="118" fill="#fff" stroke="#222"/>',
            '<text x="24" y="68" font-family="sans-serif" font-size="18">Cached diagram</text>',
            "</svg>",
          ].join(""),
          width: 320,
          height: 120,
          align: "center",
        },
      },
    ],
  } as PmDoc,
};

const TEXT_TARGETS: ReadonlyArray<{
  name: GoldenCaseName;
  format: TextFormat;
}> = [
  { name: "title-rich-local-media", format: "html" },
  { name: "title-rich-local-media", format: "md" },
  { name: "title-rich-local-media", format: "txt" },
  { name: "cached-diagram", format: "html" },
  { name: "cached-diagram", format: "md" },
  { name: "cached-diagram", format: "txt" },
];

const DOCX_TARGETS: readonly GoldenCaseName[] = ["title-rich-local-media"];
const REQUIRED_DOCX_XML_PARTS = [
  "word/document.xml",
  "word/styles.xml",
  "word/numbering.xml",
] as const;

let uploadsDir = "";
const previousUploadsDir = process.env.QINGAGENT_UPLOADS_DIR;

beforeAll(() => {
  uploadsDir = mkdtempSync(join(tmpdir(), "qingagent-export-golden-"));
  const localMediaDir = join(uploadsDir, LOCAL_MEDIA_ID);
  mkdirSync(localMediaDir, { recursive: true });
  writeFileSync(join(localMediaDir, LOCAL_MEDIA_FILENAME), Buffer.from(LOCAL_GIF_BASE64, "base64"));
  process.env.QINGAGENT_UPLOADS_DIR = uploadsDir;
});

afterAll(() => {
  if (previousUploadsDir === undefined) delete process.env.QINGAGENT_UPLOADS_DIR;
  else process.env.QINGAGENT_UPLOADS_DIR = previousUploadsDir;
  if (uploadsDir) rmSync(uploadsDir, { recursive: true, force: true });
});

describe("导出 golden（PM 单轨收窄前后逐字节不变）", () => {
  it.each(TEXT_TARGETS)("$name.$format 与旧实现 golden 逐字节一致", ({ name, format }) => {
    const actual = renderText(format, GOLDEN_DOCUMENTS[name]);
    const expectedPath = join(FIXTURE_ROOT, `${name}.${format}`);
    updateTextGolden(expectedPath, actual);
    expect(Buffer.from(actual, "utf8")).toEqual(readFileSync(expectedPath));
  });

  it.each(DOCX_TARGETS)("$name.docx 指定 XML/rels/media canonical golden 逐字节一致", async (name) => {
    const degradations: ExportDegradation[] = [];
    const parts = await canonicalizeDocx(await toDocx(GOLDEN_DOCUMENTS[name], {
      title: "Golden Export",
      onDegradation: (item) => degradations.push(item),
    }));
    expect(degradations).toEqual([{
      kind: "docx-columns-flattened",
      description: "分栏已拍平为纵向，原并排版式无法保留",
    }]);
    const expectedDir = join(FIXTURE_ROOT, `${name}.docx`);
    updateDocxGolden(expectedDir, parts);
    expect([...parts.keys()]).toEqual(listFiles(expectedDir));
    for (const [partName, actual] of parts) {
      expect(actual, partName).toEqual(readFileSync(join(expectedDir, partName)));
    }
  });

  it("Markdown 分栏降级预期固定", () => {
    const degradations: ExportDegradation[] = [];
    toMarkdown(GOLDEN_DOCUMENTS["title-rich-local-media"], {
      title: "Golden Export",
      onDegradation: (item) => degradations.push(item),
    });
    expect(degradations).toEqual([{
      kind: "markdown-columns-flattened",
      description: "分栏已拍平为纵向；需保留并排版式请导出 HTML 或 PDF",
    }]);
  });
});

function renderText(format: TextFormat, document: PmDoc): string {
  const options = { title: "Golden Export", baseUrl: "https://golden.invalid" };
  switch (format) {
    case "html":
      return toHtml(document, options);
    case "md":
      return toMarkdown(document, options);
    case "txt":
      return toTxt(document, options);
  }
}

async function canonicalizeDocx(buffer: Buffer): Promise<Map<string, Buffer>> {
  const zip = await JSZip.loadAsync(buffer);
  const partNames = Object.keys(zip.files)
    .filter((name) =>
      REQUIRED_DOCX_XML_PARTS.includes(name as (typeof REQUIRED_DOCX_XML_PARTS)[number]) ||
      /^word\/_rels\/[^/]+\.rels$/.test(name) ||
      /^word\/media\/[^/]+$/.test(name),
    )
    .sort();
  for (const required of REQUIRED_DOCX_XML_PARTS) {
    expect(partNames, `DOCX 缺少必须 canonicalize 的 part: ${required}`).toContain(required);
  }

  const canonical = new Map<string, Buffer>();
  for (const name of partNames) {
    const entry = zip.file(name);
    if (!entry) throw new Error(`DOCX part 不可读: ${name}`);
    if (name.endsWith(".xml") || name.endsWith(".rels")) {
      canonical.set(name, Buffer.from(canonicalizeXml(await entry.async("string")), "utf8"));
    } else {
      canonical.set(name, await entry.async("nodebuffer"));
    }
  }
  return canonical;
}

function canonicalizeXml(xml: string): string {
  let parseFailed = false;
  const document = new DOMParser({
    onError: (level) => {
      if (level !== "warning") parseFailed = true;
    },
  }).parseFromString(xml, "application/xml");
  if (parseFailed || document.getElementsByTagName("parsererror").length > 0) {
    throw new Error("DOCX XML canonicalizer 解析失败");
  }
  sortAndFilterAttributes(document.documentElement as XmlElement);
  return new XMLSerializer().serializeToString(document);
}

function sortAndFilterAttributes(element: XmlElement): void {
  const attributes = Array.from({ length: element.attributes.length }, (_, index) => element.attributes.item(index))
    .filter((attribute): attribute is NonNullable<typeof attribute> => Boolean(attribute))
    .filter((attribute) => !isVolatileDocxAttribute(attribute.name, attribute.localName));

  while (element.attributes.length > 0) {
    const attribute = element.attributes.item(0);
    if (!attribute) break;
    element.removeAttributeNode(attribute);
  }
  attributes
    .sort((left, right) => left.name.localeCompare(right.name, "en"))
    .forEach((attribute) => {
      if (attribute.namespaceURI) {
        element.setAttributeNS(attribute.namespaceURI, attribute.name, attribute.value);
      } else {
        element.setAttribute(attribute.name, attribute.value);
      }
    });

  for (let child = element.firstChild; child; child = child.nextSibling) {
    if (child.nodeType === 1) sortAndFilterAttributes(child as XmlElement);
  }
}

function isVolatileDocxAttribute(name: string, localName: string | null): boolean {
  const normalized = (localName ?? name.split(":").at(-1) ?? name).toLowerCase();
  return normalized.startsWith("rsid") || /^(?:timestamp|created|modified|date|time)$/.test(normalized);
}

function updateTextGolden(path: string, value: string): void {
  if (!UPDATE_GOLDEN) return;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, value, "utf8");
}

function updateDocxGolden(root: string, parts: ReadonlyMap<string, Buffer>): void {
  if (!UPDATE_GOLDEN) return;
  rmSync(root, { recursive: true, force: true });
  for (const [name, value] of parts) {
    const path = join(root, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, value);
  }
}

function listFiles(root: string, relative = ""): string[] {
  const directory = join(root, relative);
  return readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const child = relative ? `${relative}/${entry.name}` : entry.name;
      return entry.isDirectory() ? listFiles(root, child) : [child];
    })
    .sort();
}
