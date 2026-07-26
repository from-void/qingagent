import { readdir, readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { SKILL_NAME_RE, stripSkillSourceBom } from "./frontmatter.js";

export interface ParsedSkillFrontmatter {
  name: string;
  description: string;
  label: string;
  summary: string;
  icon: string;
  userInvocable: boolean;
  userInvocableExplicit: boolean;
  placeholder?: string;
  config?: string;
  tools: string[];
}

export interface DiscoveredSkill {
  path: string;
  skillMdPath: string;
  metadata: ParsedSkillFrontmatter;
  /**
   * 最近的合法母技能目录。null 表示该技能在本次扫描根下属于顶层技能。
   */
  parentPath: string | null;
  mtimeMs: number;
}

type FrontmatterValue = string | boolean | string[];

/**
 * 技能 frontmatter 的唯一解析口径。顶层技能与子技能都必须至少提供合法 name 和 description。
 */
export function parseSkillFrontmatter(source: string): ParsedSkillFrontmatter | null {
  // 去掉 UTF-8 BOM（Windows 记事本/部分编辑器导出的 Markdown 可能携带 BOM）。
  const match = stripSkillSourceBom(source).match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return null;
  const data = parseFrontmatterBlock(match[1]!);
  const name = typeof data.name === "string" ? data.name.trim() : "";
  const description = typeof data.description === "string" ? data.description.trim() : "";
  if (!SKILL_NAME_RE.test(name) || !description) return null;
  const label = nonEmptyString(data.label) ?? fallbackLabel(name);
  const summary = nonEmptyString(data.summary) ?? fallbackSummary(description);
  const icon = nonEmptyString(data.icon) ?? "star";
  const placeholder = nonEmptyString(data.placeholder);
  const config = nonEmptyString(data.config);
  const tools = Array.isArray(data.tools) ? data.tools.filter(Boolean) : [];
  const userInvocable = parseBooleanValue(data["user-invocable"]);
  return {
    name,
    description,
    label,
    summary,
    icon,
    userInvocable: userInvocable === true,
    userInvocableExplicit: userInvocable !== undefined,
    ...(placeholder ? { placeholder } : {}),
    ...(config ? { config } : {}),
    tools,
  };
}

/**
 * 递归扫描技能根，并按“最近合法 SKILL.md 祖先”建立母子归属。
 *
 * references/、assets/ 等目录即使被遍历，也只有自身带合法 SKILL.md 时才会成为技能；
 * 非法 frontmatter 等同于没有 SKILL.md，不做文件名或目录名猜测兼容。
 */
export async function scanSkillHierarchy(root: string): Promise<DiscoveredSkill[]> {
  const absoluteRoot = resolve(root);
  const result: DiscoveredSkill[] = [];

  const visit = async (
    directory: string,
    nearestParentPath: string | null,
    isRoot: boolean,
  ): Promise<void> => {
    const skillMdPath = join(directory, "SKILL.md");
    const metadata = await readSkillMetadata(skillMdPath);
    let nextParentPath = nearestParentPath;
    if (metadata) {
      const info = await stat(skillMdPath).catch(() => null);
      result.push({
        path: directory,
        skillMdPath,
        metadata,
        parentPath: nearestParentPath,
        mtimeMs: info?.mtimeMs ?? 0,
      });
      nextParentPath = directory;
    }

    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (isRoot) throw error;
      return;
    }
    const childDirectories = entries
      .filter((entry) => entry.isDirectory())
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of childDirectories) {
      await visit(join(directory, entry.name), nextParentPath, false);
    }
  };

  await visit(absoluteRoot, null, true);
  return result;
}

/**
 * 返回扫描根下不会被任何母技能拥有的顶层技能。
 */
export async function listTopLevelSkills(root: string): Promise<DiscoveredSkill[]> {
  return (await scanSkillHierarchy(root)).filter((skill) => skill.parentPath === null);
}

