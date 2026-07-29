import { readFile } from "node:fs/promises";
import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { preflightMaterialFileBuffer } from "../tools/materialFilePreflight.js";

const fakeImageFixtureUrl = new URL(
  "./fixtures/A-r6-fake-image.docx.base64",
  import.meta.url,
);

async function fakeImageRenamedDocx(): Promise<Buffer> {
  const encoded = (await readFile(fakeImageFixtureUrl, "utf8")).trim();
  return Buffer.from(encoded, "base64");
}

async function officeFixture(
  requiredPart: "word/document.xml" | "xl/workbook.xml" | "ppt/presentation.xml",
): Promise<Buffer> {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", "<Types />");
  zip.file(requiredPart, "<root />");
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}

describe("preflightMaterialFileBuffer", () => {
  it("在落盘前拒绝线上 PNG 改名 DOCX 夹具，并返回稳定错误码", async () => {
    await expect(preflightMaterialFileBuffer({
      buffer: await fakeImageRenamedDocx(),
      filename: "A-r6-fake-image.docx",
      mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    })).resolves.toEqual({
      ok: false,
      error: "material_format_mismatch",
    });
  });

  it.each([
    ["report.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "word/document.xml"],
    ["table.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "xl/workbook.xml"],
    ["slides.pptx", "application/vnd.openxmlformats-officedocument.presentationml.presentation", "ppt/presentation.xml"],
  ] as const)("接受可打开且含必需部件的 Office 容器：%s", async (filename, mimeType, requiredPart) => {
    await expect(preflightMaterialFileBuffer({
      buffer: await officeFixture(requiredPart),
      filename,
      mimeType,
    })).resolves.toMatchObject({ ok: true });
  });

  it.each([
    {
      filename: "brief.pdf",
      mimeType: "application/pdf",
      buffer: Buffer.from("%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF\n"),
    },
    {
      filename: "notes.md",
      mimeType: "text/markdown",
      buffer: Buffer.from("# 可读素材\n"),
    },
    {
      filename: "figure.png",
      mimeType: "image/png",
      buffer: Buffer.from("iVBORw0KGgo=", "base64"),
    },
    {
      filename: "unknown-mime.png",
      mimeType: "application/octet-stream",
      buffer: Buffer.from("iVBORw0KGgo=", "base64"),
    },
  ])("接受基本可读的 $filename", async (input) => {
    await expect(preflightMaterialFileBuffer(input)).resolves.toMatchObject({ ok: true });
  });

  it.each([
    {
      name: "非 ZIP 的 DOCX",
      input: {
        buffer: Buffer.from("not-a-zip"),
        filename: "broken.docx",
        mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      },
      error: "material_unreadable",
    },
    {
      name: "截断 PDF",
      input: {
        buffer: Buffer.from("%PDF-1.7\ntruncated"),
        filename: "broken.pdf",
        mimeType: "application/pdf",
      },
      error: "material_unreadable",
    },
    {
      name: "空文本",
      input: {
        buffer: Buffer.alloc(0),
        filename: "empty.txt",
        mimeType: "text/plain",
      },
      error: "material_unreadable",
    },
    {
      name: "二进制伪装文本",
      input: {
        buffer: Buffer.from([0x01, 0x02, 0x03, 0x04]),
        filename: "binary.txt",
        mimeType: "text/plain",
      },
      error: "material_unreadable",
    },
    {
      name: "扩展名与 MIME 冲突",
      input: {
        buffer: Buffer.from("%PDF-1.7\n%%EOF"),
        filename: "wrong.pdf",
        mimeType: "image/png",
      },
      error: "material_format_mismatch",
    },
    {
      name: "不支持的扩展名",
      input: {
        buffer: Buffer.from("{}"),
        filename: "data.json",
        mimeType: "application/json",
      },
      error: "material_unsupported",
    },
  ])("拒绝脏输入：$name", async ({ input, error }) => {
    await expect(preflightMaterialFileBuffer(input)).resolves.toEqual({ ok: false, error });
  });
});
