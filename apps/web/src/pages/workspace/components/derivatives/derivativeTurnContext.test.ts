import { describe, expect, it } from "vitest";
import type { DerivativeItem } from "./types";
import {
  buildActiveDerivativeTurnContext,
  buildActiveDocumentTurnTarget,
} from "./derivativeTurnContext";

const xhsDerivative: DerivativeItem = {
  docId: "derivative-xhs-1",
  dtype: "xhs",
  templateId: "xhs-recommend",
  templateName: "种草安利",
  privatePrompt: "",
  sourceVersion: 1,
  currentSourceVersion: 1,
  generatedAt: "2026-07-26T00:00:00.000Z",
  stale: false,
};
const englishTranslation: DerivativeItem = {
  ...xhsDerivative,
  docId: "translation-en",
  dtype: "translate",
  targetLang: "英语",
  templateId: "translate-faithful",
  templateName: "忠实精准",
};
const japaneseTranslation: DerivativeItem = {
  ...englishTranslation,
  docId: "translation-ja",
  targetLang: "日语",
};

describe("buildActiveDerivativeTurnContext", () => {
  it("激活的 Tab 对应衍生稿时注入 doc_id、类型与修改路由", () => {
    expect(
      buildActiveDerivativeTurnContext(xhsDerivative.docId, [xhsDerivative]),
    ).toBe(
      "[系统:用户当前正查看衍生稿(doc_id: derivative-xhs-1,类型=小红书稿)。" +
        "若本轮是对这篇衍生稿的修改诉求,按「已有衍生稿修改路由」执行,doc_id 已给出无需 list_derivatives 定位。]",
    );
  });

  it("激活 Tab 不是已加载的衍生稿时不注入", () => {
    expect(
      buildActiveDerivativeTurnContext("derivative-not-loaded", [xhsDerivative]),
    ).toBeNull();
  });

  it("激活主文档 Tab 时不注入", () => {
    expect(buildActiveDerivativeTurnContext("main", [xhsDerivative])).toBeNull();
  });

  it("F3: 翻译聚合 Tab 按当前语言译文注入准确 doc_id", () => {
    expect(
      buildActiveDerivativeTurnContext(
        "translate",
        [englishTranslation, japaneseTranslation],
        japaneseTranslation.docId,
      ),
    ).toBe(
      "[系统:用户当前正查看衍生稿(doc_id: translation-ja,类型=翻译)。" +
        "若本轮是对这篇衍生稿的修改诉求,按「已有衍生稿修改路由」执行,doc_id 已给出无需 list_derivatives 定位。]",
    );
  });

  it("主稿始终生成显式目标，覆盖同 session 历史衍生稿状态", () => {
    expect(
      buildActiveDocumentTurnTarget(
        "main",
        "一条老街的三种活法",
        [xhsDerivative],
      ),
    ).toEqual({
      activeDocument: { kind: "main" },
      label: "主稿 · 《一条老街的三种活法》",
    });
  });

  it("衍生稿与译文生成结构化目标，未知 Tab 安全回退主稿", () => {
    expect(
      buildActiveDocumentTurnTarget(
        xhsDerivative.docId,
        "主稿",
        [xhsDerivative],
      ),
    ).toEqual({
      activeDocument: {
        kind: "derivative",
        docId: xhsDerivative.docId,
      },
      label: "小红书稿 · 种草安利",
    });
    expect(
      buildActiveDocumentTurnTarget(
        "translate",
        "主稿",
        [englishTranslation, japaneseTranslation],
        japaneseTranslation.docId,
      ),
    ).toEqual({
      activeDocument: {
        kind: "derivative",
        docId: japaneseTranslation.docId,
      },
      label: "翻译 · 日语",
    });
    expect(
      buildActiveDocumentTurnTarget(
        "missing-derivative",
        "",
        [xhsDerivative],
      ),
    ).toEqual({
      activeDocument: { kind: "main" },
      label: "主稿 · 《未命名文档》",
    });
  });
});
