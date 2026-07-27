import type { PmDoc } from "@qingagent/pm-schema";
import { describe, expect, it } from "vitest";
import { UPLOAD_PLACEHOLDER_IMAGE_SRC } from "./insertUploadedAsset";
import { buildPageExitDocSaveCommand } from "./pageExitSave";

function placeholderDoc(extraContent: PmDoc["content"] = []): PmDoc {
  return {
    type: "doc",
    attrs: { schemaVersion: 1 },
    content: [
      ...extraContent,
      {
        type: "image",
        attrs: {
          blockId: "upload-image-pending",
          src: UPLOAD_PLACEHOLDER_IMAGE_SRC,
          alt: "figure.png",
          uploading: true,
          progress: 20,
          error: false,
        },
      } as unknown as PmDoc["content"][number],
    ],
  };
}

describe("pageExitSave 图片上传占位", () => {
  it("新文档只有上传占位时不创建幽灵文档", () => {
    expect(buildPageExitDocSaveCommand({
      sessionId: "session-new",
      expectedDocumentSnapshot: 0,
      baseContentHash: "empty",
      pmDoc: placeholderDoc(),
      hasPendingDocSave: true,
      createMutationId: () => "mutation-new",
    })).toBeNull();
  });

  it("已有文档离页保存时剔除未完成图片但保留真实正文", () => {
    const paragraph: PmDoc["content"][number] = {
      type: "paragraph",
      attrs: { blockId: "p-1" },
      content: [{ type: "text", text: "正文" }],
    };
    const command = buildPageExitDocSaveCommand({
      sessionId: "session-existing",
      expectedDocumentSnapshot: 7,
      baseContentHash: "base",
      pmDoc: placeholderDoc([paragraph]),
      baselineDoc: {
        type: "doc",
        attrs: { schemaVersion: 1 },
        content: [paragraph],
      },
      hasPendingDocSave: true,
      createMutationId: () => "mutation-existing",
    });

    expect(command).not.toBeNull();
    expect(command?.data.doc?.content).toEqual([paragraph]);
    expect(command?.data.legacySections).toEqual([
      { kind: "p", data: { text: "正文" } },
    ]);
  });
});
