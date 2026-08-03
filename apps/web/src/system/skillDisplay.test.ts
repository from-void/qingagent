import { describe, expect, it } from "vitest";
import { resolveSkillDisplayMetadata, skillToMenuAction } from "./skillDisplay";

describe("skillToMenuAction", () => {
  it("随包 lark 技能使用中文元数据，英文原文不进入 tooltip", () => {
    const action = skillToMenuAction({
      name: "lark-shared",
      label: "lark-shared",
      summary: "Use when first setting up lark-cli,…",
      description: "Use for lark-cli setup/auth tasks and permissions.",
      icon: "star",
      enabled: true,
      userInvocable: true,
      source: "external-shared",
    });

    expect(action).toMatchObject({
      label: "飞书连接与授权",
      description: "管理飞书登录、身份与权限",
      fullDescription: "管理飞书登录、身份与权限",
      placeholder: "管理飞书登录、身份与权限",
    });
  });

  it("lark-cli 随包 27 项全量命中中文显示名与摘要", () => {
    const names = [
      "lark-approval",
      "lark-apps",
      "lark-attendance",
      "lark-base",
      "lark-calendar",
      "lark-contact",
      "lark-doc",
      "lark-drive",
      "lark-event",
      "lark-im",
      "lark-mail",
      "lark-markdown",
      "lark-minutes",
      "lark-note",
      "lark-okr",
      "lark-openapi-explorer",
      "lark-shared",
      "lark-sheets",
      "lark-skill-maker",
      "lark-slides",
      "lark-task",
      "lark-vc",
      "lark-vc-agent",
      "lark-whiteboard",
      "lark-wiki",
      "lark-workflow-meeting-summary",
      "lark-workflow-standup-report",
    ];

    expect(names).toHaveLength(27);
    for (const name of names) {
      const metadata = resolveSkillDisplayMetadata({
        name,
        label: name,
        summary: "English summary…",
        description: "English description.",
        icon: "star",
        enabled: true,
        userInvocable: true,
        source: "external-shared",
      });
      expect(metadata.displayName, name).toMatch(/[\u3400-\u9fff]/u);
      expect(metadata.displayName, name).not.toContain(name);
      expect(metadata.summary, name).toMatch(/[\u3400-\u9fff]/u);
      expect(metadata.summary, name).not.toContain("English");
    }
  });

  it("Codex 内置技能使用静态中文元数据", () => {
    expect(resolveSkillDisplayMetadata({
      name: "imagegen",
      label: "imagegen",
      summary: "Generate or edit raster images…",
      description: "Generate or edit raster images with the OpenAI Image API.",
      icon: "star",
      enabled: true,
      userInvocable: true,
      source: "external-codex",
    })).toEqual({ displayName: "图片生成", summary: "生成或编辑图片" });
  });

  it("未知外部技能保留原名但不向 UI 透出英文长描述", () => {
    const action = skillToMenuAction({
      name: "lark-custom-helper",
      label: "lark-custom-helper",
      summary: "Perform proprietary operations…",
      description: "Perform proprietary operations with an external service.",
      placeholder: "Describe what to process",
      icon: "star",
      enabled: true,
      userInvocable: true,
      source: "external-shared",
    });

    expect(action).toMatchObject({
      label: "lark-custom-helper",
      description: "第三方技能",
      fullDescription: "第三方技能",
      placeholder: "第三方技能",
    });
  });
});
