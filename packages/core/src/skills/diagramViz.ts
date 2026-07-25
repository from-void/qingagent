import type { RequestContext } from "@mastra/core/request-context";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BUILTIN_SKILLS_DIR } from "./paths.js";
import {
  activateSkill,
  isSkillActivated,
  parseSkillWriteInjectSource,
  registerSkillWriteInjectResolver,
} from "./writeInject.js";

export const DIAGRAM_VIZ_SKILL_NAME = "diagram-viz";
export const DIAGRAM_VIZ_EDITING_REQUEST_CONTEXT_KEY =
  "qingagentDiagramVizEditing";

export type DiagramVizLanguage = "mermaid" | "drawio";

export interface DiagramVizEditingRequestState {
  languages: DiagramVizLanguage[];
}

export interface DiagramVizResources {
  skillBody: string;
  mermaid: string;
  drawio: string;
  mermaidPalettes: string;
  drawioPalettes: string;
  mermaidTemplate: string;
  drawioTemplate: string;
}

const DRAWIO_INTENT_RE =
  /\b(?:draw\.?io|mxgraph|mxcell|mxgraphmodel)\b|网络拓扑|部署图|系统架构|架构图|工程框图|容器分组|精确坐标|复杂连线/iu;
const MERMAID_INTENT_RE =
  /\bmermaid\b|流程图?|时序图?|序列图?|状态图?|类图|ER\s*图?|甘特图?|饼图|脑图|思维导图/iu;

let cachedResources: DiagramVizResources | null = null;

function extractMarkedSection(source: string, marker: string): string {
  const start = `<!-- diagram-viz:${marker}:start -->`;
  const end = `<!-- diagram-viz:${marker}:end -->`;
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end);
  if (startIndex < 0 || endIndex <= startIndex) {
    throw new Error(`diagram-viz 资源缺少 ${marker} 标记`);
  }
  return source.slice(startIndex + start.length, endIndex).trim();
}

export function loadDiagramVizResources(): DiagramVizResources {
  if (cachedResources) return cachedResources;
  const root = join(BUILTIN_SKILLS_DIR, "capability", DIAGRAM_VIZ_SKILL_NAME);
  const references = join(root, "references");
  const skill = readFileSync(join(root, "SKILL.md"), "utf8");
  const mermaid = readFileSync(join(root, "mermaid", "SKILL.md"), "utf8");
  const drawio = readFileSync(join(root, "drawio", "SKILL.md"), "utf8");
  const palettes = readFileSync(join(references, "palettes.md"), "utf8");
  const templates = readFileSync(join(references, "templates.md"), "utf8");
  cachedResources = {
    skillBody: parseSkillWriteInjectSource(skill).body,
    mermaid: extractMarkedSection(mermaid, "mermaid"),
    drawio: extractMarkedSection(drawio, "drawio"),
    mermaidPalettes: extractMarkedSection(palettes, "palettes:mermaid"),
    drawioPalettes: extractMarkedSection(palettes, "palettes:drawio"),
    mermaidTemplate: extractMarkedSection(templates, "template:mermaid"),
    drawioTemplate: extractMarkedSection(templates, "template:drawio"),
  };
  return cachedResources;
}

function uniqueLanguages(languages: Iterable<DiagramVizLanguage>): DiagramVizLanguage[] {
  const seen = new Set(languages);
  return (["mermaid", "drawio"] as const).filter((language) => seen.has(language));
}

export function inferDiagramVizLanguages(text: string): DiagramVizLanguage[] {
  const languages: DiagramVizLanguage[] = [];
  if (MERMAID_INTENT_RE.test(text)) languages.push("mermaid");
  if (DRAWIO_INTENT_RE.test(text)) languages.push("drawio");
  return languages;
}

export function normalizeDiagramVizLanguage(value: unknown): DiagramVizLanguage | null {
  return value === "drawio" ? "drawio" : value === "mermaid" ? "mermaid" : null;
}

