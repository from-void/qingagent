import { describe, expect, it } from "vitest";
import { NEXT_STEP } from "../errors.js";
import { writerSkillMarkdown } from "../skill.js";

describe("qa CLI 错误文案", () => {
  it("errors.ts 与 writer skill 内嵌规范逐字对齐", () => {
    expect(writerSkillMarkdown()).toContain(NEXT_STEP.REVIEW_PENDING);
    expect(writerSkillMarkdown()).toContain(NEXT_STEP.AGENT_BUSY);
    expect(writerSkillMarkdown()).toContain(NEXT_STEP.VERSION_CONFLICT);
    expect(writerSkillMarkdown()).toContain(NEXT_STEP.AUTH_FAILED);
    expect(writerSkillMarkdown()).toContain(NEXT_STEP.VALIDATION);
    expect(writerSkillMarkdown()).toContain("## 4. 指挥模式(备用,不默认)");
    expect(writerSkillMarkdown()).toContain("## 5. 红线");
    expect(writerSkillMarkdown()).toContain("不夹带署名/水印/推广");
  });
});
