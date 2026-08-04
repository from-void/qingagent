import type { RequestContext } from "@mastra/core/request-context";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { DEFAULT_SKILL_CHIP_INSTRUCTION_CHAR_LIMIT } from "../session/chipOnlyNote.js";
import { SKILL_NAME_RE, stripSkillSourceBom } from "./frontmatter.js";
import { BUILTIN_SKILLS_DIR, USER_SKILLS_DIR } from "./paths.js";

export const ACTIVATED_SKILLS_REQUEST_CONTEXT_KEY = "qingagentActivatedSkills";
export const SKILL_WRITE_INJECT_CHAR_LIMIT =
  DEFAULT_SKILL_CHIP_INSTRUCTION_CHAR_LIMIT;

const WRITE_INJECT_START = "<!-- skill:write-inject:start -->";
const WRITE_INJECT_END = "<!-- skill:write-inject:end -->";
const BUILTIN_SKILL_CATEGORIES = ["capability", "native", "style"] as const;

export interface ActivatedSkillRegistration {
  name: string;
  hints: string[];
}

export interface ActivatedSkillsRegistry {
  skills: Map<string, ActivatedSkillRegistration>;
}

export interface ParsedSkillWriteInject {
  name: string | null;
  writeInject: boolean;
  body: string;
  payload: string;
}

export interface SkillWriteInjectResolverInput {
  skillName: string;
  source: ParsedSkillWriteInject;
  defaultPayload: string;
  hintText: string;
  activationHints: readonly string[];
  requestContext: RequestContext | undefined;
}

export type SkillWriteInjectResolver = (
  input: SkillWriteInjectResolverInput,
) => string | null | undefined | Promise<string | null | undefined>;

export type SkillWriteInjectLoader = (
  skillName: string,
) => Promise<string | null | undefined>;

export interface SkillWriteInjectWarning {
  kind: "load-failed" | "resolver-failed" | "truncated";
  skillName?: string;
  message: string;
}

export interface BuildActivatedSkillWriteInjectOptions {
  requestContext: RequestContext | undefined;
  hintText: string;
  loadSkill?: SkillWriteInjectLoader;
  maxChars?: number;
  onWarning?: (warning: SkillWriteInjectWarning) => void;
}

export interface ActivatedSkillWriteInjectResult {
  content: string;
  injectedSkillNames: string[];
  originalCharCount: number;
  truncated: boolean;
}

const resolverRegistry = new Map<string, SkillWriteInjectResolver>();

function readRegistry(
  requestContext: RequestContext | undefined,
): ActivatedSkillsRegistry | null {
  const value = requestContext?.get(ACTIVATED_SKILLS_REQUEST_CONTEXT_KEY);
  if (
    !value ||
    typeof value !== "object" ||
    !((value as ActivatedSkillsRegistry).skills instanceof Map)
  ) {
    return null;
  }
  return value as ActivatedSkillsRegistry;
}

function ensureRegistry(
  requestContext: RequestContext | undefined,
): ActivatedSkillsRegistry | null {
  if (!requestContext) return null;
  const existing = readRegistry(requestContext);
  if (existing) return existing;
  const next: ActivatedSkillsRegistry = { skills: new Map() };
  requestContext.set(ACTIVATED_SKILLS_REQUEST_CONTEXT_KEY, next);
  return next;
}

export function activateSkill(
  requestContext: RequestContext | undefined,
  skillName: string,
  hintText = "",
): boolean {
  const name = skillName.trim();
  if (!name) return false;
  const registry = ensureRegistry(requestContext);
  if (!registry) return false;
  const existing = registry.skills.get(name);
  const hint = hintText.trim();
  if (existing) {
    if (hint && !existing.hints.includes(hint)) existing.hints.push(hint);
    return false;
  }
  registry.skills.set(name, {
    name,
    hints: hint ? [hint] : [],
  });
  return true;
}

export function isSkillActivated(
  requestContext: RequestContext | undefined,
  skillName: string,
): boolean {
  return readRegistry(requestContext)?.skills.has(skillName) === true;
}

export function getActivatedSkillRegistrations(
  requestContext: RequestContext | undefined,
): ActivatedSkillRegistration[] {
  const registry = readRegistry(requestContext);
  if (!registry) return [];
  return Array.from(registry.skills.values())
    .filter(
      (entry): entry is ActivatedSkillRegistration =>
        Boolean(
          entry &&
          typeof entry.name === "string" &&
          Array.isArray(entry.hints),
        ),
    )
    .map((entry) => ({
      name: entry.name,
      hints: entry.hints.filter((hint): hint is string => typeof hint === "string"),
    }));
}

export function registerSkillWriteInjectResolver(
  skillName: string,
  resolver: SkillWriteInjectResolver,
): () => void {
  resolverRegistry.set(skillName, resolver);
  return () => {
    if (resolverRegistry.get(skillName) === resolver) {
      resolverRegistry.delete(skillName);
    }
  };
}

function frontmatterField(
  frontmatter: string,
  fieldName: string,
): string | null {
  const escaped = fieldName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = frontmatter.match(
    new RegExp(`^${escaped}:\\s*([^#\\r\\n]*?)(?:\\s+#.*)?$`, "m"),
  );
  return match?.[1]?.trim() ?? null;
}

function markedPayload(body: string): string {
  const startIndex = body.indexOf(WRITE_INJECT_START);
  const endIndex = body.indexOf(WRITE_INJECT_END);
  if (startIndex < 0 && endIndex < 0) return body;
  // 标记残缺时回退完整正文，避免一处注释笔误让已声明技能静默失效。
  if (startIndex < 0 || endIndex <= startIndex) return body;
  return body.slice(startIndex + WRITE_INJECT_START.length, endIndex).trim();
}

