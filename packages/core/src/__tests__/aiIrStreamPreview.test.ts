import { describe, expect, it } from "vitest";
import { aiIrStreamPreviewFromMarkup, tailExcerpt } from "../utils/aiIrStreamPreview.js";

describe("tailExcerpt 滚动摘录", () => {
  it("短文本原样返回(空白压平)", () => {
    expect(tailExcerpt("你好\n世界")).toBe("你好 世界");
  });
  it("长文本取末尾 N 个码点", () => {
    const text = "甲".repeat(100) + "结尾十个字符在这里啦";
    expect(tailExcerpt(text, 10)).toBe("结尾十个字符在这里啦");
  });
});

describe("aiIrStreamPreviewFromMarkup 半截 QingML 容错提取", () => {
  it("剥标签、保留 br 换行并解码实体", () => {
    expect(aiIrStreamPreviewFromMarkup("<p>甲&lt;乙<br><b>粗</b></p>")).toBe("甲<乙\n粗");
  });

  it("容忍尾部标签未闭合，保留不像标签的裸尖括号", () => {
    expect(aiIrStreamPreviewFromMarkup("```qingml\n<p>正文</p><a href=\"https://example.com\">链")).toBe("正文链");
    expect(aiIrStreamPreviewFromMarkup("正文裸 <&; <span")).toBe("正文裸 <&; ");
  });
});
