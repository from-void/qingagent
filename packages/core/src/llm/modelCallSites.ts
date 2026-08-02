export const MODEL_CALL_SITES = {
  agentChat: "agentChat",
  agentSelectionEdit: "agentSelectionEdit",
  agentReviewSensitive: "agentReviewSensitive",
  agentReviewSource: "agentReviewSource",
  agentReviewDeai: "agentReviewDeai",
  agentReviewConsistency: "agentReviewConsistency",
  agentReviewPrivacy: "agentReviewPrivacy",
  agentReviewFormat: "agentReviewFormat",
  agentReviewRole: "agentReviewRole",
  agentReviewCustom: "agentReviewCustom",
  generateDerivative: "generateDerivative",
  agentQuestionnaireResume: "agentQuestionnaireResume",
  agentConfirmResume: "agentConfirmResume",
  planDraft: "planDraft",
  askMore: "askMore",
  writeDraft: "writeDraft",
  generateSvg: "generateSvg",
  generateTitle: "generateTitle",
  draftTemplate: "draftTemplate",
  rewriteReviewSupplement: "rewriteReviewSupplement",
  readImage: "readImage",
  visionTest: "visionTest",
  guardPii: "guardPii",
  guardPromptInjection: "guardPromptInjection",
  guardModeration: "guardModeration",
  webSearch: "webSearch",
  omObserve: "omObserve",
  omReflect: "omReflect",
  anthropicConnectionTest: "anthropicConnectionTest",
  liveEval: "liveEval",
  pmModelSmokeStructured: "pmModelSmokeStructured",
  pmModelSmokeText: "pmModelSmokeText",
  unknown: "unknown",
} as const;

export type ModelCallSite =
  (typeof MODEL_CALL_SITES)[keyof typeof MODEL_CALL_SITES];

export type ModelCallTransport =
  | "branch"
  | "ai-sdk-v2"
  | "mastra-v2-v3"
  | "manual-api";

const MODEL_CALL_SITE_SET = new Set<string>(Object.values(MODEL_CALL_SITES));

export function isModelCallSite(value: unknown): value is ModelCallSite {
  return typeof value === "string" && MODEL_CALL_SITE_SET.has(value);
}

export type AgentReviewType =
  | "sensitive"
  | "source"
  | "deai"
  | "consistency"
  | "privacy"
  | "format"
  | "role"
  | "custom";

export type AgentTurnKind = "generateDerivative";

const REVIEW_CALL_SITES: Record<AgentReviewType, ModelCallSite> = {
  sensitive: MODEL_CALL_SITES.agentReviewSensitive,
  source: MODEL_CALL_SITES.agentReviewSource,
  deai: MODEL_CALL_SITES.agentReviewDeai,
  consistency: MODEL_CALL_SITES.agentReviewConsistency,
  privacy: MODEL_CALL_SITES.agentReviewPrivacy,
  format: MODEL_CALL_SITES.agentReviewFormat,
  role: MODEL_CALL_SITES.agentReviewRole,
  custom: MODEL_CALL_SITES.agentReviewCustom,
};

export function resolveAgentModelCallSite(input: {
  reviewType?: AgentReviewType | null;
  turnKind?: AgentTurnKind | null;
  hasSelection?: boolean;
}): ModelCallSite {
  if (input.reviewType) return REVIEW_CALL_SITES[input.reviewType];
  if (input.turnKind === "generateDerivative") {
    return MODEL_CALL_SITES.generateDerivative;
  }
  if (input.hasSelection) return MODEL_CALL_SITES.agentSelectionEdit;
  return MODEL_CALL_SITES.agentChat;
}
