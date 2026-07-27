import { lstat, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { QaCliError } from "./errors.js";
import type { ExternalSkillFile } from "./generated/externalApi.js";

const SKILL_NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const MAX_FILES = 200;
const MAX_BYTES = 10 * 1024 * 1024;

export interface LocalSkillPackage {
  name: string;
  files: ExternalSkillFile[];
}

export async function validateSkillDirectory(
  directory: string,
): Promise<LocalSkillPackage> {
  const root = path.resolve(directory);
  const rootStat = await lstat(root).catch(() => null);
  if (!rootStat?.isDirectory()) {
    throw new QaCliError("VALIDATION", "技能路径必须是目录");
  }
  const files: ExternalSkillFile[] = [];
  await collectFiles(root, root, files);
  files.sort((left, right) => left.path.localeCompare(right.path));
  const rootSkill = files.find((file) => file.path === "SKILL.md");
  const rootMeta = rootSkill ? parseSkillIdentity(rootSkill.content) : null;
  if (!rootMeta) {
    throw new QaCliError("VALIDATION", "根目录必须包含合法的 SKILL.md");
  }
  for (const file of files) {
    if (file.path !== "SKILL.md" && file.path.endsWith("/SKILL.md")) {
      if (!parseSkillIdentity(file.content)) {
        throw new QaCliError("VALIDATION", `${file.path} frontmatter 不合法`);
      }
    }
  }
  return { name: rootMeta.name, files };
}

export async function validateSkillMarkdownFile(
  filePath: string,
): Promise<{ name: string; skillMd: string }> {
  const info = await lstat(filePath).catch(() => null);
  if (!info?.isFile()) throw new QaCliError("VALIDATION", "技能文件不存在");
  const skillMd = await readFile(filePath, "utf8");
  const metadata = parseSkillIdentity(skillMd);
  if (!metadata) throw new QaCliError("VALIDATION", "SKILL.md frontmatter 不合法");
  return { name: metadata.name, skillMd };
}

async function collectFiles(
  root: string,
  directory: string,
  output: ExternalSkillFile[],
): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const absolute = path.join(directory, entry.name);
    const relative = path.relative(root, absolute).split(path.sep).join("/");
    assertSafeRelativePath(relative);
    if (entry.isSymbolicLink()) {
      throw new QaCliError("VALIDATION", `技能目录不能包含符号链接: ${relative}`);
    }
    if (entry.isDirectory()) {
      await collectFiles(root, absolute, output);
      continue;
    }
    if (!entry.isFile()) {
      throw new QaCliError("VALIDATION", `技能目录包含不支持的文件类型: ${relative}`);
    }
    if (output.length >= MAX_FILES) {
      throw new QaCliError("VALIDATION", `技能文件不能超过 ${MAX_FILES} 个`);
    }
    const content = await readFile(absolute, "utf8");
    const bytes = output.reduce(
      (total, file) => total + Buffer.byteLength(file.content, "utf8"),
      Buffer.byteLength(content, "utf8"),
    );
    if (bytes > MAX_BYTES) throw new QaCliError("VALIDATION", "技能文件总大小不能超过 10MB");
    output.push({ path: relative, content });
  }
}

export function assertSafeRelativePath(value: string): void {
  const slashed = value.replace(/\\/g, "/");
  if (
    !slashed ||
    path.isAbsolute(value) ||
    /^[A-Za-z]:/.test(value) ||
    slashed.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new QaCliError("VALIDATION", `技能文件路径不合法: ${value}`);
  }
}

export function parseSkillIdentity(
  source: string,
): { name: string; description: string } | null {
  const match = source.replace(/^\uFEFF/, "").match(/^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/);
  if (!match) return null;
  let name = "";
  let description = "";
  const lines = match[1]!.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    const pair = line.match(/^([A-Za-z0-9_-]+):\s*(.*?)\s*$/);
    if (!pair) continue;
    const block = /^([>|])([+-])?(?:\s+#.*)?$/.exec(pair[2]!);
    let value: string;
    if (block) {
      const collected: string[] = [];
      while (index + 1 < lines.length) {
        const next = lines[index + 1]!;
        if (next.trim() && !/^[ \t]+/.test(next)) break;
        index += 1;
        collected.push(next.replace(/^[ \t]+/, ""));
      }
      value = block[1] === ">"
        ? collected.join(" ").replace(/\s+/g, " ").trim()
        : collected.join("\n").trim();
    } else {
      value = yamlScalar(pair[2]!);
    }
    if (pair[1] === "name") name = value;
    if (pair[1] === "description") description = value;
  }
  return SKILL_NAME_RE.test(name) && description.trim()
    ? { name, description: description.trim() }
    : null;
}

function yamlScalar(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1).replace(/''/g, "'");
  }
  if (trimmed.startsWith("\"") && trimmed.endsWith("\"")) {
    try {
      return JSON.parse(trimmed) as string;
    } catch {
      return "";
    }
  }
  return trimmed.replace(/\s+#.*$/, "").trim();
}
