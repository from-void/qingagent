import { describe, expect, it } from "vitest";
import type { DerivativeItem } from "./types";
import { selectTranslationItem } from "./translationSelection";

const emptyEnglish: DerivativeItem = {
  docId: "translate-en-empty",
  dtype: "translate",
  templateId: "translate-faithful",
  templateName: "忠实精准",
  targetLang: "英语",
  privatePrompt: "",
  sourceVersion: null,
  currentSourceVersion: 1,
  generatedAt: null,
  stale: false,
};

describe("selectTranslationItem", () => {
  it("没有用户选中态时优先恢复已有成品，而不是列表首个空稿", () => {
    const generatedJapanese: DerivativeItem = {
      ...emptyEnglish,
      docId: "translate-ja-generated",
      targetLang: "日语",
      sourceVersion: 1,
      generatedAt: "2026-08-02T08:00:00.000Z",
    };

    expect(selectTranslationItem([emptyEnglish, generatedJapanese])?.docId)
      .toBe(generatedJapanese.docId);
  });

  it("保留用户明确选择的空稿 Tab", () => {
    const generatedJapanese: DerivativeItem = {
      ...emptyEnglish,
      docId: "translate-ja-generated",
      targetLang: "日语",
      sourceVersion: 1,
      generatedAt: "2026-08-02T08:00:00.000Z",
    };

    expect(selectTranslationItem(
      [emptyEnglish, generatedJapanese],
      emptyEnglish.docId,
    )?.docId).toBe(emptyEnglish.docId);
  });
});
