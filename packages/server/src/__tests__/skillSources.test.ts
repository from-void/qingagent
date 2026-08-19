import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

const fixture = vi.hoisted(() => {
  const home = `/tmp/example-skill-source-home-${process.pid}`;
  process.env.HOME = home;
  process.env.QINGAGENT_USER_SKILLS_DIR = `${home}/.qingagent/skills`;
  process.env.QINGAGENT_SKILLS_DIR = `${home}/builtin`;
  delete process.env.QINGAGENT_EXTRA_USER_SKILLS_DIRS;
  return {
    home,
    installDir: `${home}/.qingagent/skills`,
    builtinDir: `${home}/builtin/capability`,
    claudeDir: `${home}/.claude/skills`,
  };
});

import { listAllSkillItems, serializeSkillListItem } from "../routes/skills";

async function writeSkill(root: string, directory: string, name: string): Promise<void> {
  const path = join(root, directory);
  await mkdir(path, { recursive: true });
  await writeFile(
    join(path, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${name} for API tests\n---\n`,
    "utf8",
  );
}

beforeAll(async () => {
  await rm(fixture.home, { recursive: true, force: true });
  await Promise.all([
    writeSkill(fixture.installDir, "preferred", "duplicate-source-skill"),
    writeSkill(fixture.builtinDir, "builtin-ignored", "duplicate-source-skill"),
    writeSkill(fixture.claudeDir, "ignored", "duplicate-source-skill"),
    writeSkill(fixture.builtinDir, "builtin-preferred", "builtin-wins-skill"),
    writeSkill(fixture.claudeDir, "builtin-ignored", "builtin-wins-skill"),
    writeSkill(fixture.claudeDir, "claude-only", "claude-only-skill"),
  ]);
});

afterAll(async () => {
  await rm(fixture.home, { recursive: true, force: true });
  delete process.env.QINGAGENT_USER_SKILLS_DIR;
  delete process.env.QINGAGENT_SKILLS_DIR;
});

describe("技能列表来源标注", () => {
  it("安装目录覆盖 Claude 同名技能，Claude 独有技能标为外部来源且默认启用", async () => {
    const skills = await listAllSkillItems(new Set());
    const duplicate = skills.filter((skill) => skill.name === "duplicate-source-skill");
    const builtinWinner = skills.filter((skill) => skill.name === "builtin-wins-skill");
    const claudeOnly = skills.find((skill) => skill.name === "claude-only-skill");

    expect(duplicate).toHaveLength(1);
    expect(duplicate[0]?.source).toBe("installed");
    expect(builtinWinner).toHaveLength(1);
    expect(builtinWinner[0]?.source).toBe("builtin");
    expect(skills.map((skill) => skill.source)).toEqual([
      "installed",
      "builtin",
      "external-claude",
    ]);
    expect(claudeOnly).toMatchObject({
      source: "external-claude",
      enabled: true,
      userInvocable: true,
    });
    await expect(serializeSkillListItem(claudeOnly!)).resolves.toMatchObject({
      name: "claude-only-skill",
      source: "external-claude",
      enabled: true,
    });
  });
});
