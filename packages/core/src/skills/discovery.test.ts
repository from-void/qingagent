import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { parseSkillFrontmatter, scanSkillHierarchy } from "./discovery.js";

describe("技能发现摘要后备", () => {
  it("英文长描述按首句断词截断并追加省略号", () => {
    const parsed = parseSkillFrontmatter(
      "---\n"
      + "name: english-summary-fallback\n"
      + "description: Generate or edit polished raster images for product interfaces. "
      + "Use this second sentence only as extra detail.\n"
      + "---\n",
    );

    expect(parsed?.summary).toBe("Generate or edit polished raster images…");
  });

  it("英文句号后接空格时只取首句", () => {
    const parsed = parseSkillFrontmatter(
      "---\n"
      + "name: english-sentence-boundary\n"
      + "description: Generate images. This second sentence must not enter the summary.\n"
      + "---\n",
    );

    expect(parsed?.summary).toBe("Generate images");
  });

  it("中文短分句保持原文且不追加省略号", () => {
    const parsed = parseSkillFrontmatter(
      "---\nname: chinese-summary-fallback\ndescription: 生成或编辑图片。用于产品配图\n---\n",
    );

    expect(parsed?.summary).toBe("生成或编辑图片");
  });

  it("显式 summary 优先于 description 后备摘要", () => {
    const parsed = parseSkillFrontmatter(
      "---\n"
      + "name: explicit-summary\n"
      + "description: Generate or edit polished raster images for product interfaces.\n"
      + "summary: 自定义摘要\n"
      + "---\n",
    );

    expect(parsed?.summary).toBe("自定义摘要");
  });

  it("displayName 作为中文展示名并兼容既有 label", () => {
    const displayName = parseSkillFrontmatter(
      "---\nname: image-helper\ndisplayName: 图片处理\ndescription: Handle images.\n---\n",
    );
    const legacyLabel = parseSkillFrontmatter(
      "---\nname: legacy-helper\nlabel: 旧版显示名\ndescription: Handle files.\n---\n",
    );

    expect(displayName).toMatchObject({ displayName: "图片处理", label: "图片处理" });
    expect(legacyLabel).toMatchObject({ displayName: "旧版显示名", label: "旧版显示名" });
  });

  it("仓内全部技能 manifest 都声明中文显示名与中文摘要", async () => {
    const skills = await scanSkillHierarchy(resolve(process.cwd(), "skills"));
    const missingChineseMetadata = skills
      .filter(({ metadata }) => (
        !/[\u3400-\u9fff]/u.test(metadata.displayName ?? metadata.label)
        || !/[\u3400-\u9fff]/u.test(metadata.summary)
      ))
      .map(({ metadata }) => metadata.name);

    expect(skills.length).toBeGreaterThan(0);
    expect(missingChineseMetadata).toEqual([]);
  });
});
