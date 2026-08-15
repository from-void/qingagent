import { describe, expect, it } from "vitest";
import type {
  ExternalAssetUploadJsonRequest,
  ExternalAssetUploadResponse,
  ExternalBridgeFrame,
  ExternalReviewRenderModelResponse,
} from "../ExternalApi";

describe("external API 文档契约", () => {
  it("ExternalBridgeFrame 按 kind 收窄完整文档数据", () => {
    const frame: ExternalBridgeFrame = {
      seq: 8,
      kind: "docDiffReady",
      data: { baseVersion: 7, suggestions: [], wholeDocument: true },
    };

    if (frame.kind !== "docDiffReady") throw new Error("unexpected frame");
    expect(frame.data.baseVersion).toBe(7);
    expect(frame.data.wholeDocument).toBe(true);
  });

  it("render-model 直接携带 DocDiffReady 字段", () => {
    const response: ExternalReviewRenderModelResponse = {
      sessionId: "session-1",
      docVersion: 3,
      state: "pendingReview",
      agentBusy: false,
      baseVersion: 3,
      suggestions: [],
      previewDoc: {
        type: "doc",
        attrs: { schemaVersion: 1 },
        content: [],
      },
    };

    expect(response.baseVersion).toBe(response.docVersion);
    expect(response.previewDoc?.type).toBe("doc");
  });

  it("资产上传返回内部同形 fileId 与可写入 PmDoc 的持久化 src", () => {
    const request: ExternalAssetUploadJsonRequest = {
      filename: "示意图.png",
      mimeType: "image/png",
      base64: "iVBORw0KGgo=",
    };
    const response: ExternalAssetUploadResponse = {
      fileId: "550e8400-e29b-41d4-a716-446655440000",
      filename: request.filename,
      mimeType: request.mimeType!,
      size: 8,
      src: "/api/v1/files/550e8400-e29b-41d4-a716-446655440000/%E7%A4%BA%E6%84%8F%E5%9B%BE.png",
    };

    expect(response.src).toBe(
      `/api/v1/files/${response.fileId}/${encodeURIComponent(response.filename)}`,
    );
  });
});
