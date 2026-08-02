/** 衍生稿撰写母技能名(与 packages/core/skills/capability/derivative-writing 目录同名)。 */
export const DERIVATIVE_WRITING_SKILL = "derivative-writing";

/**
 * dtype → 子技能名的唯一映射表。server 装配纪律、web 展示与校验都从这里取,
 * 不再各处硬编码字符串;新增衍生稿类型时只改这一处 + 建对应子技能目录。
 */
export const DERIVATIVE_CHILD_SKILL_BY_DTYPE = {
  gzh: "wechat-gzh",
  xhs: "xiaohongshu",
  translate: "translate",
} as const satisfies Record<"gzh" | "xhs" | "translate", string>;

export type DerivativeDtypeName = keyof typeof DERIVATIVE_CHILD_SKILL_BY_DTYPE;

/** 未知 dtype 返回 null,调用方据此回退到最小纪律,不抛错打断生成。 */
export function derivativeChildSkillFor(dtype: string): string | null {
  return DERIVATIVE_CHILD_SKILL_BY_DTYPE[dtype as DerivativeDtypeName] ?? null;
}

export interface DerivativeItem {
  docId: string;
  dtype: string;
  templateId: string;
  templateName: string;
  writingStyleId?: string;
  writingStyleName?: string;
  layoutStyleId?: string | null;
  layoutStyleName?: string | null;
  targetLang?: string | null;
  coverTemplate?: "poster" | "magazine" | "wenkai" | "impact" | "note";
  privatePrompt: string;
  sourceVersion: number | null;
  currentSourceVersion: number;
  generatedAt: string | null;
  stale: boolean;
}

export interface ListDerivatives { sessionId: string; requestId: string }
export interface CreateDerivative { sessionId: string; requestId: string; dtype: "gzh" | "xhs" | "translate"; templateId: string; writingStyleId?: string; layoutStyleId?: string | null; targetLang?: string; privatePrompt: string }
export interface DeleteDerivative { sessionId: string; requestId: string; docId: string }
export interface GetDerivativeDoc { sessionId: string; requestId: string; docId: string }
export type StyleTemplateSlot = "layout"|"writing"|"instruction";
export interface StyleTemplateItem { id:string;dtype:string;slot:StyleTemplateSlot;name:string;detail:string;prompt:string;builtin:boolean }
export interface ListStyleTemplates { sessionId:string;requestId:string;dtype?:string;slot?:StyleTemplateSlot }
export interface GetStyleTemplate { sessionId:string;requestId:string;id:string }
export interface SaveStyleTemplate { sessionId:string;requestId:string;id?:string;dtype:string;slot:StyleTemplateSlot;name:string;detail?:string;prompt:string }
export interface DeleteStyleTemplate { sessionId:string;requestId:string;id:string }
export interface UpdateDerivativeParams { sessionId:string;requestId:string;docId:string;layoutStyleId?:string;writingStyleId?:string;privatePrompt?:string;coverTemplate?:"poster"|"magazine"|"wenkai"|"impact"|"note" }
