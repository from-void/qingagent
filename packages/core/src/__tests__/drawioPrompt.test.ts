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
      "首个有效非指令行必须是合法图型声明",
      "工程图/架构图 diagram(drawio)",
      "必须是**未压缩明文** mxGraph XML",
      "<drawio>&lt;mxGraphModel",
    ]) {
      expect(AIIR_SYSTEM_PROMPT).not.toContain(movedDetail);
    }
  });

  it("diagram-viz 允许稳定 subgraph 按分区着色，且内置范本补齐可视化主题键", () => {
    const skill = readSkillFile("diagram-viz/SKILL.md");
    const mermaid = readSkillFile("diagram-viz/mermaid/SKILL.md");
    const palettes = readSkillFile("diagram-viz/references/palettes.md");
    const templates = readSkillFile("diagram-viz/references/templates.md");

    for (const source of [skill, mermaid, palettes]) {
      expect(source).toContain("稳定 ASCII id");
      expect(source).toContain("style 分区id fill:#浅色,stroke:#深色");
    }
    expect(skill).not.toContain("不要给 `subgraph` 写 `style` 行");
    expect(palettes).not.toContain("不要给 `subgraph` 写 `style` 行");
    const mermaidTemplate = templates.match(/diagram-viz:template:mermaid:start([\s\S]*?)diagram-viz:template:mermaid:end/)?.[1] ?? "";
    expect(mermaidTemplate).toContain("'clusterBkg':'#EFE7D6'");
    expect(mermaidTemplate).toContain("'clusterBorder':'#2F2A22'");
    expect(mermaidTemplate).toContain("style planGroup fill:#FAF6EC,stroke:#2F2A22");
  });

  it("diagram-viz 子技能承接两段原语法纪律及可解析 draw.io 范本", () => {
    const mermaid = readSkillFile("diagram-viz/mermaid/SKILL.md");
    const drawio = readSkillFile("diagram-viz/drawio/SKILL.md");
    expect(migratedDisciplineHash(mermaid, "- 图表块 diagram：")).toBe(
      "1e641b7ce299c011808bb99e3e60971c3d8f4705f3bb3b1d0c332309d812a8a5",
    );
    expect(migratedDisciplineHash(drawio, "- 工程图/架构图 diagram(drawio)：")).toBe(
      "29ecb9206cf347e4fa7e46516d01b465541b7a19c948ac01a769d3f382369055",
    );

    for (const keyword of [
      "Mermaid 语法只认半角",
      "首个有效非指令行必须是合法图型声明",
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

  it("image-gen 母技能覆盖从零生成与修改现有图片，并把执行细则下沉到子技能", () => {
    const parent = readSkillFile("image-gen/SKILL.md");
    const svg = readSkillFile("image-gen/svg/SKILL.md");
    const codexImage = readSkillFile("image-gen/codex-image/SKILL.md");

    expect(parent).toContain("`command -v codex`");
    expect(parent).toContain("`where codex`");
    expect(parent).toContain("未检测到 Codex 时只有一条可用路线：不反问");
    expect(parent).toContain("必须单独调用一次 `askUserQuestion`");
    expect(parent).toContain("内置 SVG 插画");
    expect(parent).toContain("调度本机 codex 生图");
    expect(parent).toContain("用户配置的自定义生图模型");
    expect(parent).not.toContain("照片级写实图当前未接入");
    expect(parent).toContain("修改现有图片：先识别源格式，再选择执行路线");
    expect(parent).toContain("当前环境未配置这项本机能力");
    expect(parent).toContain("image-edit-codex-confirm");
    expect(parent).toContain("是否使用本机 Codex 修改这张图片");
    expect(parent).not.toContain("我没有编辑图片的能力");

    expect(svg).toContain("从零生成 SVG 插画，以及对用户指定的现有 SVG 做源码级定点修改");
    expect(svg).toContain("generateSvg");
    expect(svg).toContain("editDraft");
    expect(svg).toContain("readDiff");

    expect(codexImage).toContain("codex exec --ephemeral --skip-git-repo-check");
    expect(codexImage).toContain("background:true");
    expect(codexImage).toContain("mastra_workspace_get_process_output");
    expect(codexImage).toContain("importGeneratedImage");
    expect(codexImage).toContain("prepareImageEditSource");
    expect(codexImage).toContain("这是修改现有图片，不是从零生成");
    expect(codexImage).toContain("不要覆盖源图");
    expect(codexImage).toContain("replaceBlock");
    expect(codexImage).toContain("Markdown 图片地址回给用户");
    expect(codexImage).toContain("readDiff");
    expect(codexImage).toContain("禁止复制整段对话");
    expect(codexImage).toContain("从零生成或修改位图");
  });

  it("SVG 定点重绘在 Codex 不可用时自动回落原生源码编辑，且禁止整图重生", () => {
    const parent = readSkillFile("image-gen/SKILL.md");
    const svg = readSkillFile("image-gen/svg/SKILL.md");
    const codexImage = readSkillFile("image-gen/codex-image/SKILL.md");

    expect(parent).toContain("image/svg+xml");
    expect(parent).toContain("自动回落到原生 SVG 定点编辑");
    expect(parent).toContain("问卷恢复");
    expect(parent).toContain("不得把换路责任交给用户");
    expect(parent).not.toContain("不要擅自改走 SVG");

    expect(svg).toContain("修改现有 SVG：原生定点编辑");
    expect(svg).toContain("editablePath");
    expect(svg).toContain("mastra_workspace_read_file");
    expect(svg).toContain("mastra_workspace_edit_file");
    expect(svg).toContain("old_string");
    expect(svg).toContain('"replace_all":false');
    expect(svg).toContain("未点名图元的源码字节保持不变");
    expect(svg).toContain("不得调用 `generateSvg`");
    expect(svg).toContain("importGeneratedImage");
    expect(svg).toContain("replaceBlock");

    expect(codexImage).toContain("SVG 源图必须保持 SVG");
    expect(codexImage).toContain("editablePath");
    expect(codexImage).toContain("只修改用户点名的图元");
    expect(codexImage).toContain("自动回落到原生 SVG 定点编辑");
    expect(codexImage).toContain("editSvgWithCodexFallback");
    expect(codexImage).toContain("Windows 盘符");
    expect(codexImage).toContain("指令写入、Codex 运行/核验或导入任一步骤失败都只重试一次");
    expect(codexImage).toContain("不得在工具外再次重试 Codex 或写指令文件");
    expect(codexImage).toContain("不让会话停在“思考中”");
    expect(codexImage).not.toContain("修改现有图片失败时不得用 SVG 重画冒充成功");
  });
});
