import { describe, expect, it } from "vitest";
import type { DerivativeItem } from "./types";
import { buildActiveDerivativeTurnContext } from "./derivativeTurnContext";

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
});
