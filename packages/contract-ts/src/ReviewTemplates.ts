export type ReviewType =
  | "sensitive"
  | "deai"
  | "source"
  | "consistency"
  | "privacy"
  | "format"
  | "role"
  | "custom";

/** 菜单发起审查时随 sendMessage 结构化传给当前 agent 回合。 */
export interface ReviewContext {
  type: ReviewType;
  templateId: string;
  templateName: string;
}

export interface ReviewTemplateItem {
  id: string;
  type: ReviewType;
  name: string;
  prompt: string;
  builtin: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ListReviewTemplates { sessionId: string; type: ReviewType }
export interface SaveReviewTemplate { sessionId: string; id?: string; type: ReviewType; name: string; prompt: string }
export interface DeleteReviewTemplate { sessionId: string; id: string }
export interface SelectReviewTemplate { sessionId: string; type: ReviewType; templateId: string }
export interface GetReviewSupplement { sessionId: string; type: ReviewType }
export interface UpsertReviewSupplement { sessionId: string; type: ReviewType; supplement: string }
