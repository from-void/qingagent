import { describe, expect, it } from "vitest";
import { LocalFilesystem, Workspace } from "@mastra/core/workspace";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { resolveEnabledSkillDirs, resolveEnabledSkillDirsFromRoots } from "../agents/qingagent.js";
import { BUILTIN_SKILLS_DIR, USER_SKILLS_DIR } from "../skills/paths.js";
import { isArchivedBuiltinSkillName } from "../skills/archived.js";

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

  it("filters archived builtin skills before Mastra Workspace can discover them", async () => {
    const skillDirs = await resolveEnabledSkillDirs();

    expect(skillDirs.some((dir) => isArchivedBuiltinSkillName(basename(dir)))).toBe(false);
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

    expect(await skillsApi.has("dingtalk-docs")).toBe(false);
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
});
