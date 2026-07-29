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

  it("QINGAGENT_EXTRA_USER_SKILLS_DIRS 是追加而不是覆盖,内置来源不会被挤掉", async () => {
    const root = await mkdtemp(join(tmpdir(), "qingagent-user-skill-sources-env-"));
    roots.push(root);
    // 模拟打包版把历史 userData 目录追加进来的场景。
    const legacyUserData = join(root, "Library", "@qingagent", "desktop", "skills");
    const extraB = join(root, "extra-b");
    process.env.HOME = root;
    process.env.QINGAGENT_EXTRA_USER_SKILLS_DIRS = [legacyUserData, extraB].join(delimiter);

    const { USER_SKILL_SOURCE_DIRS, USER_SKILLS_DIR } = await import("../skills/paths.js");
    expect(USER_SKILL_SOURCE_DIRS[0]).toBe(USER_SKILLS_DIR);
    expect(USER_SKILL_SOURCE_DIRS).toContain(legacyUserData);
    expect(USER_SKILL_SOURCE_DIRS).toContain(extraB);
    // 内置来源必须仍在:覆盖语义会让存量用户的技能再次"查无此技能"。
    expect(USER_SKILL_SOURCE_DIRS).toContain(join(root, ".agents", "skills"));
    // 顺序即优先级:安装目录 > 内置额外来源 > env 追加。
    expect(USER_SKILL_SOURCE_DIRS.indexOf(join(root, ".agents", "skills")))
      .toBeLessThan(USER_SKILL_SOURCE_DIRS.indexOf(legacyUserData));
  });

  it("历史 userData 技能目录仍能被发现(打包版存量用户不掉技能)", async () => {
    const root = await mkdtemp(join(tmpdir(), "qingagent-user-skill-legacy-"));
    roots.push(root);
    const legacyUserData = join(root, "Library", "@qingagent", "desktop", "skills");
    await writeSkill(legacyUserData, "legacy-packaged-skill");
    const installDir = join(root, ".qingagent", "skills");
    await mkdir(installDir, { recursive: true });

    const dirs = await resolveEnabledSkillDirsFromRoots(
      [installDir, legacyUserData],
      new Set<string>(),
    );
    expect(dirs.some((dir) => dir.endsWith("legacy-packaged-skill"))).toBe(true);
  });

  it("多来源同名技能按来源顺序取先出现的那个", async () => {
    const root = await mkdtemp(join(tmpdir(), "qingagent-user-skill-dedupe-"));
    roots.push(root);
    const installDir = join(root, ".qingagent", "skills");
    const agentsDir = join(root, ".agents", "skills");
    const winner = await writeSkill(installDir, "duplicated-skill");
    const loser = await writeSkill(agentsDir, "duplicated-skill");

    const dirs = await resolveEnabledSkillDirsFromRoots(
      [installDir, agentsDir],
      new Set<string>(),
    );
    expect(dirs).toContain(winner.replace(/\\/g, "/"));
    expect(dirs).not.toContain(loser.replace(/\\/g, "/"));
    expect(dirs.filter((dir) => dir.endsWith("duplicated-skill"))).toHaveLength(1);
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
