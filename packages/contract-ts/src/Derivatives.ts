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
  generatedAt: string | null;
  stale: boolean;
}

export interface ListDerivatives { sessionId: string; requestId: string }
export interface CreateDerivative { sessionId: string; requestId: string; dtype: "gzh" | "xhs" | "translate"; templateId: string; writingStyleId?: string; layoutStyleId?: string | null; targetLang?: string; privatePrompt: string }
export interface GenerateTranslations { sessionId: string; docIds: string[] }
export interface DeleteDerivative { sessionId: string; requestId: string; docId: string }
export interface GetDerivativeDoc { sessionId: string; requestId: string; docId: string }
export type StyleTemplateSlot = "layout"|"writing"|"instruction";
export interface StyleTemplateItem { id:string;dtype:string;slot:StyleTemplateSlot;name:string;detail:string;prompt:string;builtin:boolean }
export interface ListStyleTemplates { sessionId:string;requestId:string;dtype?:string;slot?:StyleTemplateSlot }
export interface GetStyleTemplate { sessionId:string;requestId:string;id:string }
export interface SaveStyleTemplate { sessionId:string;requestId:string;id?:string;dtype:string;slot:StyleTemplateSlot;name:string;detail?:string;prompt:string }
export interface DeleteStyleTemplate { sessionId:string;requestId:string;id:string }
export interface UpdateDerivativeParams { sessionId:string;requestId:string;docId:string;layoutStyleId?:string;writingStyleId?:string;privatePrompt?:string;coverTemplate?:"poster"|"magazine"|"wenkai"|"impact"|"note" }
