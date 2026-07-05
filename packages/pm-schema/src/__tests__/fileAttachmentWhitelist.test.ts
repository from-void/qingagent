import { describe, expect, it } from "vitest";
import { isAllowedFileAttachment, isAllowedFileRef, safeParsePmDoc } from "../validators";

describe("fileAttachmentWhitelist", () => {
  it("allows legal PM file attachment attrs", () => {
    const attrs = {
      blockId: "block-file",
      fileId: "file_1",
      filename: "brief.pdf",
      mimeType: "application/pdf",
      size: 1024,
    };

    expect(isAllowedFileAttachment(attrs)).toBe(true);
    expect(isAllowedFileRef(attrs)).toBe(true);
  });

  it("rejects missing file metadata", () => {
    expect(isAllowedFileAttachment({ blockId: "block-file", fileId: "file_1", filename: "", mimeType: "application/pdf", size: 1 })).toBe(false);
  });

  it("validates fileAttachment nodes and does not expose a resourceRef node", () => {
    const result = safeParsePmDoc({
      type: "doc",
      attrs: { schemaVersion: 1 },
      content: [
        {
          type: "fileAttachment",
          attrs: {
            blockId: "block-file",
            fileId: "file_1",
            filename: "brief.pdf",
            mimeType: "application/pdf",
            size: 1024,
          },
        },
      ],
    });

    expect(result.success).toBe(true);
  });
});
