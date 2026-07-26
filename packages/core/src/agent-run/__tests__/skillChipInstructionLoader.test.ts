import type { WorkspaceSkills } from "@mastra/core/workspace";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("../../skills/enabledStore.js", () => ({
  readDisabledSet: vi.fn(async () => new Set<string>()),
}));

import { createSkillChipInstructionLoader } from "../skillChipInstructionLoader.js";
import { resolveSelectedSkillNames } from "../../session/sessionTools.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("skill chip 母子技能加载", () => {
  it("selectedSkills 与 chip 收到子技能 id 时都归一到母技能", async () => {
    const root = await mkdtemp(join(tmpdir(), "qingagent-skill-chip-parent-"));
    temporaryRoots.push(root);
    const parentDir = join(root, "review");
    const childDir = join(parentDir, "sensitive");
    await mkdir(childDir, { recursive: true });
    await writeFile(
      join(parentDir, "SKILL.md"),
      "---\nname: review\ndescription: 母技能\n---\n# 文档审查\n读取 `sensitive/SKILL.md`。",
      "utf8",
    );
    await writeFile(
      join(childDir, "SKILL.md"),
      "---\nname: sensitive\ndescription: 子技能\n---\n# 敏感词审查",
      "utf8",
    );

    const skills = {
      get: vi.fn(async (id: string) =>
        id === "review"
          ? { name: "review", path: parentDir }
          : null,
      ),
      has: vi.fn(async (id: string) => id === "review"),
      list: vi.fn(async () => [
        { name: "review", path: parentDir, description: "母技能" },
      ]),
    } as unknown as WorkspaceSkills;
    const loader = createSkillChipInstructionLoader(skills);

    const parent = await loader({ id: "review", label: "文档审查", index: 0 });
    expect(parent).toMatchObject({
      ok: true,
      id: "review",
      source: join(parentDir, "SKILL.md"),
    });
    if (parent.ok) {
      expect(parent.content).toContain("# 文档审查");
      expect(parent.content).toContain("`sensitive/SKILL.md`");
      expect(parent.content).not.toContain("# 敏感词审查");
    }

    await expect(resolveSelectedSkillNames(["sensitive"], skills)).resolves.toEqual([
      "review",
    ]);
    await expect(
      loader({ id: "sensitive", label: "敏感词审查", index: 1 }),
    ).resolves.toMatchObject({
      ok: true,
      id: "review",
      source: join(parentDir, "SKILL.md"),
      content: expect.stringContaining("# 文档审查"),
    });
  });
});
