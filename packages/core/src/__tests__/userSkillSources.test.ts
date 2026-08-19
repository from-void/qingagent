import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, delimiter, join } from "node:path";
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

    const {
      SKILL_DISCOVERY_SOURCE_ROOTS,
      SKILLS_INSTALL_DIR,
      USER_SKILL_SOURCE_DIRS,
      USER_SKILLS_DIR,
    } =
      await import("../skills/paths.js");

    expect(USER_SKILL_SOURCE_DIRS[0]).toBe(USER_SKILLS_DIR);
    expect(SKILLS_INSTALL_DIR).toBe(USER_SKILLS_DIR);
    expect(USER_SKILL_SOURCE_DIRS.slice(0, 4)).toEqual([
      USER_SKILLS_DIR,
      join(root, ".claude", "skills"),
      join(root, ".codex", "skills"),
      join(root, ".agents", "skills"),
    ]);
    expect(SKILL_DISCOVERY_SOURCE_ROOTS.map(({ source }) => source)).toEqual([
      "installed",
      "builtin",
      "builtin",
      "builtin",
      "external-claude",
      "external-codex",
      "external-shared",
    ]);
  });

  it("QINGAGENT_EXTRA_USER_SKILLS_DIRS 是追加而不是覆盖,内置来源不会被挤掉", async () => {
    const root = await mkdtemp(join(tmpdir(), "qingagent-user-skill-sources-env-"));
    roots.push(root);
    const extraA = join(root, "extra-a");
    const extraB = join(root, "extra-b");
    process.env.HOME = root;
    process.env.QINGAGENT_EXTRA_USER_SKILLS_DIRS = [extraA, extraB].join(delimiter);

    const { USER_SKILL_SOURCE_DIRS, USER_SKILLS_DIR } = await import("../skills/paths.js");
    expect(USER_SKILL_SOURCE_DIRS[0]).toBe(USER_SKILLS_DIR);
    expect(USER_SKILL_SOURCE_DIRS).toContain(extraA);
    expect(USER_SKILL_SOURCE_DIRS).toContain(extraB);
    // 内置来源必须仍在:覆盖语义会让存量用户的技能再次"查无此技能"。
    expect(USER_SKILL_SOURCE_DIRS).toContain(join(root, ".agents", "skills"));
    // 顺序即优先级:安装目录 > 内置额外来源 > env 追加。
    expect(USER_SKILL_SOURCE_DIRS.indexOf(join(root, ".agents", "skills")))
      .toBeLessThan(USER_SKILL_SOURCE_DIRS.indexOf(extraA));
  });

  it("五类来源按安装 > 内置 > Claude > Codex > Agents 排序并以先到来源去重", async () => {
    const root = await mkdtemp(join(tmpdir(), "qingagent-user-skill-dedupe-"));
    roots.push(root);
    const installDir = join(root, ".qingagent", "skills");
    const builtinDir = join(root, "builtin");
    const claudeDir = join(root, ".claude", "skills");
    const codexDir = join(root, ".codex", "skills");
    const agentsDir = join(root, ".agents", "skills");

    await Promise.all([
      writeSkill(installDir, "every-source"),
      writeSkill(installDir, "installed-only"),
      writeSkill(builtinDir, "every-source"),
      writeSkill(builtinDir, "builtin-wins"),
      writeSkill(builtinDir, "builtin-only"),
      writeSkill(claudeDir, "every-source"),
      writeSkill(claudeDir, "builtin-wins"),
      writeSkill(claudeDir, "claude-wins"),
      writeSkill(claudeDir, "claude-only"),
      writeSkill(codexDir, "every-source"),
      writeSkill(codexDir, "builtin-wins"),
      writeSkill(codexDir, "claude-wins"),
      writeSkill(codexDir, "codex-wins"),
      writeSkill(codexDir, "codex-only"),
      writeSkill(agentsDir, "every-source"),
      writeSkill(agentsDir, "builtin-wins"),
      writeSkill(agentsDir, "claude-wins"),
      writeSkill(agentsDir, "codex-wins"),
      writeSkill(agentsDir, "agents-only"),
    ]);

    const dirs = await resolveEnabledSkillDirsFromRoots(
      [installDir, builtinDir, claudeDir, codexDir, agentsDir],
      new Set<string>(),
      {
        externalRoots: [claudeDir, codexDir, agentsDir],
      },
    );

    expect(dirs).toEqual([
      join(installDir, "every-source"),
      join(installDir, "installed-only"),
      join(builtinDir, "builtin-only"),
      join(builtinDir, "builtin-wins"),
      join(claudeDir, "claude-only"),
      join(claudeDir, "claude-wins"),
      join(codexDir, "codex-only"),
      join(codexDir, "codex-wins"),
      join(agentsDir, "agents-only"),
    ].map((dir) => dir.replace(/\\/g, "/")));
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

  it("外部来源跳过隐藏目录与 Codex 系统 marker，且被跳过项不占 60 个上限", async () => {
    const root = await mkdtemp(join(tmpdir(), "qingagent-external-system-skills-"));
    roots.push(root);
    const installDir = join(root, ".qingagent", "skills");
    const codexDir = join(root, ".codex", "skills");
    await mkdir(installDir, { recursive: true });

    for (let index = 0; index < 60; index += 1) {
      await writeSkill(codexDir, `normal-external-${String(index).padStart(2, "0")}`);
    }
    const hiddenSystemDir = join(codexDir, ".system");
    await writeSkill(hiddenSystemDir, "imagegen");
    await writeFile(join(hiddenSystemDir, ".codex-system-skills.marker"), "", "utf8");
    await writeSkill(join(codexDir, ".private"), "review-agent");
    const visibleSystemLayer = join(codexDir, "system-managed");
    await writeSkill(visibleSystemLayer, "openai-docs");
    await writeFile(
      join(visibleSystemLayer, ".codex-system-skills.marker"),
      "",
      "utf8",
    );
    const logger = { warn: vi.fn() };

    const dirs = await resolveEnabledSkillDirsFromRoots(
      [installDir, codexDir],
      new Set<string>(),
      { externalRoots: [codexDir], logger },
    );

    expect(dirs).toHaveLength(60);
    expect(dirs.every((dir) => dir.includes("normal-external-"))).toBe(true);
    expect(dirs.some((dir) => dir.endsWith("imagegen"))).toBe(false);
    expect(dirs.some((dir) => dir.endsWith("review-agent"))).toBe(false);
    expect(dirs.some((dir) => dir.endsWith("openai-docs"))).toBe(false);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("外部技能按来源顺序保留前 60 个，安装与内置技能不受上限影响", async () => {
    const root = await mkdtemp(join(tmpdir(), "example-external-skill-limit-"));
    roots.push(root);
    const installDir = join(root, "installed");
    const builtinDir = join(root, "builtin");
    const claudeDir = join(root, ".claude", "skills");
    const codexDir = join(root, ".codex", "skills");
    const agentsDir = join(root, ".agents", "skills");
    for (let index = 0; index < 61; index += 1) {
      await writeSkill(installDir, `installed-${String(index).padStart(2, "0")}`);
      await writeSkill(builtinDir, `builtin-${String(index).padStart(2, "0")}`);
    }
    for (let index = 0; index < 30; index += 1) {
      await writeSkill(claudeDir, `claude-${String(index).padStart(2, "0")}`);
      await writeSkill(codexDir, `codex-${String(index).padStart(2, "0")}`);
    }
    for (let index = 0; index < 2; index += 1) {
      const dir = await writeSkill(agentsDir, `agents-${String(index).padStart(2, "0")}`);
      // 故意让低优先级 Agents 技能最新，锁住截断不再参考 mtime。
      const modifiedAt = new Date(1_900_000_000_000 + index * 1_000);
      await utimes(join(dir, "SKILL.md"), modifiedAt, modifiedAt);
    }
    const logger = { warn: vi.fn() };
    const { MAX_EXTERNAL_USER_SKILLS } = await import("../skills/paths.js");

    const dirs = await resolveEnabledSkillDirsFromRoots(
      [installDir, builtinDir, claudeDir, codexDir, agentsDir],
      new Set<string>(),
      { externalRoots: [claudeDir, codexDir, agentsDir], logger },
    );

    expect(MAX_EXTERNAL_USER_SKILLS).toBe(60);
    expect(dirs).toHaveLength(61 + 61 + 60);
    expect(dirs.filter((dir) => basename(dir).startsWith("installed-"))).toHaveLength(61);
    expect(dirs.filter((dir) => basename(dir).startsWith("builtin-"))).toHaveLength(61);
    expect(dirs.filter((dir) => dir.startsWith(claudeDir))).toHaveLength(30);
    expect(dirs.filter((dir) => dir.startsWith(codexDir))).toHaveLength(30);
    expect(dirs.some((dir) => dir.startsWith(agentsDir))).toBe(false);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.any(String),
      {
        droppedCount: 2,
        droppedNames: ["agents-00", "agents-01"],
      },
    );
  });
});
