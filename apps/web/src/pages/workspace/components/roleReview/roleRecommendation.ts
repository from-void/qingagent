import type { ReviewTemplateItem } from "@qingagent/contract-ts";
import { ROLE_REVIEW_PROFILES, roleReviewProfile } from "./roleReviewCatalog";

export interface RoleRecommendationScore {
  id: string;
  name: string;
  score: number;
  defaultIndex: number;
  recommended: boolean;
  matchedKeywords: Array<{ term: string; score: number; titleCount: number; bodyCount: number }>;
}

function normalize(text: string): string {
  return text.normalize("NFKC").toLocaleLowerCase("zh-CN");
}

function occurrenceCount(text: string, term: string): number {
  if (!text || !term) return 0;
  let count = 0;
  let from = 0;
  while (from <= text.length - term.length) {
    const index = text.indexOf(term, from);
    if (index < 0) break;
    count += 1;
    from = index + term.length;
  }
  return count;
}

/** 首次命中计满分，重复命中按 log2 衰减并封顶，避免堆词支配排序。 */
export function decayedOccurrenceScore(count: number): number {
  if (count <= 0) return 0;
  return Math.min(2.75, 1 + Math.log2(count));
}

function defaultRoleIndex(templateId: string, inputIndex: number): number {
  const seedIndex = ROLE_REVIEW_PROFILES.findIndex((profile) => profile.id === templateId);
  return seedIndex >= 0 ? seedIndex : ROLE_REVIEW_PROFILES.length + inputIndex;
}

export function scoreRoleReviewTemplates(
  templates: readonly Pick<ReviewTemplateItem, "id" | "name">[],
  documentTitle: string,
  documentText: string,
): RoleRecommendationScore[] {
  const title = normalize(documentTitle);
  const body = normalize(documentText);
  const scored: RoleRecommendationScore[] = templates.map((template, inputIndex) => {
    const profile = roleReviewProfile(template.id);
    const matchedKeywords = (profile?.keywords ?? []).flatMap((keyword) => {
      const term = normalize(keyword.term);
      const titleCount = occurrenceCount(title, term);
      const bodyCount = occurrenceCount(body, term);
      if (titleCount === 0 && bodyCount === 0) return [];
      const score = keyword.weight * (
        2 * decayedOccurrenceScore(titleCount) + decayedOccurrenceScore(bodyCount)
      );
      return [{ term: keyword.term, score, titleCount, bodyCount }];
    });
    return {
      id: template.id,
      name: template.name,
      score: matchedKeywords.reduce((sum, keyword) => sum + keyword.score, 0),
      defaultIndex: defaultRoleIndex(template.id, inputIndex),
      recommended: false,
      matchedKeywords: matchedKeywords.sort((left, right) => right.score - left.score),
    };
  }).sort((left, right) => right.score - left.score || left.defaultIndex - right.defaultIndex);

  if ((scored[0]?.score ?? 0) > 0) scored[0] = { ...scored[0]!, recommended: true };
  return scored;
}

export function rankRoleReviewTemplates<T extends Pick<ReviewTemplateItem, "id" | "name">>(
  templates: readonly T[],
  documentTitle: string,
  documentText: string,
): Array<{ template: T; score: RoleRecommendationScore }> {
  const scoreById = new Map(scoreRoleReviewTemplates(templates, documentTitle, documentText).map((score) => [score.id, score]));
  return templates
    .map((template) => ({ template, score: scoreById.get(template.id)! }))
    .sort((left, right) => right.score.score - left.score.score || left.score.defaultIndex - right.score.defaultIndex);
}
