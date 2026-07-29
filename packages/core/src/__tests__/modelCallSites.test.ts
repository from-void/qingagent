import { describe, expect, it } from "vitest";
import {
  isModelCallSite,
  MODEL_CALL_SITES,
  resolveAgentModelCallSite,
} from "../llm/modelCallSites.js";

describe("主 Agent 模型调用 site 分类", () => {
  it.each([
    [{}, MODEL_CALL_SITES.agentChat],
    [{ hasSelection: true }, MODEL_CALL_SITES.agentSelectionEdit],
    [{ turnKind: "generateDerivative" as const }, MODEL_CALL_SITES.generateDerivative],
    [{ reviewType: "sensitive" as const }, MODEL_CALL_SITES.agentReviewSensitive],
    [{ reviewType: "source" as const }, MODEL_CALL_SITES.agentReviewSource],
    [{ reviewType: "deai" as const }, MODEL_CALL_SITES.agentReviewDeai],
    [{ reviewType: "consistency" as const }, MODEL_CALL_SITES.agentReviewConsistency],
    [{ reviewType: "privacy" as const }, MODEL_CALL_SITES.agentReviewPrivacy],
    [{ reviewType: "format" as const }, MODEL_CALL_SITES.agentReviewFormat],
    [{ reviewType: "role" as const }, MODEL_CALL_SITES.agentReviewRole],
    [{ reviewType: "custom" as const }, MODEL_CALL_SITES.agentReviewCustom],
  ])("把 %o 映射为 %s", (input, expected) => {
    expect(resolveAgentModelCallSite(input)).toBe(expected);
  });

  it("审查优先于衍生稿与选区，衍生稿优先于选区", () => {
    expect(resolveAgentModelCallSite({
      reviewType: "sensitive",
      turnKind: "generateDerivative",
      hasSelection: true,
    })).toBe(MODEL_CALL_SITES.agentReviewSensitive);
    expect(resolveAgentModelCallSite({
      turnKind: "generateDerivative",
      hasSelection: true,
    })).toBe(MODEL_CALL_SITES.generateDerivative);
  });

  it("只接受受控枚举值", () => {
    for (const site of Object.values(MODEL_CALL_SITES)) {
      expect(isModelCallSite(site)).toBe(true);
    }
    expect(isModelCallSite("agent")).toBe(false);
    expect(isModelCallSite("free-form-site")).toBe(false);
  });
});
