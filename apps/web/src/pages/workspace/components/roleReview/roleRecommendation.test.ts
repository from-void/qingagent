import { describe, expect, it } from "vitest";
import { ROLE_REVIEW_PROFILES } from "./roleReviewCatalog";
import {
  decayedOccurrenceScore,
  rankRoleReviewTemplates,
  scoreRoleReviewTemplates,
} from "./roleRecommendation";
import { evaluateRoleRecommendation, formatRoleRecommendationReport } from "./roleRecommendationEvaluation";
import { generateRoleRecommendationCases } from "./roleRecommendationFixtures";

describe("角色审查关键词推荐", () => {
  it("12 个固定 id 均有 15-30 个带权候选关键词，词项不重复", () => {
    expect(ROLE_REVIEW_PROFILES).toHaveLength(12);
    for (const profile of ROLE_REVIEW_PROFILES) {
      expect(Array.from(profile.position).length, profile.name).toBeLessThanOrEqual(8);
      expect(profile.keywords.length, profile.name).toBeGreaterThanOrEqual(15);
      expect(profile.keywords.length, profile.name).toBeLessThanOrEqual(30);
      expect(new Set(profile.keywords.map((keyword) => keyword.term)).size, profile.name).toBe(profile.keywords.length);
      expect(profile.keywords.every((keyword) => keyword.weight > 0)).toBe(true);
    }
  });

  it("标题命中加倍，同词多次命中按 log 衰减并封顶", () => {
    const engineer = [{ id: "review-role-engineer", name: "研发工程师" }];
    const bodyOnly = scoreRoleReviewTemplates(engineer, "", "PRD")[0]!;
    const titleOnly = scoreRoleReviewTemplates(engineer, "PRD", "")[0]!;
    expect(titleOnly.score).toBe(bodyOnly.score * 2);
    expect(decayedOccurrenceScore(1)).toBe(1);
    expect(decayedOccurrenceScore(2)).toBe(2);
    expect(decayedOccurrenceScore(4)).toBe(2.75);
    expect(decayedOccurrenceScore(20)).toBe(2.75);
  });

  it("零分内置按固定种子顺序垫底，用户角色保持输入相对顺序", () => {
    const templates = [
      { id: "user-role-b", name: "用户乙" },
      { id: "review-role-beginner", name: "小白读者视角" },
      { id: "review-role-engineer", name: "研发工程师" },
      { id: "user-role-a", name: "用户甲" },
    ];
    expect(rankRoleReviewTemplates(templates, "", "").map((item) => item.template.id)).toEqual([
      "review-role-engineer",
      "review-role-beginner",
      "user-role-b",
      "user-role-a",
    ]);
  });

  it("自动装配 10 篇不同体裁的 300-600 字用例，并锁定核心 top1", () => {
    const fixtures = generateRoleRecommendationCases();
    expect(fixtures.map((testCase) => testCase.genre)).toEqual([
      "PRD", "简历", "融资BP", "技术方案", "科普文", "论文摘要", "营销文案", "合同条款", "公众号推文", "周报",
    ]);
    for (const testCase of fixtures) {
      expect(testCase.body.length, testCase.genre).toBeGreaterThanOrEqual(300);
      expect(testCase.body.length, testCase.genre).toBeLessThanOrEqual(600);
      expect(testCase.expectedRoleIds.length, testCase.genre).toBeGreaterThanOrEqual(1);
      expect(testCase.expectedRoleIds.length, testCase.genre).toBeLessThanOrEqual(3);
    }

    const evaluation = evaluateRoleRecommendation();
    expect(evaluation.top1Hits).toBe(10);
    expect(evaluation.top3Hits).toBe(10);
    console.info(formatRoleRecommendationReport(evaluation));
  });
});
