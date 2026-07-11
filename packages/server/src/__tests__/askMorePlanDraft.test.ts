import { describe, expect, it } from "vitest";
import type { ToolCallSpec } from "@qingagent/contract-ts";
import { createSession } from "@qingagent/core";
import {
  appendAskMoreQuestions,
  findOpenPlanDraftQuestionnaireId,
  hasOpenPlanDraftQuestionnaire,
  isOpenPlanDraftQuestionnaire,
} from "../routes/askMore";

function questionnaireSpec(name: string): ToolCallSpec {
  return {
    id: `${name}-1`,
    name,
    render: { kind: "rightForm" },
    status: { kind: "pending" },
    body: {
      kind: "askUser",
      data: {
        id: `${name}-1`,
        mode: { kind: name === "askUserQuestion" ? "overlay" : "fullpage" },
        purpose: null,
        source: null,
        rationale: null,
        questions: [],
      },
    },
    result: null,
  };
}

function sessionWith(name: string) {
  const session = createSession(`ask-more-${name}`);
  session.chatHistory.push({
    id: "message-1",
    role: { kind: "agent" },
    ts: "2026-07-11T00:00:00.000Z",
    parts: [{ kind: "toolCall", data: questionnaireSpec(name) }],
    chips: null,
  });
  return session;
}

describe("askMore planDraft guard", () => {
  it.each(["askUser", "planDraft"])("允许 %s 写作方向问卷追加问题", (name) => {
    expect(hasOpenPlanDraftQuestionnaire(sessionWith(name))).toBe(true);
  });

  it("拒绝 askUserQuestion 直传问卷扩题", () => {
    expect(hasOpenPlanDraftQuestionnaire(sessionWith("askUserQuestion"))).toBe(false);
  });

  it("只接受请求明确指向的开放 planDraft", () => {
    const session = sessionWith("planDraft");
    expect(isOpenPlanDraftQuestionnaire(session, "planDraft-1")).toBe(true);
    expect(isOpenPlanDraftQuestionnaire(session, "stale-plan")).toBe(false);
  });

  it("追加结果只回写请求开始时捕获的同一张问卷", () => {
    const session = sessionWith("planDraft");
    const original = session.chatHistory[0]!.parts[0]!;
    if (original.kind !== "toolCall") throw new Error("expected tool call");
    const capturedId = findOpenPlanDraftQuestionnaireId(session);
    expect(capturedId).toBe(original.data.id);

    original.data.status = { kind: "done" };
    const replacement = questionnaireSpec("planDraft");
    replacement.id = "planDraft-replacement";
    session.chatHistory.push({
      id: "message-2",
      role: { kind: "agent" },
      ts: "2026-07-11T00:00:01.000Z",
      parts: [{ kind: "toolCall", data: replacement }],
      chips: null,
    });

    expect(appendAskMoreQuestions(session, capturedId!, [{
      id: "more-1",
      label: "追加题",
      kind: { kind: "single" },
      options: [
        { value: "a", label: "甲" },
        { value: "b", label: "乙" },
      ],
      placeholder: null,
    }])).toBe(false);
    if (replacement.body.kind !== "askUser") throw new Error("expected questionnaire body");
    expect(replacement.body.data.questions).toEqual([]);
  });
});
