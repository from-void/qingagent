import { readFile, rm } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { installPointerSkill, pointerSkillMarkdown, skillInstallPath } from "../skill.js";

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("skills install", () => {
  it("写入 claude 薄指针 skill 到指定 home", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "qa-skill-"));
    dirs.push(home);
    const filePath = await installPointerSkill("claude", home);
    expect(filePath).toBe(skillInstallPath("claude", home));
    expect(await readFile(filePath, "utf8")).toBe(pointerSkillMarkdown());
  });

  it("写入 codex 薄指针 skill 到指定 home", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "qa-skill-"));
    dirs.push(home);
    const filePath = await installPointerSkill("codex", home);
    expect(filePath).toBe(skillInstallPath("codex", home));
    expect(filePath).toContain(path.join(".codex", "skills", "qingagent-writer", "SKILL.md"));
  });
});
