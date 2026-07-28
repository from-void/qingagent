import { beforeEach, describe, expect, it, vi } from "vitest";
import { DTYPE_COMMON_CONSTRAINTS } from "./dtypeTemplatePrompts.js";

const h = vi.hoisted(() => ({ disabledSkills: new Set<string>() }));

vi.mock("../skills/enabledStore.js", () => ({
  readDisabledSet: vi.fn(async () => new Set(h.disabledSkills)),
}));

describe("衍生稿子技能纪律装载", () => {
  beforeEach(() => {
    h.disabledSkills.clear();
    vi.resetModules();
  });

  it("默认从子技能文件读纪律", async () => {
    const { loadDerivativeGuidance } = await import("./skillGuidance.js");
    const guidance = await loadDerivativeGuidance("xhs");
    expect(guidance.source).toBe("skill");
    expect(guidance.skillName).toBe("xiaohongshu");
    expect(guidance.text).toContain("不得新增主稿外亲历事件");
    expect(guidance.text.startsWith("---")).toBe(false);
  });

  it("母技能停用时降级为内置最小纪律,不阻断生成", async () => {
    h.disabledSkills.add("derivative-writing");
    const { loadDerivativeGuidance } = await import("./skillGuidance.js");
    for (const dtype of ["gzh", "xhs", "translate"] as const) {
      const guidance = await loadDerivativeGuidance(dtype);
      expect(guidance.source).toBe("fallback");
      expect(guidance.skillName).toBeNull();
      // 降级文本等于迁移前的固定约束,纪律不为空。
      expect(guidance.text).toBe(DTYPE_COMMON_CONSTRAINTS[dtype]);
      expect(guidance.text.length).toBeGreaterThan(0);
    }
  });

  it("未知 dtype 走空回退而不抛错", async () => {
    const { loadDerivativeGuidance } = await import("./skillGuidance.js");
    const guidance = await loadDerivativeGuidance("unknown-dtype");
    expect(guidance).toEqual({ skillName: null, source: "fallback", text: "" });
  });

  it("frontmatter 不进注入正文", async () => {
    const { skillBodyOf } = await import("./skillGuidance.js");
    expect(skillBodyOf("---\nname: x\nlabel: y\n---\n\n# 标题\n正文")).toBe("# 标题\n正文");
    expect(skillBodyOf("﻿---\nname: x\n---\n正文")).toBe("正文");
    expect(skillBodyOf("没有 frontmatter 的正文")).toBe("没有 frontmatter 的正文");
  });
});
