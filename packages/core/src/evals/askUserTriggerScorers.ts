import { createScorer } from "@mastra/core/evals";
import { extractAgentOutput, type AskUserActionOutput } from "./askUserScorers.js";
import type { AskUserTriggerFixture } from "./askUserTriggerFixtures.js";

export interface AskUserTriggerEvaluation {
  score: 0 | 1;
  actualToolNames: string[];
  asked: boolean;
  wroteDraft: boolean;
  askUserWasAlone: boolean;
  reason: string;
  textExcerpt: string;
}

function firstTextExcerpt(text: string): string {
  const first = text
    .split(/\n+/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .find((line) => line.length > 0) ?? "";
  return first.slice(0, 160);
}

function uniqueToolNames(output: AskUserActionOutput): string[] {
  return [...new Set(output.toolNames)].sort();
}

function fixtureFromGroundTruth(value: unknown): AskUserTriggerFixture | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Partial<AskUserTriggerFixture>;
  if (
    typeof record.id !== "string" ||
    typeof record.message !== "string" ||
    (record.expectedDecision !== "ask" && record.expectedDecision !== "noAsk")
  ) {
    return null;
  }
  return record as AskUserTriggerFixture;
}

export function evaluateAskUserTriggerDecision(
  fixture: AskUserTriggerFixture,
  output: AskUserActionOutput,
): AskUserTriggerEvaluation {
  const actualToolNames = uniqueToolNames(output);
  // live 触发评测只覆盖新会话；legacy askUser 兼容由问卷谓词/恢复链测试单独保证。
  const asked = actualToolNames.includes("planDraft");
  const calledLegacyAskUser = actualToolNames.includes("askUser");
  const wroteDraft = actualToolNames.includes("writeDraft");
  const askUserWasAlone = asked && actualToolNames.length === 1;
  const textExcerpt = firstTextExcerpt(output.text);

  if (fixture.expectedDecision === "ask") {
    const ok = asked && askUserWasAlone;
    return {
      score: ok ? 1 : 0,
      actualToolNames,
      asked,
      wroteDraft,
      askUserWasAlone,
      textExcerpt,
      reason: ok
        ? `命中问卷: tools=[${actualToolNames.join(",")}] text="${textExcerpt}"`
        : `应单独调用 planDraft,实际 tools=[${actualToolNames.join(",") || "none"}] text="${textExcerpt}"`,
    };
  }

  const noAskOk = !asked && !calledLegacyAskUser;
  const writeOk = fixture.requireWriteDraft === true ? wroteDraft : !wroteDraft;
  const ok = noAskOk && writeOk;
  return {
    score: ok ? 1 : 0,
    actualToolNames,
    asked,
    wroteDraft,
    askUserWasAlone,
    textExcerpt,
    reason: ok
      ? `命中不问: tools=[${actualToolNames.join(",") || "none"}] text="${textExcerpt}"`
      : `不应调用 planDraft${fixture.requireWriteDraft ? "且应调用 writeDraft" : "且不应调用 writeDraft"},实际 tools=[${
          actualToolNames.join(",") || "none"
        }] text="${textExcerpt}"`,
  };
}

export const askUserTriggerScorer = createScorer({
  id: "askuser-trigger-decision",
  description: "live runEvals 轨:确定性验证首轮写作方向工具 planDraft 触发裁决。",
  type: "agent",
})
  .generateScore(({ run }) => {
    const fixture = fixtureFromGroundTruth(run.groundTruth);
    if (!fixture) return 0;
    return evaluateAskUserTriggerDecision(fixture, extractAgentOutput(run.output)).score;
  })
  .generateReason(({ run }) => {
    const fixture = fixtureFromGroundTruth(run.groundTruth);
    if (!fixture) return "缺少或非法 groundTruth fixture";
    return evaluateAskUserTriggerDecision(fixture, extractAgentOutput(run.output)).reason;
  });

export const askUserTriggerScorers = [askUserTriggerScorer] as const;
