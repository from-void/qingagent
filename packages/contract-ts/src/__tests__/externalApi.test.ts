import { describe, expect, it } from "vitest";
import type {
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
});
