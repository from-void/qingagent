import type { RequestContext } from "@mastra/core/request-context";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BUILTIN_SKILLS_DIR } from "./paths.js";

export const DIAGRAM_VIZ_SKILL_NAME = "diagram-viz";
export const DIAGRAM_VIZ_REQUEST_CONTEXT_KEY = "qingagentDiagramViz";

export type DiagramVizLanguage = "mermaid" | "drawio";

export interface DiagramVizRequestState {
  activated: boolean;
  skillBody: string;
  writeLanguages: DiagramVizLanguage[];
  editingLanguages: DiagramVizLanguage[];
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

function stripFrontmatter(source: string): string {
  return source.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "").trim();
}

function extractMarkedSection(source: string, marker: string): string {
  const start = `<!-- diagram-viz:${marker}:start -->`;
  const end = `<!-- diagram-viz:${marker}:end -->`;
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end);
  if (startIndex < 0 || endIndex <= startIndex) {
    throw new Error(`diagram-viz reference 缺少 ${marker} 标记`);
  }
  return source.slice(startIndex + start.length, endIndex).trim();
}

export function loadDiagramVizResources(): DiagramVizResources {
  if (cachedResources) return cachedResources;
  const root = join(BUILTIN_SKILLS_DIR, "capability", DIAGRAM_VIZ_SKILL_NAME);
  const references = join(root, "references");
  const skill = readFileSync(join(root, "SKILL.md"), "utf8");
  const mermaid = readFileSync(join(references, "mermaid.md"), "utf8");
  const drawio = readFileSync(join(references, "drawio.md"), "utf8");
  const palettes = readFileSync(join(references, "palettes.md"), "utf8");
  const templates = readFileSync(join(references, "templates.md"), "utf8");
  cachedResources = {
    skillBody: stripFrontmatter(skill),
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

function requestState(requestContext?: RequestContext): DiagramVizRequestState | null {
  const state = requestContext?.get(DIAGRAM_VIZ_REQUEST_CONTEXT_KEY);
  if (!state || typeof state !== "object") return null;
  return state as DiagramVizRequestState;
}

function ensureRequestState(requestContext?: RequestContext): DiagramVizRequestState | null {
  if (!requestContext) return null;
  const existing = requestState(requestContext);
  if (existing) return existing;
  const next: DiagramVizRequestState = {
    activated: false,
    skillBody: loadDiagramVizResources().skillBody,
    writeLanguages: [],
    editingLanguages: [],
  };
  requestContext.set(DIAGRAM_VIZ_REQUEST_CONTEXT_KEY, next);
  return next;
}

export function activateDiagramVizSkill(
  requestContext: RequestContext | undefined,
  hintText = "",
): void {
  const state = ensureRequestState(requestContext);
  if (!state) return;
  state.activated = true;
  state.writeLanguages = uniqueLanguages([
    ...state.writeLanguages,
    ...inferDiagramVizLanguages(hintText),
  ]);
}

export function autoActivateDiagramVizSkillForWrite(
  requestContext: RequestContext | undefined,
  hintText: string,
): boolean {
  const existing = requestState(requestContext);
  if (existing?.activated) return false;
  const languages = inferDiagramVizLanguages(hintText);
  if (languages.length === 0) return false;
  const state = ensureRequestState(requestContext);
  if (!state) return false;
  state.activated = true;
  state.writeLanguages = uniqueLanguages([...state.writeLanguages, ...languages]);
  return true;
}

export function markDiagramVizEditing(
  requestContext: RequestContext | undefined,
  languages: Iterable<DiagramVizLanguage>,
): void {
  const state = ensureRequestState(requestContext);
  if (!state) return;
  state.editingLanguages = uniqueLanguages([
    ...state.editingLanguages,
    ...languages,
  ]);
}

function resolveWriteLanguages(
  state: DiagramVizRequestState,
  hintText: string,
): DiagramVizLanguage[] {
  const inferred = inferDiagramVizLanguages(hintText);
  const resolved = uniqueLanguages([...state.writeLanguages, ...inferred]);
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

export function buildActivatedDiagramVizInstruction(
  requestContext: RequestContext | undefined,
  hintText: string,
): string {
  const state = requestState(requestContext);
  if (!state?.activated) return "";
  return buildDiagramVizInstruction(resolveWriteLanguages(state, hintText), "write");
}

export function buildDiagramVizEditingInstructionFromContext(
  requestContext: RequestContext | undefined,
): string {
  const state = requestState(requestContext);
  if (!state || state.editingLanguages.length === 0) return "";
  return buildDiagramVizInstruction(state.editingLanguages, "edit");
}