export function parseSkillWriteInjectSource(
  source: string,
): ParsedSkillWriteInject {
  const normalizedSource = stripSkillSourceBom(source);
  const match = normalizedSource.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  const frontmatter = match?.[1] ?? "";
  const body = (
    match ? normalizedSource.slice(match[0].length) : normalizedSource
  ).trim();
  const writeInjectValue = frontmatterField(frontmatter, "write-inject");
  const normalizedWriteInject = writeInjectValue?.replace(/^(['"])(.*)\1$/, "$2");
  const parsedName = frontmatterField(frontmatter, "name");
  return {
    name: parsedName && SKILL_NAME_RE.test(parsedName) ? parsedName : null,
    writeInject: normalizedWriteInject?.toLowerCase() === "true",
    body,
    payload: markedPayload(body),
  };
}

async function loadSkillWriteInjectSourceFromDisk(
  skillName: string,
): Promise<string | null> {
  if (!SKILL_NAME_RE.test(skillName)) return null;
  const candidates = [
    ...BUILTIN_SKILL_CATEGORIES.map((category) =>
      join(BUILTIN_SKILLS_DIR, category, skillName, "SKILL.md")
    ),
    join(USER_SKILLS_DIR, skillName, "SKILL.md"),
  ];
  for (const candidate of candidates) {
    try {
      return await readFile(candidate, "utf8");
    } catch {
      // 技能可来自任一发现根，逐个尝试；全部缺失时按未声明处理。
    }
  }
  return null;
}

function escapeXmlAttr(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function renderWriteInjectChunk(skillName: string, payload: string): string {
  return [
    `<activated_skill_write_inject name="${escapeXmlAttr(skillName)}">`,
    payload,
    `</activated_skill_write_inject>`,
  ].join("\n");
}

function defaultWarningReporter(warning: SkillWriteInjectWarning): void {
  console.warn("[writeDraft] 技能写稿注入警告", warning);
}

export async function buildActivatedSkillWriteInject(
  options: BuildActivatedSkillWriteInjectOptions,
): Promise<ActivatedSkillWriteInjectResult> {
  const loadSkill = options.loadSkill ?? loadSkillWriteInjectSourceFromDisk;
  const maxChars = Math.max(
    0,
    Math.floor(options.maxChars ?? SKILL_WRITE_INJECT_CHAR_LIMIT),
  );
  const onWarning = options.onWarning ?? defaultWarningReporter;
  const registrations = getActivatedSkillRegistrations(options.requestContext)
    .sort((left, right) =>
      left.name === right.name ? 0 : left.name < right.name ? -1 : 1
    );
  const candidates: Array<{ skillName: string; payload: string }> = [];

  for (const registration of registrations) {
    let rawSource: string | null | undefined;
    try {
      rawSource = await loadSkill(registration.name);
    } catch (error) {
      onWarning({
        kind: "load-failed",
        skillName: registration.name,
        message: error instanceof Error ? error.message : String(error),
      });
      continue;
    }
    if (!rawSource) continue;
    const parsed = parseSkillWriteInjectSource(rawSource);
    if (!parsed.writeInject) continue;

    let payload: string | null | undefined = parsed.payload;
    const resolver = resolverRegistry.get(registration.name);
    if (resolver) {
      try {
        payload = await resolver({
          skillName: registration.name,
          source: parsed,
          defaultPayload: parsed.payload,
          hintText: options.hintText,
          activationHints: registration.hints,
          requestContext: options.requestContext,
        });
      } catch (error) {
        onWarning({
          kind: "resolver-failed",
          skillName: registration.name,
          message: error instanceof Error ? error.message : String(error),
        });
        continue;
      }
    }
    if (typeof payload !== "string" || payload.trim().length === 0) continue;
    candidates.push({ skillName: registration.name, payload: payload.trim() });
  }

  const chunks = candidates.map(({ skillName, payload }) =>
    renderWriteInjectChunk(skillName, payload)
  );
  const fullContent = chunks.join("\n\n");
  const truncated = fullContent.length > maxChars;
  const boundedChunks: string[] = [];
  const injectedSkillNames: string[] = [];
  if (!truncated) {
    boundedChunks.push(...chunks);
    injectedSkillNames.push(...candidates.map(({ skillName }) => skillName));
  } else {
    let usedChars = 0;
    for (const { skillName, payload } of candidates) {
      const separatorChars = boundedChunks.length > 0 ? 2 : 0;
      const availableChars = maxChars - usedChars - separatorChars;
      const emptyChunkChars = renderWriteInjectChunk(skillName, "").length;
      if (availableChars < emptyChunkChars) break;
      const fullChunk = renderWriteInjectChunk(skillName, payload);
      const chunk = fullChunk.length <= availableChars
        ? fullChunk
        : renderWriteInjectChunk(
          skillName,
          payload.slice(0, Math.max(0, availableChars - emptyChunkChars)),
        );
      boundedChunks.push(chunk);
      injectedSkillNames.push(skillName);
      usedChars += separatorChars + chunk.length;
      if (chunk.length < fullChunk.length) break;
    }
  }
  const content = boundedChunks.join("\n\n");
  if (truncated) {
    onWarning({
      kind: "truncated",
      message:
        `已激活技能写稿注入共 ${fullContent.length} 字符，超过硬上限 ${maxChars}，` +
        `已按完整 XML 块裁剪为 ${content.length} 字符。`,
    });
  }
  return {
    content,
    injectedSkillNames,
    originalCharCount: fullContent.length,
    truncated,
  };
}
