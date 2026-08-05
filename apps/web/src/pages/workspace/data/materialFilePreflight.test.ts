// @vitest-environment jsdom
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
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
  it("接受超过 64KiB 且 UTF-8 多字节字符跨越采样边界的中文文本", async () => {
    const file = new File(["一".repeat(30_000)], "boundary.md", {
      type: "text/markdown",
    });

    expect(file.size).toBeGreaterThan(64 * 1024);
    await expect(preflightBrowserMaterialFile(file)).resolves.toEqual({ ok: true });
  });

  it("接受超过 64KiB 且 UTF-16 代理对跨越采样边界的文本", async () => {
    const file = new File(
      [new Uint8Array([0xff, 0xfe]), Buffer.from("😀".repeat(20_000), "utf16le")],
      "utf16-boundary.txt",
      { type: "text/plain" },
    );

    expect(file.size).toBeGreaterThan(64 * 1024);
    await expect(preflightBrowserMaterialFile(file)).resolves.toEqual({ ok: true });
  });

  it("大文件只通过 slice 读取有界头部样本，不调用整文件 arrayBuffer", async () => {
    const file = new File([`# 标题\n${"a".repeat(1024 * 1024)}`], "large.md", {
      type: "text/markdown",
    });
    const wholeFileRead = vi.fn(async () => new ArrayBuffer(file.size));
    Object.defineProperty(file, "arrayBuffer", { value: wholeFileRead });
    const slice = vi.spyOn(file, "slice");

    await expect(preflightBrowserMaterialFile(file)).resolves.toEqual({ ok: true });

    expect(wholeFileRead).not.toHaveBeenCalled();
    expect(slice).toHaveBeenCalledTimes(1);
    expect(slice).toHaveBeenCalledWith(0, 64 * 1024);
  });

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

  it("截断样本仍拒绝内部混合编码、NUL 与控制字符", async () => {
    // F5 夹具前 96B：GBK 第一段后切到带 BOM 的 UTF-8，非法点位于样本内部。
    const mixedEncodingPrefix = Buffer.from(
      "tdrSu7bOo7rV4srHIEdCSyCx4MLrtcTW0M7E1f3OxKOsuqzIq73Ht/u6xaO6o7uhuKG5obaht6GqoaqhrQ0K77u/56ys5LqM5q6177ya6L+Z5piv5bimIEJPTSDnmoQg",
      "base64",
    );
    const largeAsciiTail = Buffer.alloc(64 * 1024, 0x61);

    await expect(preflightBrowserMaterialFile(new File(
      [Buffer.concat([mixedEncodingPrefix, largeAsciiTail])],
      "mixed.txt",
      { type: "text/plain" },
    ))).resolves.toEqual({ ok: false, error: "material_unreadable" });
    await expect(preflightBrowserMaterialFile(new File(
      ["可读前缀", new Uint8Array([0]), largeAsciiTail],
      "nul.txt",
      { type: "text/plain" },
    ))).resolves.toEqual({ ok: false, error: "material_unreadable" });
    await expect(preflightBrowserMaterialFile(new File(
      ["可读前缀\u0001", largeAsciiTail],
      "control.txt",
      { type: "text/plain" },
    ))).resolves.toEqual({ ok: false, error: "material_unreadable" });
  });

  it("完整文件末尾的不完整多字节序列仍按不可读拒绝", async () => {
    await expect(preflightBrowserMaterialFile(new File(
      [new Uint8Array([0x61, 0xe4])],
      "truncated-utf8.txt",
      { type: "text/plain" },
    ))).resolves.toEqual({
      ok: false,
      error: "material_unreadable",
    });
    await expect(preflightBrowserMaterialFile(new File(
      [new Uint8Array([0xff, 0xfe, 0x3d, 0xd8])],
      "truncated-utf16.txt",
      { type: "text/plain" },
    ))).resolves.toEqual({
      ok: false,
      error: "material_unreadable",
    });
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
