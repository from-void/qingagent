import type { WorkspaceSkills } from "@mastra/core/workspace";
import { readFile } from "node:fs/promises";
import { basename, isAbsolute, join, resolve } from "node:path";
import type {
  SkillChipInstructionLoader,
  SkillChipInstructionLoadResult,
} from "./chipOnlyNote.js";
import { BUILTIN_SKILLS_DIR, USER_SKILLS_DIR } from "../skills/paths.js";
import { readDisabledSet } from "../skills/enabledStore.js";

function unique(values: string[]): string[] {
  return Array.from(new Set(values));
}

function skillFileCandidates(skillPath: string): string[] {
  if (isAbsolute(skillPath)) {
    return unique([
      join(skillPath, "SKILL.md"),
      join(resolve(skillPath, "..", basename(skillPath)), "SKILL.md"),
    ]);
  }
  return unique([
    resolve(BUILTIN_SKILLS_DIR, skillPath, "SKILL.md"),
    resolve(USER_SKILLS_DIR, skillPath, "SKILL.md"),
    resolve(BUILTIN_SKILLS_DIR, "capability", skillPath, "SKILL.md"),
    resolve(BUILTIN_SKILLS_DIR, "native", skillPath, "SKILL.md"),
    resolve(BUILTIN_SKILLS_DIR, "style", skillPath, "SKILL.md"),
  ]);
}

async function readFirstExistingSkillFile(skillPath: string): Promise<{ source: string; content: string } | null> {
  let lastError: unknown = null;
  for (const source of skillFileCandidates(skillPath)) {
    try {
      return { source, content: await readFile(source, "utf8") };
    } catch (error) {
      lastError = error;
    }
  }
  if (lastError) {
    throw lastError;
  }
  return null;
}

export function createSkillChipInstructionLoader(
  skills: WorkspaceSkills | null | undefined,
): SkillChipInstructionLoader {
  return async ({ id }): Promise<SkillChipInstructionLoadResult> => {
    const disabled = await readDisabledSet();
    if (disabled.has(id)) {
      return { ok: false, id, reason: "disabled" };
    }
    if (!skills) {
      return {
        ok: false,
        id,
        reason: "read-failed",
        message: "技能系统不可用。",
      };
    }

    let skill: Awaited<ReturnType<WorkspaceSkills["get"]>>;
    try {
      skill = await skills.get(id);
    } catch (error) {
      return {
        ok: false,
        id,
        reason: "read-failed",
        error: error instanceof Error ? error.message : String(error),
      };
    }
    if (!skill) {
      return { ok: false, id, reason: "not-found" };
    }

    try {
      const raw = await readFirstExistingSkillFile(skill.path);
      if (!raw) {
        return {
          ok: false,
          id,
          reason: "read-failed",
          message: `无法定位 ${skill.path}/SKILL.md。`,
        };
      }
      return {
        ok: true,
        id,
        source: raw.source,
        content: raw.content,
      };
    } catch (error) {
      return {
        ok: false,
        id,
        reason: "read-failed",
        error: error instanceof Error ? error.message : String(error),
      };
    }
  };
}
