import { describe, expect, it } from "vitest";
import type { SessionMeta } from "@qingagent/contract-ts";
import { sessionMetaToHomeSession } from "../data/sessions";
import { homeSessionToArticle } from "./masonryAdapters";

describe("masonryAdapters", () => {
  it("passes server PM-derived imageUrl into ArticleData", () => {
    const meta: SessionMeta = {
      id: "session-1",
      title: "标题",
      created_at: "2026-06-06T00:00:00.000Z",
      summary: "摘要",
      imageUrl: "/api/v1/files/550e8400-e29b-41d4-a716-446655440000/figure.png",
      status: { kind: "Active" },
      generating: false,
    };

    const session = sessionMetaToHomeSession(meta);
    const article = homeSessionToArticle(session);

    expect(session.imageUrl).toBe(meta.imageUrl);
    expect(article.imageUrl).toBe(meta.imageUrl);
  });
});
