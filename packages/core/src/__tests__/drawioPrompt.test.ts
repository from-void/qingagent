import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { qingmlParse } from "@qingagent/pm-schema";
import { AIIR_SYSTEM_PROMPT } from "../prompts/system.js";

describe("drawio 静态提示词契约", () => {
  it("主 system 在模型实际编辑上下文提供选型、明文 XML 规范和可解析范本", () => {
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
      expect(AIIR_SYSTEM_PROMPT).toContain(keyword);
    }
    const match = AIIR_SYSTEM_PROMPT.match(/<drawio>&lt;mxGraphModel[\s\S]*?<\/drawio>/);
    expect(match?.[0]).toBeTruthy();
    const parsed = qingmlParse(match![0]);
    expect(parsed.warnings.filter((warning) => warning.severity === "bad-block")).toEqual([]);
    expect(parsed.blocks[0]).toMatchObject({
      type: "diagram",
      lang: "drawio",
      source: expect.stringContaining("<mxGraphModel>"),
    });
  });

  it("出图 skill 按四类路由并给出 drawio 最小生成规范", () => {
    const skill = readFileSync(
      new URL("../../skills/capability/image-gen/SKILL.md", import.meta.url),
      "utf8",
    );
    expect(skill).toContain("四类");
    expect(skill).toContain("工程图/架构图(drawio)");
    expect(skill).toContain("未压缩 mxGraphModel XML");
    expect(skill).toContain('mxCell vertex="1"');
    expect(skill).toContain('edge="1"');
    expect(skill).toContain("禁止脚本、链接、外部图片");
  });
});
