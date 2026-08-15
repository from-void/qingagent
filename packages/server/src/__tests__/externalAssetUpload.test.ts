import { describe, expect, it } from "vitest";
import {
  decodeExternalAssetBase64,
  parseExternalAssetJson,
  validateExternalAssetUploadInput,
} from "../lib/externalAssetUpload";

describe("external asset base64 解析", () => {
  it.each([
    ["尾随散文", "iVBORw0KGgo= done"],
    ["代码围栏", "```iVBORw0KGgo=```"],
    ["非法字符", "iVBORw0K@g=="],
    ["padding 在中间", "iVBO=Rw0KGgo"],
    ["只有 padding", "=="],
    ["无法补齐的长度", "a"],
  ])("拒绝%s", (_name, value) => {
    expect(decodeExternalAssetBase64(value)).toBeNull();
  });

  it("兼容标准 padding 与合法无 padding，逐字节一致", () => {
    const expected = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(decodeExternalAssetBase64("iVBORw0KGgo=")).toEqual(expected);
    expect(decodeExternalAssetBase64("iVBORw0KGgo")).toEqual(expected);
  });

  it("JSON 只接受图片、拒绝空内容与解码后超限", () => {
    expect(parseExternalAssetJson({
      filename: "figure.png",
      mimeType: "image/png",
      base64: "iVBORw0KGgo=",
    }, 8)).toMatchObject({ ok: true, input: { mimeType: "image/png" } });
    expect(parseExternalAssetJson({
      filename: "figure.png",
      mimeType: "image/png",
      base64: "",
    }, 8)).toEqual({ ok: false, error: "invalid_base64" });
    expect(parseExternalAssetJson({
      filename: "figure.png",
      mimeType: "image/png",
      base64: Buffer.alloc(9).toString("base64"),
    }, 8)).toEqual({ ok: false, error: "file_too_large" });
    expect(validateExternalAssetUploadInput({
      filename: "../figure.png",
      mimeType: "image/png",
      buffer: Buffer.from("x"),
    }, 8)).toEqual({ ok: false, error: "invalid_filename" });
    expect(validateExternalAssetUploadInput({
      filename: "notes.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("x"),
    }, 8)).toEqual({ ok: false, error: "unsupported_media" });
  });
});
