import { describe, expect, it, vi } from "vitest";
import { RequestContext } from "@mastra/core/request-context";
import {
  SKILL_WRITE_INJECT_CHAR_LIMIT,
  activateSkill,
  buildActivatedSkillWriteInject,
  getActivatedSkillRegistrations,
  parseSkillWriteInjectSource,
  registerSkillWriteInjectResolver,
} from "../skills/writeInject.js";

function skillSource(
  name: string,
  body: string,
  writeInject: boolean | null = true,
): string {
  return [
    "---",
    `name: ${name}`,
    `description: ${name} 测试技能`,
    ...(writeInject === null ? [] : [`write-inject: ${writeInject}`]),
    "---",
    body,
  ].join("\n");
}

describe("已激活技能写稿注入管道", () => {
  it("frontmatter 未声明时默认关闭，声明后默认注入去 frontmatter 的正文", async () => {
    const requestContext = new RequestContext();
    activateSkill(requestContext, "plain-skill");
    activateSkill(requestContext, "write-skill");

    const result = await buildActivatedSkillWriteInject({
      requestContext,
      hintText: "写一份说明",
      loadSkill: async (name) =>
        name === "plain-skill"
          ? skillSource(name, "# 不应注入", null)
          : skillSource(name, "# 应注入\n按本技能写稿。"),
    });

    expect(result.injectedSkillNames).toEqual(["write-skill"]);
    expect(result.content).toContain(
      '<activated_skill_write_inject name="write-skill">',
    );
    expect(result.content).toContain("# 应注入");
    expect(result.content).not.toContain("write-inject: true");
    expect(result.content).not.toContain("# 不应注入");
  });

  it("完整标记只注入指定段，残缺标记回退完整正文", () => {
    const marked = parseSkillWriteInjectSource(
      skillSource(
        "marked-skill",
        [
          "标记前",
          "<!-- skill:write-inject:start -->",
          "只注入这里",
          "<!-- skill:write-inject:end -->",
          "标记后",
        ].join("\n"),
      ),
    );
    expect(marked.writeInject).toBe(true);
    expect(marked.payload).toBe("只注入这里");

    const dirty = parseSkillWriteInjectSource(
      skillSource(
        "dirty-skill",
        "保留正文\n<!-- skill:write-inject:start -->\n残缺段",
      ),
    );
    expect(dirty.payload).toContain("保留正文");
    expect(dirty.payload).toContain("残缺段");
  });

  it("自定义 resolver 可按激活提示裁剪载荷，且每个技能只解析一次", async () => {
    const requestContext = new RequestContext();
    activateSkill(requestContext, "custom-skill", "首次提示");
    activateSkill(requestContext, "custom-skill", "补充提示");
    const resolver = vi.fn(({ activationHints, hintText }) =>
      `${activationHints.join("|")} -> ${hintText}`
    );
    const unregister = registerSkillWriteInjectResolver(
      "custom-skill",
      resolver,
    );

    try {
      const result = await buildActivatedSkillWriteInject({
        requestContext,
        hintText: "内层写稿",
        loadSkill: async (name) => skillSource(name, "默认正文"),
      });

      expect(getActivatedSkillRegistrations(requestContext)).toEqual([{
        name: "custom-skill",
        hints: ["首次提示", "补充提示"],
      }]);
      expect(resolver).toHaveBeenCalledTimes(1);
      expect(result.content).toContain("首次提示|补充提示 -> 内层写稿");
      expect(result.content).not.toContain("默认正文");
    } finally {
      unregister();
    }
  });

  it("不论激活顺序都按技能名稳定拼接", async () => {
    const requestContext = new RequestContext();
    activateSkill(requestContext, "zeta-skill");
    activateSkill(requestContext, "alpha-skill");

    const result = await buildActivatedSkillWriteInject({
      requestContext,
      hintText: "",
      loadSkill: async (name) => skillSource(name, `正文:${name}`),
    });

    expect(result.injectedSkillNames).toEqual(["alpha-skill", "zeta-skill"]);
    expect(result.content.indexOf('name="alpha-skill"')).toBeLessThan(
      result.content.indexOf('name="zeta-skill"'),
    );
  });

  it("总注入超过与 chip 对齐的 20 万字符硬顶时截断并记录警告", async () => {
    const requestContext = new RequestContext();
    activateSkill(requestContext, "large-skill");
    const warnings: unknown[] = [];

    const result = await buildActivatedSkillWriteInject({
      requestContext,
      hintText: "",
      loadSkill: async (name) =>
        skillSource(name, "长".repeat(SKILL_WRITE_INJECT_CHAR_LIMIT + 100)),
      onWarning: (warning) => warnings.push(warning),
    });

    expect(SKILL_WRITE_INJECT_CHAR_LIMIT).toBe(200_000);
    expect(result.truncated).toBe(true);
    expect(result.originalCharCount).toBeGreaterThan(
      SKILL_WRITE_INJECT_CHAR_LIMIT,
    );
    expect(result.content).toHaveLength(SKILL_WRITE_INJECT_CHAR_LIMIT);
    expect(warnings).toContainEqual(expect.objectContaining({
      kind: "truncated",
      message: expect.stringContaining("超过硬上限 200000"),
    }));
  });
});
