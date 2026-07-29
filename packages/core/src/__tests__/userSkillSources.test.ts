import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
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
  it("默认扫描 Claude、Codex 与历史共享目录,安装目录仍是第一位", async () => {
    const root = await mkdtemp(join(tmpdir(), "qingagent-user-skill-sources-"));
    roots.push(root);
    process.env.HOME = root;
    delete process.env.QINGAGENT_USER_SKILLS_DIR;
    delete process.env.QINGAGENT_EXTRA_USER_SKILLS_DIRS;

    const { SKILLS_INSTALL_DIR, USER_SKILL_SOURCE_DIRS, USER_SKILLS_DIR } =
      await import("../skills/paths.js");

    expect(USER_SKILL_SOURCE_DIRS[0]).toBe(USER_SKILLS_DIR);
    expect(SKILLS_INSTALL_DIR).toBe(USER_SKILLS_DIR);
    expect(USER_SKILL_SOURCE_DIRS).toContain(join(root, ".claude", "skills"));
    expect(USER_SKILL_SOURCE_DIRS).toContain(join(root, ".codex", "skills"));
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

  it("安装目录与 Claude 目录同名时安装目录优先", async () => {
    const root = await mkdtemp(join(tmpdir(), "qingagent-user-skill-dedupe-"));
    roots.push(root);
    const installDir = join(root, ".qingagent", "skills");
    const claudeDir = join(root, ".claude", "skills");
    const winner = await writeSkill(installDir, "duplicated-skill");
    const loser = await writeSkill(claudeDir, "duplicated-skill");

    const dirs = await resolveEnabledSkillDirsFromRoots(
      [installDir, claudeDir],
      new Set<string>(),
      { externalRoots: [claudeDir] },
    );
    expect(dirs).toContain(winner.replace(/\\/g, "/"));
    expect(dirs).not.toContain(loser.replace(/\\/g, "/"));
    expect(dirs.filter((dir) => dir.endsWith("duplicated-skill"))).toHaveLength(1);
  });

  it("只存在于 Claude 目录的技能能被发现,不需要搬动任何文件", async () => {
    const root = await mkdtemp(join(tmpdir(), "qingagent-user-skill-discovery-"));
    roots.push(root);
    const installDir = join(root, ".qingagent", "skills");
    const claudeDir = join(root, ".claude", "skills");
    await writeSkill(installDir, "qingagent-native-skill");
    await writeSkill(claudeDir, "external-cli-guide");

    const dirs = await resolveEnabledSkillDirsFromRoots(
      [installDir, claudeDir],
      new Set<string>(),
      { externalRoots: [claudeDir] },
    );

    expect(dirs.some((dir) => dir.endsWith("qingagent-native-skill"))).toBe(true);
    expect(dirs.some((dir) => dir.endsWith("external-cli-guide"))).toBe(true);
  });

  it("31 个外部技能只保留最新 30 个并记录丢弃数量与名字", async () => {
    const root = await mkdtemp(join(tmpdir(), "example-external-skill-limit-"));
    roots.push(root);
    const installDir = join(root, ".qingagent", "skills");
    const claudeDir = join(root, ".claude", "skills");
    await mkdir(installDir, { recursive: true });
    for (let index = 0; index < 31; index += 1) {
      const name = `external-skill-${String(index).padStart(2, "0")}`;
      const dir = await writeSkill(claudeDir, name);
      const modifiedAt = new Date(1_700_000_000_000 + index * 1_000);
      await utimes(join(dir, "SKILL.md"), modifiedAt, modifiedAt);
    }
    const logger = { warn: vi.fn() };
    const { MAX_EXTERNAL_USER_SKILLS } = await import("../skills/paths.js");

    const dirs = await resolveEnabledSkillDirsFromRoots(
      [installDir, claudeDir],
      new Set<string>(),
      { externalRoots: [claudeDir], logger },
    );

    expect(MAX_EXTERNAL_USER_SKILLS).toBe(30);
    expect(dirs).toHaveLength(30);
    expect(dirs.some((dir) => dir.endsWith("external-skill-00"))).toBe(false);
    expect(dirs.some((dir) => dir.endsWith("external-skill-30"))).toBe(true);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.any(String),
      {
        droppedCount: 1,
        droppedNames: ["external-skill-00"],
      },
    );
  });
});