function editingRequestState(
  requestContext?: RequestContext,
): DiagramVizEditingRequestState | null {
  const state = requestContext?.get(DIAGRAM_VIZ_EDITING_REQUEST_CONTEXT_KEY);
  if (!state || typeof state !== "object") return null;
  return state as DiagramVizEditingRequestState;
}

function ensureEditingRequestState(
  requestContext?: RequestContext,
): DiagramVizEditingRequestState | null {
  if (!requestContext) return null;
  const existing = editingRequestState(requestContext);
  if (existing) return existing;
  const next: DiagramVizEditingRequestState = { languages: [] };
  requestContext.set(DIAGRAM_VIZ_EDITING_REQUEST_CONTEXT_KEY, next);
  return next;
}

export function activateDiagramVizSkill(
  requestContext: RequestContext | undefined,
  hintText = "",
): void {
  activateSkill(requestContext, DIAGRAM_VIZ_SKILL_NAME, hintText);
}

export function autoActivateDiagramVizSkillForWrite(
  requestContext: RequestContext | undefined,
  hintText: string,
): boolean {
  if (isSkillActivated(requestContext, DIAGRAM_VIZ_SKILL_NAME)) return false;
  const languages = inferDiagramVizLanguages(hintText);
  if (languages.length === 0) return false;
  return activateSkill(requestContext, DIAGRAM_VIZ_SKILL_NAME, hintText);
}

export function markDiagramVizEditing(
  requestContext: RequestContext | undefined,
  languages: Iterable<DiagramVizLanguage>,
): void {
  const state = ensureEditingRequestState(requestContext);
  if (!state) return;
  state.languages = uniqueLanguages([
    ...state.languages,
    ...languages,
  ]);
}

function resolveWriteLanguages(
  hintText: string,
  activationHints: readonly string[],
): DiagramVizLanguage[] {
  const resolved = uniqueLanguages(
    [hintText, ...activationHints].flatMap(inferDiagramVizLanguages),
  );
  // 用户只说“画图”时，内层仍需看见双引擎裁决；明确到某一引擎时只注入该段。
  return resolved.length > 0 ? resolved : ["mermaid", "drawio"];
}

export function buildDiagramVizInstruction(
  languages: Iterable<DiagramVizLanguage>,
  purpose: "write" | "edit",
): string {
  const resources = loadDiagramVizResources();
  const resolved = uniqueLanguages(languages);
  if (resolved.length === 0) return "";
  const purposeLabel =
    purpose === "write"
      ? "writeDraft 内层生成"
      : "readDraft 读取图表后的下一步编辑";
  const sections = resolved.flatMap((language) =>
    language === "mermaid"
      ? [resources.mermaid, resources.mermaidPalettes, resources.mermaidTemplate]
      : [resources.drawio, resources.drawioPalettes, resources.drawioTemplate],
  );
  return [
    `<diagram_viz_instruction purpose="${purpose}" languages="${resolved.join(",")}">`,
    `以下是 diagram-viz 技能对“${purposeLabel}”的按需规范。它只作用于当前请求尾部，不替换主 system。`,
    resources.skillBody,
    ...sections,
    `</diagram_viz_instruction>`,
  ].join("\n\n");
}

export function getDiagramVizEditingLanguages(
  requestContext: RequestContext | undefined,
): DiagramVizLanguage[] {
  return [...(editingRequestState(requestContext)?.languages ?? [])];
}

export function buildDiagramVizEditingInstructionFromContext(
  requestContext: RequestContext | undefined,
): string {
  const languages = getDiagramVizEditingLanguages(requestContext);
  if (languages.length === 0) return "";
  return buildDiagramVizInstruction(languages, "edit");
}

registerSkillWriteInjectResolver(
  DIAGRAM_VIZ_SKILL_NAME,
  ({ hintText, activationHints }) =>
    buildDiagramVizInstruction(
      resolveWriteLanguages(hintText, activationHints),
      "write",
    ),
);
