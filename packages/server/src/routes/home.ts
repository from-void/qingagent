import { Hono } from "hono";
import type { HomeFeed, SessionMeta, LegacySection } from "@qingagent/contract-ts";
import { listHomeSessionThreads, pmToHomeArticleMeta } from "@qingagent/core";
import type { QingagentThreadMetadata } from "@qingagent/core";
import { legacySectionsToPm, type PmDoc } from "@qingagent/pm-schema";
import { sessionManager } from "../gateway/bridgeHandler";
import { requireTrustedOrigin } from "../lib/trustedOrigin";

export const homeRoutes = new Hono();

homeRoutes.get("/home", async (c) => {
  c.header("Cache-Control", "no-store");
  const { threads } = await listHomeSessionThreads({
    page: 0,
    perPage: 50,
  });

  const recent_sessions: SessionMeta[] = threads.map((t) => {
    const meta = (t.metadata ?? {}) as unknown as QingagentThreadMetadata;
    const doc = resolveHomePmDoc(meta);
    const articleMeta = doc
      ? pmToHomeArticleMeta(doc, { fallbackTitle: meta.title || t.title })
      : null;
    const summary = articleMeta?.description ?? buildDocPreview(meta.legacySections) ?? "未开始";

    return {
      id: t.id,
      title: articleMeta?.title || meta.title || t.title || "未命名草稿",
      created_at: t.createdAtIso,
      updated_at: t.contentEditedAt,
      summary,
      imageUrl: articleMeta?.imageUrl ?? null,
      status: { kind: "Active" as const },
      generating:
        sessionManager.frameLog.hasSession(t.id) &&
        sessionManager.frameLog.readFrom(t.id, Number.MAX_SAFE_INTEGER).activeRunner,
    };
  });

  const feed: HomeFeed = {
    recent_sessions,
    pinned_docs: [], // pinned_docs deferred — no pin mechanism yet
  };
  return c.json(feed);
});

homeRoutes.delete("/sessions/:id", async (c) => {
  const rejected = requireTrustedOrigin(c);
  if (rejected) return rejected;
  const sessionId = c.req.param("id");
  const result = await sessionManager.destroySession(sessionId);
  if (!result.deleted) {
    return c.json({ deleted: false, status: "pending" }, 202);
  }
  return c.json({ deleted: true });
});

function resolveHomePmDoc(meta: QingagentThreadMetadata): PmDoc | null {
  if (meta.doc) return meta.doc;
  if (!meta.legacySections || meta.legacySections.length === 0) return null;
  try {
    return legacySectionsToPm(meta.legacySections as never);
  } catch {
    return null;
  }
}

function buildDocPreview(sections: LegacySection[] | undefined): string | null {
  const text = (sections ?? [])
    .map(sectionText)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return null;
  return text.length > 42 ? `${text.slice(0, 42)}...` : text;
}

function sectionText(section: LegacySection): string {
  if (section.kind === "image") {
    return section.data.caption ?? section.data.alt;
  }
  if ("text" in section.data && typeof section.data.text === "string") {
    return section.data.text;
  }
  if ("body" in section.data && typeof section.data.body === "string") {
    return section.data.body;
  }
  if (section.kind === "table") {
    return [section.data.head.join(" "), ...section.data.rows.map((row) => row.join(" "))].join(" ");
  }
  return "";
}
