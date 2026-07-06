import { describe, expect, it } from "vitest";
import { readImageTool } from "../tools/readImage.js";

type ReadImageResult = {
  ok: boolean;
  text: string;
  error: string | null;
};

describe("readImageTool", () => {
  it("未配置 vision key 时返回设置引导,不继续读图", async () => {
    const result = await readImageTool.execute!(
      {
        image: "not-a-real-image",
        prompt: "请描述图片",
        includeConversation: false,
      },
      {} as never,
    ) as ReadImageResult;

    expect(result).toEqual({
      ok: false,
      text: "",
      error: "还未配置图像识别模型,请在 设置 → 技能 → 图像识别 里填写模型 API Key。",
      materialId: null,
    });
  });
});
