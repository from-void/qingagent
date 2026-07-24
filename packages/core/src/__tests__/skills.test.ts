import { describe, expect, it } from "vitest";
import { LocalFilesystem, Workspace } from "@mastra/core/workspace";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { resolveEnabledSkillDirsFromRoots } from "../agents/qingagent.js";
import { BUILTIN_SKILLS_DIR, USER_SKILLS_DIR } from "../skills/paths.js";
import { ARCHIVED_BUILTIN_SKILLS } from "../skills/archived.js";

function parseFrontmatter(source: string): Record<string, unknown> {
  const match = source.match(/^---\n([\s\S]*?)\n---/);
  if (!match) throw new Error("Missing frontmatter");
  const data: Record<string, unknown> = {};
  const lines = match[1]!.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    const keyMatch = line.match(/^([A-Za-z0-9_-]+):(?:\s*(.*))?$/);
    if (!keyMatch) continue;
    const key = keyMatch[1]!;
    let value = keyMatch[2] ?? "";
    if (value === ">-" || value === "|") {
      const parts: string[] = [];
      while (i + 1 < lines.length && /^\s+/.test(lines[i + 1]!)) {
        i += 1;
        parts.push(lines[i]!.trim());
      }
      value = parts.join(" ");
    }
    data[key] = value;
  }
  return data;
}

