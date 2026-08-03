import { describe, expect, it } from "vitest";
import { resolveSkillDisplayMetadata, skillToMenuAction } from "./skillDisplay";

describe("skillToMenuAction", () => {
  it("行内保留短摘要，同时把完整 description 交给 tooltip", () => {
    const action = skillToMenuAction({
      name: "lark-shared",
      label: "lark-shared",
      summary: "Use when first setting up lark-cli,…",
      description: "Use for lark-cli setup/auth tasks and permissions.",
      icon: "star",
      enabled: true,
      userInvocable: true,
    });

    expect(action.description).toBe("Use when first setting up lark-cli,…");
    expect(action.fullDescription).toBe("Use for lark-cli setup/auth tasks and permissions.");
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
      name: "third-party-helper",
      label: "third-party-helper",
      summary: "Perform proprietary operations…",
      description: "Perform proprietary operations with an external service.",
      placeholder: "Describe what to process",
      icon: "star",
      enabled: true,
      userInvocable: true,
      source: "external-shared",
    });

    expect(action).toMatchObject({
      label: "third-party-helper",
      description: "第三方技能",
      fullDescription: "第三方技能",
      placeholder: "第三方技能",
    });
  });
});
