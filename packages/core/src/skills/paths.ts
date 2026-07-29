import { homedir } from "node:os";
import { delimiter, dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const CORE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

function absolutize(rawPath: string): string {
  return isAbsolute(rawPath) ? rawPath : resolve(process.cwd(), rawPath);
}

export const BUILTIN_SKILLS_DIR = process.env.QINGAGENT_SKILLS_DIR
  ? absolutize(process.env.QINGAGENT_SKILLS_DIR)
  : resolve(CORE_ROOT, "skills");

export const USER_SKILLS_DIR = process.env.QINGAGENT_USER_SKILLS_DIR
  ? absolutize(process.env.QINGAGENT_USER_SKILLS_DIR)
  : resolve(homedir(), ".qingagent", "skills");

export const SKILLS_INSTALL_DIR = USER_SKILLS_DIR;

/**
 * 第三方 agent 工具链的共用技能目录。像 `anttoolcenter skill add` 这类 CLI 固定
 * 装到 `~/.agents/skills`,用户装完后在青简里却"查无此技能"——因为我们只扫自己的
 * 目录。这里把它作为**只增不搬**的额外来源:两处都扫,不迁移任何文件,
 * 也不改变默认安装位置(仍是 SKILLS_INSTALL_DIR)。
 * 可用 QINGAGENT_EXTRA_USER_SKILLS_DIRS(路径分隔符分隔)追加更多来源。
 */
const DEFAULT_EXTRA_USER_SKILL_SOURCES = [resolve(homedir(), ".agents", "skills")];

function parseExtraUserSkillSources(): string[] {
  const raw = process.env.QINGAGENT_EXTRA_USER_SKILLS_DIRS;
  if (!raw) return DEFAULT_EXTRA_USER_SKILL_SOURCES;
  return raw
    .split(delimiter)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map(absolutize);
}

/**
 * 用户技能的全部来源目录,首位恒为安装目录 USER_SKILLS_DIR。发现、沙箱可写面、
 * 可信脚本判定都必须走这一份清单,避免各处各记一半。
 */
export const USER_SKILL_SOURCE_DIRS: readonly string[] = [
  ...new Set([USER_SKILLS_DIR, ...parseExtraUserSkillSources()]),
];
