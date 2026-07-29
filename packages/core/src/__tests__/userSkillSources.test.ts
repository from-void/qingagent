import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveEnabledSkillDirsFromRoots } from "../agents/qingagent.js";

const roots: string[] = [];
const savedEnv = {
  userSkills: process.env.QINGAGENT_USER_SKILLS_DIR,
  extraUserSkills: process.env.QINGAGENT_EXTRA_USER_SKILLS_DIRS,
  home: process.env.HOME,
};

async function writeSkill(root: string, name: string): Promise<string> {
  const dir = join(root, name);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${name} for tests\n---\n\n正文\n`,
    "utf8",
  );
  return dir;
}

beforeEach(() => {
  vi.resetModules();
});

afterEach(async () => {
  vi.resetModules();
  process.env.QINGAGENT_USER_SKILLS_DIR = savedEnv.userSkills;
  process.env.QINGAGENT_EXTRA_USER_SKILLS_DIRS = savedEnv.extraUserSkills;
  process.env.HOME = savedEnv.home;
  if (savedEnv.userSkills === undefined) delete process.env.QINGAGENT_USER_SKILLS_DIR;
  if (savedEnv.extraUserSkills === undefined) delete process.env.QINGAGENT_EXTRA_USER_SKILLS_DIRS;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("用户技能的多来源目录", () => {
  it("默认把 ~/.agents/skills 也算作来源,安装目录仍是第一位", async () => {
    const root = await mkdtemp(join(tmpdir(), "qingagent-user-skill-sources-"));
    roots.push(root);
    process.env.HOME = root;
    delete process.env.QINGAGENT_USER_SKILLS_DIR;
    delete process.env.QINGAGENT_EXTRA_USER_SKILLS_DIRS;

    const { SKILLS_INSTALL_DIR, USER_SKILL_SOURCE_DIRS, USER_SKILLS_DIR } =
      await import("../skills/paths.js");

    expect(USER_SKILL_SOURCE_DIRS[0]).toBe(USER_SKILLS_DIR);
    expect(SKILLS_INSTALL_DIR).toBe(USER_SKILLS_DIR);
    expect(USER_SKILL_SOURCE_DIRS).toContain(join(root, ".agents", "skills"));
  });

  it("QINGAGENT_EXTRA_USER_SKILLS_DIRS 可覆盖额外来源清单", async () => {
    const root = await mkdtemp(join(tmpdir(), "qingagent-user-skill-sources-env-"));
    roots.push(root);
    const extraA = join(root, "extra-a");
    const extraB = join(root, "extra-b");
    process.env.HOME = root;
    process.env.QINGAGENT_EXTRA_USER_SKILLS_DIRS = [extraA, extraB].join(delimiter);

    const { USER_SKILL_SOURCE_DIRS } = await import("../skills/paths.js");
    expect(USER_SKILL_SOURCE_DIRS).toContain(extraA);
    expect(USER_SKILL_SOURCE_DIRS).toContain(extraB);
    // 显式配置时不再自动追加 ~/.agents/skills。
    expect(USER_SKILL_SOURCE_DIRS).not.toContain(join(root, ".agents", "skills"));
  });

  it("两个来源目录里的技能都能被发现,不需要搬动任何文件", async () => {
    const root = await mkdtemp(join(tmpdir(), "qingagent-user-skill-discovery-"));
    roots.push(root);
    const installDir = join(root, ".qingagent", "skills");
    const agentsDir = join(root, ".agents", "skills");
    await writeSkill(installDir, "qingagent-native-skill");
    await writeSkill(agentsDir, "yuque-cli-guide");

    const dirs = await resolveEnabledSkillDirsFromRoots(
      [installDir, agentsDir],
      new Set<string>(),
    );

    expect(dirs.some((dir) => dir.endsWith("qingagent-native-skill"))).toBe(true);
    expect(dirs.some((dir) => dir.endsWith("yuque-cli-guide"))).toBe(true);
  });
});
