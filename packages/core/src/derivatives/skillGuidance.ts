import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  DERIVATIVE_WRITING_SKILL,
  derivativeChildSkillFor,
} from "@qingagent/contract-ts";
import { BUILTIN_SKILLS_DIR, USER_SKILLS_DIR } from "../skills/paths.js";
import { readDisabledSet } from "../skills/enabledStore.js";
import { stripSkillSourceBom } from "../skills/frontmatter.js";
import { DTYPE_COMMON_CONSTRAINTS } from "./dtypeTemplatePrompts.js";

export type DerivativeGuidanceSource = "skill" | "fallback";

export interface DerivativeGuidance {
  /** 命中的子技能名;回退时为 null。 */
  skillName: string | null;
  source: DerivativeGuidanceSource;
  /** 注入给模型的纪律正文。永不为空:技能读不到时退回内置最小纪律。 */
  text: string;
}

const BUILTIN_SKILL_CATEGORIES = ["capability", "native", "style"] as const;

/** 母技能可能装在内置分类目录下,也可能被用户装在用户技能目录下,逐个试。 */
function childSkillCandidates(childSkillName: string): string[] {
  return [
    ...BUILTIN_SKILL_CATEGORIES.map((category) =>
      join(BUILTIN_SKILLS_DIR, category, DERIVATIVE_WRITING_SKILL, childSkillName, "SKILL.md")
    ),
    join(USER_SKILLS_DIR, DERIVATIVE_WRITING_SKILL, childSkillName, "SKILL.md"),
  ];
}

/** 去掉 YAML frontmatter,只留正文纪律——frontmatter 是发现层元数据,注入给模型是纯噪声。 */
export function skillBodyOf(source: string): string {
  const normalized = stripSkillSourceBom(source);
  const match = normalized.match(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/);
  return (match ? normalized.slice(match[0].length) : normalized).trim();
}

/** 内置最小纪律:母技能停用或技能文件缺失时的降级注入,等价于本次重构前的固定约束。 */
export function fallbackGuidanceFor(dtype: string): string {
  return DTYPE_COMMON_CONSTRAINTS[dtype as keyof typeof DTYPE_COMMON_CONSTRAINTS] ?? "";
}

/**
 * 按 dtype 取该类衍生稿的执行纪律。
 *
 * 降级语义(拍板):衍生稿入口与生成永远可用——母技能被停用时不阻断生成,
 * 只把纪律注入降级为内置最小纪律;随母技能停用的只有风格模板 CRUD 工具。
 */
export async function loadDerivativeGuidance(dtype: string): Promise<DerivativeGuidance> {
  const childSkillName = derivativeChildSkillFor(dtype);
  const fallback: DerivativeGuidance = {
    skillName: null,
    source: "fallback",
    text: fallbackGuidanceFor(dtype),
  };
  if (!childSkillName) return fallback;
  const disabled = await readDisabledSet().catch(() => new Set<string>());
  if (disabled.has(DERIVATIVE_WRITING_SKILL)) return fallback;
  for (const candidate of childSkillCandidates(childSkillName)) {
    let body: string;
    try {
      body = skillBodyOf(await readFile(candidate, "utf8"));
    } catch {
      continue;
    }
    if (!body) continue;
    return { skillName: childSkillName, source: "skill", text: body };
  }
  return fallback;
}
