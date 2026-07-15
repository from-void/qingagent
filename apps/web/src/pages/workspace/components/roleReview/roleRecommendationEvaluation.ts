import { ROLE_REVIEW_PROFILES } from "./roleReviewCatalog";
import { scoreRoleReviewTemplates } from "./roleRecommendation";
import { generateRoleRecommendationCases } from "./roleRecommendationFixtures";

const EVAL_TEMPLATES = ROLE_REVIEW_PROFILES.map((profile) => ({ id: profile.id, name: profile.name }));

export interface RoleRecommendationCaseResult {
  id: string;
  genre: string;
  title: string;
  expectedRoleIds: readonly string[];
  ranking: ReturnType<typeof scoreRoleReviewTemplates>;
  top1Hit: boolean;
  top3Hit: boolean;
}

export interface RoleRecommendationEvaluation {
  cases: RoleRecommendationCaseResult[];
  top1Hits: number;
  top3Hits: number;
  top1Rate: number;
  top3Rate: number;
}

export function evaluateRoleRecommendation(): RoleRecommendationEvaluation {
  const cases = generateRoleRecommendationCases().map((testCase) => {
    const ranking = scoreRoleReviewTemplates(EVAL_TEMPLATES, testCase.title, testCase.body);
    const top1Hit = ranking[0]?.id === testCase.expectedRoleIds[0];
    const top3Ids = new Set(ranking.slice(0, 3).map((item) => item.id));
    const top3Hit = testCase.expectedRoleIds.some((id) => top3Ids.has(id));
    return { ...testCase, ranking, top1Hit, top3Hit };
  });
  const top1Hits = cases.filter((testCase) => testCase.top1Hit).length;
  const top3Hits = cases.filter((testCase) => testCase.top3Hit).length;
  return {
    cases,
    top1Hits,
    top3Hits,
    top1Rate: top1Hits / cases.length,
    top3Rate: top3Hits / cases.length,
  };
}

export function formatRoleRecommendationReport(evaluation: RoleRecommendationEvaluation): string {
  const rows = evaluation.cases.map((testCase, index) => {
    const scores = testCase.ranking.slice(0, 5).map((item) => `${item.name}=${item.score.toFixed(1)}`).join("；");
    return `${index + 1}. ${testCase.genre}｜期望 ${testCase.expectedRoleIds.join(",")}｜${scores}｜top1=${testCase.top1Hit ? "✓" : "×"} top3=${testCase.top3Hit ? "✓" : "×"}`;
  });
  return [
    "[R4 role recommendation evaluation]",
    ...rows,
    `命中率：top1 ${evaluation.top1Hits}/${evaluation.cases.length} (${(evaluation.top1Rate * 100).toFixed(1)}%)；top3 ${evaluation.top3Hits}/${evaluation.cases.length} (${(evaluation.top3Rate * 100).toFixed(1)}%)`,
  ].join("\n");
}
