import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { qingmlParse } from "@qingagent/pm-schema";
import { AIIR_SYSTEM_PROMPT } from "../prompts/system.js";

function readSkillFile(relativePath: string): string {
  return readFileSync(
    new URL(`../../skills/capability/${relativePath}`, import.meta.url),
    "utf8",
  );
}

function migratedDisciplineHash(source: string, prefix: string): string {
  const line = source.split("\n").find((value) => value.startsWith(prefix));
  if (!line) throw new Error(`缺少迁移原文：${prefix}`);
  return createHash("sha256").update(line).digest("hex");
}

describe("图表技能静态提示词契约", () => {
  it("主 system 摘除 Mermaid/draw.io 语法正文，只保留按需路由", () => {
    expect(AIIR_SYSTEM_PROMPT).toContain('skill({name:"diagram-viz"})');
    for (const movedDetail of [
      "Mermaid 语法只认半角",
      "source **首行必须是合法图型声明**",
      "工程图/架构图 diagram(drawio)",
      "必须是**未压缩明文** mxGraph XML",
      "<drawio>&lt;mxGraphModel",
    ]) {
      expect(AIIR_SYSTEM_PROMPT).not.toContain(movedDetail);
    }
  });

  it("diagram-viz 子技能承接两段原语法纪律及可解析 draw.io 范本", () => {
    const mermaid = readSkillFile("diagram-viz/mermaid/SKILL.md");
    const drawio = readSkillFile("diagram-viz/drawio/SKILL.md");
    expect(migratedDisciplineHash(mermaid, "- 图表块 diagram：")).toBe(
      "ffdab917b253716e439803cb6222aa379c933557edd7161ba2b5622aa5dffd42",
    );
    expect(migratedDisciplineHash(drawio, "- 工程图/架构图 diagram(drawio)：")).toBe(
      "29ecb9206cf347e4fa7e46516d01b465541b7a19c948ac01a769d3f382369055",
    );

    for (const keyword of [
      "Mermaid 语法只认半角",
      "source **首行必须是合法图型声明**",
      "Mermaid 关键字必须保持英文原样",
    ]) {
      expect(mermaid).toContain(keyword);
    }
    for (const keyword of [
      "工程图/架构图 diagram(drawio)",
      "网络拓扑",
      "未压缩明文",
      "严禁 base64、deflate",
      "mxGraphModel",
      "mxCell",
      "mxGeometry",
      'edge="1"',
      'relative="1"',
      "保留未改节点/边的稳定 mxCell id",
      "不要在 XML 中放 script、链接、外部图片",
    ]) {
      expect(drawio).toContain(keyword);
    }

    const match = drawio.match(/<drawio>&lt;mxGraphModel[\s\S]*?<\/drawio>/);
    expect(match?.[0]).toBeTruthy();
    const parsed = qingmlParse(match![0]);
    expect(parsed.warnings.filter((warning) => warning.severity === "bad-block")).toEqual([]);
    expect(parsed.blocks[0]).toMatchObject({
      type: "diagram",
      lang: "drawio",
      source: expect.stringContaining("<mxGraphModel>"),
    });
  });

  it("diagram-viz 约束大图通过文档工具分层或增量施工", () => {
    const skill = readSkillFile("diagram-viz/SKILL.md");
    for (const keyword of [
      "`writeDraft` / `editDraft` 落入文档",
      "严禁在聊天回复里直接手打整段 XML 或 Mermaid 长源码",
      "单图节点建议不超过 25 个",
      "按层拆成多张图（每层一张）",
      "再用 `editDraft` 增量补充节点",
    ]) {
      expect(skill).toContain(keyword);
    }
  });

  it("diagram-viz 单独画图时反问引擎，并只保留三个豁免", () => {
    const skill = readSkillFile("diagram-viz/SKILL.md");
    for (const keyword of [
      "单独画图先问引擎（铁则）",
      "`askUserQuestion`",
      "Mermaid（自动布局，适合流程/时序/状态，改起来省心）",
      "draw.io（手工可编辑画布，适合架构/拓扑/自由排版）",
      "用户已点名引擎",
      "写文章时顺带配图",
      "用户说过“别问”“直接画”",
      "只有三个豁免",
    ]) {
      expect(skill).toContain(keyword);
    }
  });

  it("image-gen 只保留 SVG 配图职责和现行文档工具口径", () => {
    const skill = readSkillFile("image-gen/SKILL.md");
    expect(skill).toContain("本技能只负责**生成式 SVG 插画资产**");
    expect(skill).toContain("writeDraft");
    expect(skill).toContain("editDraft");
    expect(skill).toContain("readDiff");
    expect(skill).not.toContain("## ① Mermaid");
    expect(skill).not.toContain("## ② drawio");
    expect(skill).not.toContain("generateDoc");
    expect(skill).not.toContain("AI-IR");
  });
});
