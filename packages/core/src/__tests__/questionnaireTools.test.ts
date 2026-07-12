import { describe, expect, it } from "vitest";
import type { PmDoc } from "@qingagent/pm-schema";
import {
  isDirectionReset,
  isPlanDraftTool,
  isQuestionnaireTool,
} from "../agent-run/questionnaireTools.js";

describe("questionnaire tool predicates", () => {
  it.each(["askUser", "planDraft", "askUserQuestion"])(
    "把 %s 识别为问卷通道工具",
    (toolName) => {
      expect(isQuestionnaireTool(toolName)).toBe(true);
    },
  );

  it.each(["askUser", "planDraft"])("把 %s 识别为写作方向工具", (toolName) => {
    expect(isPlanDraftTool(toolName)).toBe(true);
  });

  it("通用提问豁免写作方向闸，其他工具不进入问卷通道", () => {
    expect(isPlanDraftTool("askUserQuestion")).toBe(false);
    expect(isQuestionnaireTool("writeDraft")).toBe(false);
    expect(isQuestionnaireTool(null)).toBe(false);
  });
});

describe("isDirectionReset", () => {
  const emptyDoc: PmDoc = { type: "doc", attrs: { schemaVersion: 1 }, content: [] };

  it("已提交方向问卷时为真", () => {
    expect(isDirectionReset({
      _askUserCompleted: true,
      doc: emptyDoc,
      legacySections: [],
    })).toBe(true);
  });

  it("已有 canonical 文档时为真", () => {
    expect(isDirectionReset({
      _askUserCompleted: false,
      doc: {
        type: "doc",
        attrs: { schemaVersion: 1 },
        content: [{
          type: "paragraph",
          attrs: { blockId: "block-1" },
          content: [{ type: "text", text: "正文" }],
        }],
      },
      legacySections: [],
    })).toBe(true);
  });

  it("空会话且未提交问卷时为假", () => {
    expect(isDirectionReset({
      _askUserCompleted: false,
      doc: emptyDoc,
      legacySections: [],
    })).toBe(false);
  });
});
