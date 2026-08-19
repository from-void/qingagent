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

export const BUILTIN_SKILL_CATEGORIES = ["capability", "native", "style"] as const;

/**
 * 第三方技能安装器普遍会同时覆盖 Claude 与 Codex 的技能目录；
 * `~/.agents/skills` 作为共享来源。这里采用**只增不搬**:
 * 扫描外部目录但不迁移文件,也不改变默认安装位置(仍是 SKILLS_INSTALL_DIR)。
 * 可用 QINGAGENT_EXTRA_USER_SKILLS_DIRS(路径分隔符分隔)追加更多外部来源。
 */
export const DEFAULT_EXTRA_USER_SKILL_SOURCES = [
  resolve(homedir(), ".claude", "skills"),
  resolve(homedir(), ".codex", "skills"),
  resolve(homedir(), ".agents", "skills"),
];

/** 外部目录最多注入的顶层技能数，避免第三方目录无限膨胀提示词。 */
export const MAX_EXTERNAL_USER_SKILLS = 60;

export type UserSkillSource =
  | "installed"
  | "external-claude"
  | "external-codex"
  | "external-shared";

/**
 * env 是**追加**而不是覆盖:这条清单的语义就是"只增不搬"。若写成覆盖,任何一处
 * 设了环境变量都会静默丢掉内置来源,
 * 把"装过的技能突然查无此技能"这个病重新犯一遍。
 */
function parseExtraUserSkillSources(): string[] {
  const fromEnv = (process.env.QINGAGENT_EXTRA_USER_SKILLS_DIRS ?? "")
    .split(delimiter)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map(absolutize);
  return [...DEFAULT_EXTRA_USER_SKILL_SOURCES, ...fromEnv];
}

/**
 * 用户技能的全部来源目录,首位恒为安装目录 USER_SKILLS_DIR。发现、沙箱权限面、
 * 可信脚本判定都必须走这一份清单,避免各处各记一半；权限消费必须保持
 * “首位安装目录可写、其余来源只读”。
 *
 * 顺序即优先级:同名技能以**靠前的来源为准**
 * (现装目录 > Claude/Codex/Agents 等外部来源),
 * 由 resolveEnabledSkillDirsFromRoots 按名去重落实,避免多来源同名时行为不确定。
 */
export const USER_SKILL_SOURCE_DIRS: readonly string[] = [
  ...new Set([
    USER_SKILLS_DIR,
    ...parseExtraUserSkillSources(),
  ]),
];

export type SkillDiscoverySource = "builtin" | UserSkillSource;

export interface SkillDiscoverySourceRoot {
  path: string;
  source: SkillDiscoverySource;
  external: boolean;
}

/**
 * 产品技能发现的唯一来源顺序。安装目录优先于内置技能；外部来源保持
 * Claude > Codex > Agents > 环境追加目录，供 Agent 注入与管理列表共同消费。
 */
export const SKILL_DISCOVERY_SOURCE_ROOTS: readonly SkillDiscoverySourceRoot[] = [
  { path: USER_SKILLS_DIR, source: "installed", external: false },
  ...BUILTIN_SKILL_CATEGORIES.map((category) => ({
    path: resolve(BUILTIN_SKILLS_DIR, category),
    source: "builtin" as const,
    external: false,
  })),
  ...USER_SKILL_SOURCE_DIRS.slice(1).map((path) => ({
    path,
    source: classifyUserSkillSource(path),
    external: true,
  })),
];

export function classifyUserSkillSource(sourceDir: string): UserSkillSource {
  const normalized = resolve(sourceDir);
  if (normalized === resolve(USER_SKILLS_DIR)) return "installed";
  if (normalized === resolve(homedir(), ".claude", "skills")) return "external-claude";
  if (normalized === resolve(homedir(), ".codex", "skills")) return "external-codex";
  return "external-shared";
}
