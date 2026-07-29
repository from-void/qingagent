// @vitest-environment jsdom
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  materialPreflightErrorMessage,
  preflightBrowserMaterialFile,
} from "./materialFilePreflight";

const fakeImageFixturePath = path.resolve(
  process.cwd(),
  "../../packages/core/src/__tests__/fixtures/A-r6-fake-image.docx.base64",
);
const validXlsxFixturePath = path.resolve(
  process.cwd(),
  "../../packages/core/src/__tests__/fixtures/xlsx-number-formats.xlsx",
);

async function fixtureFile(filePath: string, filename: string, type: string): Promise<File> {
  return new File([await readFile(filePath)], filename, { type });
}

describe("preflightBrowserMaterialFile", () => {
  it("真实读取 input File 内容，在上传前拦住 PNG 改名 DOCX", async () => {
    const encoded = (await readFile(fakeImageFixturePath, "utf8")).trim();
    const file = new File(
      [Buffer.from(encoded, "base64")],
      "A-r6-fake-image.docx",
      { type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" },
    );

    await expect(preflightBrowserMaterialFile(file)).resolves.toEqual({
      ok: false,
      error: "material_format_mismatch",
    });
  });

  it.each([
    ["brief.pdf", "application/pdf", "%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF\n"],
    ["notes.md", "text/markdown", "# 可读素材\n"],
    ["figure.png", "image/png", new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])],
  ])("接受可读的 %s", async (filename, type, content) => {
    await expect(preflightBrowserMaterialFile(
      new File([content], filename, { type }),
    )).resolves.toEqual({ ok: true });
  });

  it("接受含真实 ZIP 中央目录的 Office 文件", async () => {
    const file = await fixtureFile(
      validXlsxFixturePath,
      "valid.xlsx",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
    await expect(preflightBrowserMaterialFile(file)).resolves.toEqual({ ok: true });
  });

  it.each([
    ["broken.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "not-a-zip", "material_unreadable"],
    ["broken.pdf", "application/pdf", "%PDF-1.7\ntruncated", "material_unreadable"],
    ["empty.txt", "text/plain", "", "material_unreadable"],
    ["binary.txt", "text/plain", new Uint8Array([1, 2, 3]), "material_unreadable"],
    ["wrong.pdf", "image/png", "%PDF-1.7\n%%EOF", "material_format_mismatch"],
    ["data.json", "application/json", "{}", "material_unsupported"],
  ])("拒绝脏输入 %s", async (filename, type, content, error) => {
    await expect(preflightBrowserMaterialFile(
      new File([content], filename, { type }),
    )).resolves.toEqual({ ok: false, error });
  });

  it("错误码只映射为安全短中文，不泄漏解析器详情", () => {
    expect(materialPreflightErrorMessage("material_format_mismatch")).toBe("文件格式与内容不一致");
    expect(materialPreflightErrorMessage("material_unreadable")).toBe("文件无法读取");
    expect(materialPreflightErrorMessage("material_unsupported")).toBe("暂不支持这种文件");
  });
});
