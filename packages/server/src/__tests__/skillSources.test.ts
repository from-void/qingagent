import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

const fixture = vi.hoisted(() => {
  const home = `/tmp/example-skill-source-home-${process.pid}`;
  process.env.HOME = home;
  process.env.QINGAGENT_USER_SKILLS_DIR = `${home}/.qingagent/skills`;
  delete process.env.QINGAGENT_EXTRA_USER_SKILLS_DIRS;
  return {
    home,
    installDir: `${home}/.qingagent/skills`,
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
    writeSkill(fixture.claudeDir, "ignored", "duplicate-source-skill"),
    writeSkill(fixture.claudeDir, "claude-only", "claude-only-skill"),
  ]);
});

afterAll(async () => {
  await rm(fixture.home, { recursive: true, force: true });
  delete process.env.QINGAGENT_USER_SKILLS_DIR;
});

describe("技能列表来源标注", () => {
  it("安装目录覆盖 Claude 同名技能，Claude 独有技能标为外部来源且默认启用", async () => {
    const skills = await listAllSkillItems(new Set());
    const duplicate = skills.filter((skill) => skill.name === "duplicate-source-skill");
    const claudeOnly = skills.find((skill) => skill.name === "claude-only-skill");

    expect(duplicate).toHaveLength(1);
    expect(duplicate[0]?.source).toBe("installed");
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