describe("builtin skills", () => {
  it("发现 diagram-viz 内置技能，并在显式停用后从 Workspace 目录移除", async () => {
    const categoryRoots = [
      join(BUILTIN_SKILLS_DIR, "capability"),
      join(BUILTIN_SKILLS_DIR, "native"),
      join(BUILTIN_SKILLS_DIR, "style"),
    ];
    const enabledDirs = await resolveEnabledSkillDirsFromRoots(categoryRoots, new Set());
    const diagramDir = enabledDirs.find((dir) => basename(dir) === "diagram-viz");
    expect(diagramDir).toBeTruthy();

    const skillPath = join(diagramDir!, "SKILL.md");
    const frontmatter = parseFrontmatter(await readFile(skillPath, "utf8"));
    expect(frontmatter).toMatchObject({
      name: "diagram-viz",
      label: "图表可视化",
      "user-invocable": "true",
      "write-inject": "true",
    });

    const workspace = new Workspace({
      filesystem: new LocalFilesystem({
        basePath: BUILTIN_SKILLS_DIR,
        allowedPaths: [USER_SKILLS_DIR],
      }),
      skills: enabledDirs,
    });
    const skillsApi = workspace.skills;
    if (!skillsApi) throw new Error("Workspace skills are not configured");
    expect(await skillsApi.has("diagram-viz")).toBe(true);

    const disabledDirs = await resolveEnabledSkillDirsFromRoots(
      categoryRoots,
      new Set(["diagram-viz"]),
    );
    expect(disabledDirs.some((dir) => basename(dir) === "diagram-viz")).toBe(false);
  });

  it("loads browser-ops from the capability category with valid frontmatter", async () => {
    const workspace = new Workspace({
      filesystem: new LocalFilesystem({
        basePath: BUILTIN_SKILLS_DIR,
        allowedPaths: [USER_SKILLS_DIR],
      }),
      skills: ["capability"],
    });

    const skillsApi = workspace.skills;
    if (!skillsApi) throw new Error("Workspace skills are not configured");
    const skills = await skillsApi.list();
    const browserOps = skills.find((skill) => skill.name === "browser-ops");
    expect(browserOps).toBeTruthy();
    expect(browserOps?.description).toEqual(expect.any(String));
    expect(browserOps?.description.length).toBeGreaterThan(0);

    const skillPath = resolve(BUILTIN_SKILLS_DIR, "capability", "browser-ops", "SKILL.md");
    const frontmatter = parseFrontmatter(await readFile(skillPath, "utf8"));
    expect(frontmatter.name).toBe(basename(dirname(skillPath)));
    expect(frontmatter.description).toEqual(expect.any(String));
    expect((frontmatter.description as string).length).toBeGreaterThan(0);
  });

  it("归档清单为空时仍正常发现内置技能", async () => {
    const skillDirs = await resolveEnabledSkillDirsFromRoots(
      [
        join(BUILTIN_SKILLS_DIR, "capability"),
        join(BUILTIN_SKILLS_DIR, "native"),
        join(BUILTIN_SKILLS_DIR, "style"),
      ],
      new Set(),
    );

    expect(ARCHIVED_BUILTIN_SKILLS.size).toBe(0);
    expect(skillDirs.some((dir) => basename(dir) === "browser-ops")).toBe(true);

    const workspace = new Workspace({
      filesystem: new LocalFilesystem({
        basePath: BUILTIN_SKILLS_DIR,
        allowedPaths: [USER_SKILLS_DIR],
      }),
      skills: skillDirs,
    });
    const skillsApi = workspace.skills;
    if (!skillsApi) throw new Error("Workspace skills are not configured");

    expect(await skillsApi.has("browser-ops")).toBe(true);
  });

  it("keeps skills from healthy roots when another root cannot be scanned", async () => {
    const root = await mkdtemp(join(tmpdir(), "qingagent-skills-"));
    try {
      const healthyRoot = join(root, "healthy");
      const skillDir = join(healthyRoot, "healthy-skill");
      const brokenRoot = join(root, "broken-root-is-file");
      await mkdir(skillDir, { recursive: true });
      await writeFile(
        join(skillDir, "SKILL.md"),
        "---\nname: healthy-skill\ndescription: 测试技能\n---\n",
        "utf8",
      );
      await writeFile(brokenRoot, "not a directory", "utf8");

      const skillDirs = await resolveEnabledSkillDirsFromRoots([brokenRoot, healthyRoot], new Set());

      expect(skillDirs.map((dir) => basename(dir))).toEqual(["healthy-skill"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  // 密闭回归(单②):此前本套件曾"单跑绿、全量红"——旧版第二个用例调 arg-less
  // resolveEnabledSkillDirs(),它读本机 ~/.qingagent/skills 的 .disabled.json;当本机或
  // 兄弟测试留下禁用 browser-ops 的 .disabled.json 时,browser-ops 被过滤 → 断言红。
  // 修法(e2e98c2)是改喂显式 roots + 空 disabled 集。本用例把该隔离性钉死成回归:
  // resolveEnabledSkillDirsFromRoots 必须是 (roots, disabled) 的纯函数——只看传入的 tmp
  // roots 与显式 disabled 集,绝不回读真实 BUILTIN_SKILLS_DIR 或全局 .disabled.json。
  it("resolveEnabledSkillDirsFromRoots 只认传入的 tmp roots 与显式禁用集(隔离全局 .disabled.json 污染)", async () => {
    const root = await mkdtemp(join(tmpdir(), "qingagent-skills-hermetic-"));
    const archivedName = "archived-test-skill";
    ARCHIVED_BUILTIN_SKILLS.add(archivedName);
    try {
      const category = join(root, "capability");
      const makeSkill = async (name: string): Promise<void> => {
        const dir = join(category, name);
        await mkdir(dir, { recursive: true });
        await writeFile(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: 测试技能 ${name}\n---\n`, "utf8");
      };
      await makeSkill("browser-ops"); // 未归档、未禁用 → 应存活
      await makeSkill(archivedName); // 归档名(location 无关)→ 应被过滤
      await makeSkill("team-notes"); // 正常技能,但被显式塞进禁用集 → 应被过滤

      const dirs = await resolveEnabledSkillDirsFromRoots([category], new Set(["team-notes"]));
      const names = dirs.map((dir) => basename(dir));

      expect(names).toContain("browser-ops");
      expect(names).not.toContain(archivedName);
      expect(names).not.toContain("team-notes");
    } finally {
      ARCHIVED_BUILTIN_SKILLS.delete(archivedName);
      await rm(root, { recursive: true, force: true });
    }
  });
});
