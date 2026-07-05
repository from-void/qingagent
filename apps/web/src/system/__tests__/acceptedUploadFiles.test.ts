import { describe, expect, it } from "vitest";
import {
  ACCEPTED_UPLOAD_ACCEPT_ATTR,
  ACCEPTED_UPLOAD_EXTENSIONS,
  isAcceptedUploadFile,
} from "../acceptedDocumentFiles";

// 回归(验收 Agent C 发现):对话上传白名单原先只含文档,拒收图片 → 用户无法附图识别。
// 现统一白名单 = 文档 + 图片(png/jpg/jpeg/webp/gif)。

describe("accepted upload files (含图片)", () => {
  it("图片扩展名进入上传白名单", () => {
    for (const ext of [".png", ".jpg", ".jpeg", ".webp", ".gif"]) {
      expect(ACCEPTED_UPLOAD_EXTENSIONS).toContain(ext);
    }
  });

  it("文档扩展名仍在白名单(未回退)", () => {
    for (const ext of [".pdf", ".docx", ".txt", ".md"]) {
      expect(ACCEPTED_UPLOAD_EXTENSIONS).toContain(ext);
    }
  });

  it("isAcceptedUploadFile:png/jpg 按扩展名或 mime 都接受", () => {
    expect(isAcceptedUploadFile({ name: "photo.png", type: "image/png" })).toBe(true);
    expect(isAcceptedUploadFile({ name: "x.JPG", type: "" })).toBe(true);
    expect(isAcceptedUploadFile({ name: "noext", type: "image/webp" })).toBe(true);
    expect(isAcceptedUploadFile({ name: "doc.pdf", type: "application/pdf" })).toBe(true);
  });

  it("非白名单(exe/未知)仍被拒", () => {
    expect(isAcceptedUploadFile({ name: "evil.exe", type: "application/x-msdownload" })).toBe(false);
    expect(isAcceptedUploadFile({ name: "x.bmp", type: "image/bmp" })).toBe(false);
  });

  it("accept 属性含图片 mime", () => {
    expect(ACCEPTED_UPLOAD_ACCEPT_ATTR).toContain("image/png");
    expect(ACCEPTED_UPLOAD_ACCEPT_ATTR).toContain(".png");
  });
});
