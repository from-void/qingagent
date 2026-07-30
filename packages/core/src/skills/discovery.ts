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
  /**
   * 技能声明「需要和终端共享哪个凭证目录」。这里只做原样保留(仍是 ~/ 写法),
   * 合法性由 credentialPaths.ts 统一裁定——解析层不做安全判断,避免两套口径。
   */
  credentialPaths: string[];
}

/** frontmatter 里按 YAML 列表书写的字段(值可以是行内 [a, b] 或多行 - a)。 */
const LIST_FRONTMATTER_KEYS = new Set(["tools", "credential-paths"]);

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

export interface SkillDiscoveryRoot {
  path: string;
  external?: boolean;
}

export interface ResolvedSkillSource {
  skill: DiscoveredSkill;
  root: SkillDiscoveryRoot;
  rootIndex: number;
}

export interface SkillDiscoveryLogger {
  warn(message: string, context: { droppedCount: number; droppedNames: string[] }): void;
}

export interface ResolveSkillSourcesOptions {
  maxExternalSkills?: number;
  logger?: SkillDiscoveryLogger;
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
  const rawCredentialPaths = data["credential-paths"];
  const credentialPaths = Array.isArray(rawCredentialPaths)
    ? rawCredentialPaths.filter(Boolean)
    : [];
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
    credentialPaths,
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

/**
 * 按根目录顺序发现并去重顶层技能；外部来源在去重后按 SKILL.md mtime 取最新若干条。
 * 返回顺序仍保持来源优先级，mtime 只参与超限取舍，避免改变正常加载顺序。
 */
export async function resolveSkillSourcesFromRoots(
  roots: readonly SkillDiscoveryRoot[],
  options: ResolveSkillSourcesOptions = {},
): Promise<ResolvedSkillSource[]> {
  const groups = await Promise.all(
    roots.map(async (root, rootIndex) => {
      try {
        return (await listTopLevelSkills(root.path)).map((skill) => ({
          skill,
          root,
          rootIndex,
        }));
      } catch {
        return [];
      }
    }),
  );
  const seen = new Set<string>();
  const unique: ResolvedSkillSource[] = [];
  for (const entry of groups.flat()) {
    if (seen.has(entry.skill.metadata.name)) continue;
    seen.add(entry.skill.metadata.name);
    unique.push(entry);
  }

  const maxExternalSkills = options.maxExternalSkills;
  if (maxExternalSkills === undefined) return unique;
  const external = unique.filter((entry) => entry.root.external);
  if (external.length <= maxExternalSkills) return unique;

  const newest = [...external].sort((left, right) => {
    if (left.skill.mtimeMs !== right.skill.mtimeMs) {
      return right.skill.mtimeMs - left.skill.mtimeMs;
    }
    if (left.rootIndex !== right.rootIndex) return left.rootIndex - right.rootIndex;
    return left.skill.metadata.name.localeCompare(right.skill.metadata.name);
  });
  const keptPaths = new Set(
    newest.slice(0, maxExternalSkills).map((entry) => entry.skill.path),
  );
  const dropped = newest.slice(maxExternalSkills);
  (options.logger ?? console).warn("[skills] 外部技能数量超过上限，已按更新时间截断", {
    droppedCount: dropped.length,
    droppedNames: dropped.map((entry) => entry.skill.metadata.name),
  });
  return unique.filter((entry) => !entry.root.external || keptPaths.has(entry.skill.path));
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
    const blockScalar = rawValue.match(/^([>|])([+-])?$/);
    if (blockScalar) {
      const parsed = readFrontmatterBlockScalar(lines, i, blockScalar[1] === ">");
      i = parsed.endIndex;
      data[key] = applyBlockScalarChomping(parsed.value, blockScalar[2]);
      continue;
    }
    if (rawValue === "" && LIST_FRONTMATTER_KEYS.has(key)) {
      const items: string[] = [];
      while (i + 1 < lines.length) {
        const itemMatch = lines[i + 1]!.match(/^\s*-\s*(.+?)\s*$/);
        if (!itemMatch) break;
        i += 1;
        const item = parseStringValue(itemMatch[1]!);
        if (item) items.push(item);
      }
      data[key] = items;
      continue;
    }
    data[key] = LIST_FRONTMATTER_KEYS.has(key) ? parseStringArray(rawValue) : parseScalar(rawValue);
  }
  return data;
}

function readFrontmatterBlockScalar(
  lines: string[],
  markerIndex: number,
  folded: boolean,
): { value: string; endIndex: number } {
  let indentation: number | null = null;
  let endIndex = markerIndex;
  const parts: string[] = [];
  for (let index = markerIndex + 1; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (line.trim() === "") {
      parts.push("");
      endIndex = index;
      continue;
    }
    const leading = line.match(/^\s*/)?.[0].length ?? 0;
    if (indentation === null) {
      if (leading === 0) break;
      indentation = leading;
    }
    if (leading < indentation) break;
    parts.push(line.slice(indentation));
    endIndex = index;
  }
  const literal = parts.join("\n");
  if (!folded) return { value: literal, endIndex };
  return {
    value: parts.reduce((value, part, index) => {
      if (index === 0) return part;
      const previous = parts[index - 1]!;
      const preservesLineBreak = previous === ""
        || part === ""
        || /^\s/.test(previous)
        || /^\s/.test(part);
      return `${value}${preservesLineBreak ? "\n" : " "}${part}`;
    }, ""),
    endIndex,
  };
}

function applyBlockScalarChomping(
  value: string,
  chomping: string | undefined,
): string {
  if (chomping === "-") return value.replace(/\n+$/, "");
  if (chomping === "+") return `${value}\n`;
  return `${value.replace(/\n+$/, "")}\n`;
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
  const firstSegment = description.match(/^[^，。：——\n]+/)?.[0]?.trim() || description.trim();
  const first = firstSegment.match(/^.*?(?=\.(?:\s|$)|$)/)?.[0]?.trim() || firstSegment;
  if (first.length <= 40) return first;
  const candidate = first.slice(0, 40);
  const lastSpace = candidate.lastIndexOf(" ");
  const truncated = lastSpace > 0 ? candidate.slice(0, lastSpace) : candidate;
  return `${truncated.trimEnd()}…`;
}
