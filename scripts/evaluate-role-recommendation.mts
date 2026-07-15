import {
  NEW_ROLE_REVIEW_SEEDS,
  UPGRADED_ROLE_REVIEW_SEEDS,
} from "../packages/core/src/review/reviewRoleTemplatePrompts.ts";
import { REVIEW_TEMPLATE_PROMPT_SEEDS } from "../packages/core/src/review/reviewTemplatePrompts.ts";
import {
  evaluateRoleRecommendation,
  formatRoleRecommendationReport,
  ROLE_REVIEW_PROFILES,
} from "../apps/web/src/pages/workspace/components/roleReview/index.ts";

const movedPrompts = REVIEW_TEMPLATE_PROMPT_SEEDS.filter((seed) =>
  seed.id === "review-custom-legal" || seed.id === "review-custom-boss");
const promptById = new Map(
  [...NEW_ROLE_REVIEW_SEEDS, ...UPGRADED_ROLE_REVIEW_SEEDS, ...movedPrompts]
    .map((seed) => [seed.id, seed.prompt] as const),
);

const candidateLines = ROLE_REVIEW_PROFILES.map((profile) => {
  const prompt = promptById.get(profile.id);
  if (!prompt) throw new Error(`缺少 ${profile.id} 的提示词来源`);
  if (profile.keywords.length < 15 || profile.keywords.length > 30) {
    throw new Error(`${profile.name} 候选关键词数 ${profile.keywords.length} 不在 15-30`);
  }
  const missingPromptTerms = profile.keywords
    .filter((keyword) => keyword.source === "prompt" && !prompt.toLocaleLowerCase("zh-CN").includes(keyword.term.toLocaleLowerCase("zh-CN")))
    .map((keyword) => keyword.term);
  if (missingPromptTerms.length > 0) {
    throw new Error(`${profile.name} 的 prompt 关键词不在原提示词中：${missingPromptTerms.join("、")}`);
  }
  const generated = [...new Set(profile.keywords.map((keyword) => keyword.term))];
  return `${profile.name}(${generated.length})：${generated.join("、")}`;
});

const evaluation = evaluateRoleRecommendation();
console.info(["[R4 role keyword candidates]", ...candidateLines, formatRoleRecommendationReport(evaluation)].join("\n"));
if (evaluation.top1Hits !== evaluation.cases.length || evaluation.top3Hits !== evaluation.cases.length) {
  process.exitCode = 1;
}
