import { describe, expect, it } from "vitest";
import { loadPdfParseConstructor } from "@qingagent/doc-render/browser";
import { parseFileBuffer } from "./parseFile.js";

function createTextPdfFixture(): Buffer {
  const textStream = "BT\n/F1 18 Tf\n72 100 Td\n(PDF_PARSE_OK) Tj\nET";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    [
      "<< /Type /Page",
      "/Parent 2 0 R",
      "/Resources << /Font << /F1 4 0 R >> >>",
      "/MediaBox [0 0 300 160]",
      "/Contents 5 0 R >>",
    ].join(" "),
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(textStream, "utf8")} >>\nstream\n${textStream}\nendstream`,
  ];

  let body = "%PDF-1.4\n";
  const offsets: number[] = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(body, "utf8"));
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }

  const xrefOffset = Buffer.byteLength(body, "utf8");
  body += `xref\n0 ${objects.length + 1}\n`;
  body += "0000000000 65535 f \n";
  for (const offset of offsets.slice(1)) {
    body += `${offset.toString().padStart(10, "0")} 00000 n \n`;
  }
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\n`;
  body += `startxref\n${xrefOffset}\n%%EOF\n`;

  return Buffer.from(body, "utf8");
}

describe("PDF 解析加载", () => {
  it("能从 pdf-parse 导出中拿到可 new 的 PDFParse 并提取文本", async () => {
    const PDFParse = await loadPdfParseConstructor();
    const parser = new PDFParse({ data: new Uint8Array(createTextPdfFixture()) });

    try {
      const textResult = await parser.getText();
      expect(textResult.total).toBe(1);
      expect(textResult.text).toContain("PDF_PARSE_OK");
    } finally {
      await parser.destroy();
    }
  });

  it("parseFileBuffer 的 PDF 路径复用同一加载逻辑", async () => {
    const result = await parseFileBuffer({
      buffer: createTextPdfFixture(),
      filename: "fixture.pdf",
      mimeType: "application/pdf",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    expect(result.text).toContain("PDF_PARSE_OK");
    expect(result.metadata.pages).toBe(1);
    expect(result.metadata.indexable).toBe(true);
  });
});
