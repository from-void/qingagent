import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertSafeRelativePath,
  parseSkillIdentity,
  validateSkillDirectory,
} from "../skillFiles.js";
import { readTemplateMarkdown } from "../templateFile.js";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("qa cli 本地格式校验", () => {
  it("模板 frontmatter 容忍 BOM、引号和正文中的括号，不吞正文", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "qa-template-format-"));
    dirs.push(dir);
    const filePath = path.join(dir, "template.md");
    await writeFile(
      filePath,
      "\uFEFF---\nid: 'review-1'\ntype: custom\nname: \"法务:严格\"\nupdatedAt: '2026-07-27T00:00:00.000Z'\n---\n检查 JSON 中的 ] 和 }，以及转义引号。",
    );
    await expect(readTemplateMarkdown(filePath)).resolves.toMatchObject({
      id: "review-1",
      type: "custom",
      name: "法务:严格",
      prompt: "检查 JSON 中的 ] 和 }，以及转义引号。",
    });
  });

  it.each([
    ["缺少 fence", "type: custom\nname: x\n正文"],
    ["截断 fence", "---\ntype: custom\nname: x\n正文"],
    ["有 id 无 updatedAt", "---\nid: x\ntype: custom\nname: x\n---\n正文"],
    ["正文为空", "---\ntype: custom\nname: x\n---\n"],
  ])("%s 时拒绝模板文件", async (_label, source) => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "qa-template-invalid-"));
    dirs.push(dir);
    const filePath = path.join(dir, "template.md");
    await writeFile(filePath, source);
    await expect(readTemplateMarkdown(filePath)).rejects.toThrow();
  });

  it("技能 identity 只接受合法根 frontmatter，并容忍 BOM 与引号", () => {
    expect(parseSkillIdentity(
      "\uFEFF---\nname: 'legal-review'\ndescription: \"法务 # 审查\"\n---\n正文",
    )).toEqual({ name: "legal-review", description: "法务 # 审查" });
    expect(parseSkillIdentity(
      "---\nname: diagram-review\ndescription: >-\n  检查图表结构，\n  并核对说明文字。\n---\n正文",
    )).toEqual({
      name: "diagram-review",
      description: "检查图表结构， 并核对说明文字。",
    });
    expect(parseSkillIdentity("前导话\n---\nname: x\ndescription: y\n---")).toBeNull();
    expect(parseSkillIdentity("---junk\nname: x\ndescription: y\n---")).toBeNull();
    expect(parseSkillIdentity("---\nname: ../x\ndescription: y\n---")).toBeNull();
    expect(parseSkillIdentity("---\nname: x\n---")).toBeNull();
  });

  it("技能目录拒绝符号链接和路径逃逸", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "qa-skill-format-"));
    dirs.push(dir);
    await writeFile(
      path.join(dir, "SKILL.md"),
      "---\nname: safe-skill\ndescription: 安全技能\n---\n",
    );
    await mkdir(path.join(dir, "assets"));
    await writeFile(path.join(dir, "outside.txt"), "outside");
    await symlink(path.join(dir, "outside.txt"), path.join(dir, "assets", "link.txt"));
    await expect(validateSkillDirectory(dir)).rejects.toThrow("符号链接");
    expect(() => assertSafeRelativePath("../escape")).toThrow("路径不合法");
    expect(() => assertSafeRelativePath("/tmp/escape")).toThrow("路径不合法");
  });
});