/**
 * 返回某个母技能直接拥有的子技能。中间可跨越不含 SKILL.md 的纯资料目录；
 * 更深层技能归属最近的合法子技能，不会被重复算到母技能名下。
 */
export async function listChildSkills(skillDirectory: string): Promise<DiscoveredSkill[]> {
  const parentPath = resolve(skillDirectory);
  const hierarchy = await scanSkillHierarchy(parentPath);
  const parent = hierarchy.find((skill) => skill.path === parentPath);
  if (!parent) return [];
  return hierarchy.filter((skill) => skill.parentPath === parent.path);
}

async function readSkillMetadata(skillMdPath: string): Promise<ParsedSkillFrontmatter | null> {
  try {
    return parseSkillFrontmatter(await readFile(skillMdPath, "utf8"));
  } catch {
    return null;
  }
}

function parseFrontmatterBlock(block: string): Record<string, FrontmatterValue> {
  const data: Record<string, FrontmatterValue> = {};
  const lines = block.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const rawLine = lines[i]!;
    const keyMatch = rawLine.match(/^([A-Za-z0-9_-]+):(?:\s*(.*))?$/);
    if (!keyMatch) continue;
    const key = keyMatch[1]!;
    let rawValue = (keyMatch[2] ?? "").trim();
    if (rawValue === ">-" || rawValue === ">" || rawValue === "|") {
      const parts: string[] = [];
      while (i + 1 < lines.length && /^\s+/.test(lines[i + 1]!)) {
        i += 1;
        parts.push(lines[i]!.trim());
      }
      data[key] = rawValue === "|" ? parts.join("\n") : parts.join(" ");
      continue;
    }
    if (rawValue === "" && key === "tools") {
      const tools: string[] = [];
      while (i + 1 < lines.length) {
        const itemMatch = lines[i + 1]!.match(/^\s*-\s*(.+?)\s*$/);
        if (!itemMatch) break;
        i += 1;
        const tool = parseStringValue(itemMatch[1]!);
        if (tool) tools.push(tool);
      }
      data[key] = tools;
      continue;
    }
    data[key] = key === "tools" ? parseStringArray(rawValue) : parseScalar(rawValue);
  }
  return data;
}

function parseScalar(rawValue: string): string | boolean {
  const value = stripYamlComment(rawValue).trim();
  if (value === "true") return true;
  if (value === "false") return false;
  return stripQuotes(value);
}

function parseStringArray(rawValue: string): string[] {
  const value = stripYamlComment(rawValue).trim();
  if (!value) return [];
  if (!value.startsWith("[") || !value.endsWith("]")) {
    const single = parseStringValue(value);
    return single ? [single] : [];
  }
  return value
    .slice(1, -1)
    .split(",")
    .map((item) => parseStringValue(item))
    .filter((item) => item.length > 0);
}

function parseStringValue(rawValue: string): string {
  return stripQuotes(stripYamlComment(rawValue).trim()).trim();
}

function stripYamlComment(value: string): string {
  let quote: string | null = null;
  for (let i = 0; i < value.length; i += 1) {
    const ch = value[i]!;
    if ((ch === "'" || ch === '"') && value[i - 1] !== "\\") {
      quote = quote === ch ? null : quote ?? ch;
      continue;
    }
    if (ch === "#" && quote === null && (i === 0 || /\s/.test(value[i - 1]!))) {
      return value.slice(0, i);
    }
  }
  return value;
}

function stripQuotes(value: string): string {
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replace(/''/g, "'");
  }
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }
  return value;
}

function nonEmptyString(value: FrontmatterValue | undefined): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function parseBooleanValue(value: FrontmatterValue | undefined): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return undefined;
  const normalized = stripQuotes(value.trim()).trim().toLowerCase();
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  return undefined;
}

function fallbackLabel(name: string): string {
  return name;
}

function fallbackSummary(description: string): string {
  const first = description.match(/^[^，。：——\n]+/)?.[0]?.trim() || description.trim();
  return first.length > 14 ? first.slice(0, 14) : first;
}
