import type { ArticleData, MasonryColorConfig, TemplateDefinition } from "../../../system/chinese-masonry";
import type { HomeSession } from "../data/sessions";

export function homeSessionToArticle(session: HomeSession): ArticleData {
  return {
    id: session.id,
    title: session.title,
    description: session.brief,
    imageUrl: session.imageUrl ?? undefined,
    category: session.category,
    tags: session.sources.map((source) => source.kind),
    date: session.date,
    metadata: {
      createdAt: session.createdAt,
      pushedAt: session.pushedAt,
      recentEditedAt: session.recentEditedAt,
      sources: session.sources,
    },
  };
}

// ---------------------------------------------------------------------------
// Custom template filter — hard exclusion rules for Qingagent
// ---------------------------------------------------------------------------

const HAS_ENGLISH = /[a-zA-Z]/;

/**
 * Determines whether a template is eligible for a given article.
 *
 * Rule 1: English content in title or description -> hard-exclude vertical-text templates.
 *         The component only applies a soft 0.3x penalty; we need hard exclusion because
 *         vertical text layout does not render English correctly.
 *
 * Note: Title capacity filtering is handled by the component's built-in scoring
 * (templates where the title exceeds capacity already score 0). Adding capacity
 * checks here would prevent the allowFallback mechanism from working.
 */
export function qingagentTemplateFilter(article: ArticleData, template: TemplateDefinition): boolean {
  const titleBody = article.title + (article.description ?? "");

  // Rule 1: English content -> no vertical templates
  if (HAS_ENGLISH.test(titleBody) && template.meta.preferVerticalText) {
    return false;
  }

  return true;
}

export const colorConfig: MasonryColorConfig = {
  enabled: true,
  grayscale: 0.46,
  sepia: 0.08,
  overlayColor: "rgba(31, 42, 49, 0.12)",
  overlayOpacity: 0.82,
  textColor: "#1f2a31",
  lineColor: "rgba(31, 42, 49, 0.38)",
  transitionDuration: 320,
};
