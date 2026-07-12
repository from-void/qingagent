import { createScorer } from "@mastra/core/evals";
import type { CoreMessage } from "ai";
import { buildAskUserAnswerUserMessage } from "../agent-run/askUserAnswerMessage.js";
import { isPlanDraftTool } from "../agent-run/questionnaireTools.js";

export interface AskUserAnswerWordingInput {
  toolCallId: string;
  request: string;
  answers: Record<string, unknown>;
}

export interface AskUserActionOutput {
  toolNames: string[];
  text: string;
}

const FORM_TALK = /请?填写?(写作方向)?(确认)?表单|已弹出.{0,8}表单|请在右侧填写/;

export function buildAskUserResumeMessages(input: AskUserAnswerWordingInput): CoreMessage[] {
  const answerMessage = buildAskUserAnswerUserMessage({
    toolCallId: input.toolCallId,
    spec: null,
    answers: input.answers,
  });
  if (!answerMessage || typeof answerMessage.content !== "string") {
    throw new Error(`planDraft answer message is empty for ${input.toolCallId}`);
  }
  return [
    { role: "user", content: input.request },
    { role: "assistant", content: "好的,我先确认一下你的写作方向,稍后开始写。" },
    answerMessage,
  ];
}

export function evaluateAskUserNoReask(input: AskUserAnswerWordingInput, output: AskUserActionOutput): {
  ok: boolean;
  askedAgain: boolean;
  formTalk: boolean;
  answerMessageOk: boolean;
} {
  const messages = buildAskUserResumeMessages(input);
  const answerMessage = messages.at(-1);
  const answerContent = typeof answerMessage?.content === "string" ? answerMessage.content : "";
  const askedAgain = output.toolNames.some(isPlanDraftTool);
  const formTalk = FORM_TALK.test(output.text);
  const answerMessageOk =
    answerContent.includes(`[askUserAnswers:${input.toolCallId}]`) &&
    answerContent.includes("不需要再次确认这些问题");
  return {
    ok: !askedAgain && !formTalk && answerMessageOk,
    askedAgain,
    formTalk,
    answerMessageOk,
  };
}

export const askUserNoReaskScorer = createScorer<AskUserAnswerWordingInput, AskUserActionOutput>({
  id: "askuser-no-reask",
  description: "验证写作方向答案 user message 不诱导模型重新 planDraft 或输出表单话术。",
})
  .generateScore(({ run }) => evaluateAskUserNoReask(run.input!, run.output).ok ? 1 : 0)
  .generateReason(({ run, score }) => {
    if (score === 1) return "未重新 planDraft,且无表单话术";
    const result = evaluateAskUserNoReask(run.input!, run.output);
    return `askedAgain=${result.askedAgain} formTalk=${result.formTalk} answerMessageOk=${result.answerMessageOk}`;
  });

export const askUserWriteDraftFollowthroughScorer = createScorer<AskUserAnswerWordingInput, AskUserActionOutput>({
  id: "askuser-write-draft-followthrough",
  description: "验证问卷答案后模型继续写作,优先调用 writeDraft 而不是停在表单对话。",
})
  .generateScore(({ run }) => run.output.toolNames.includes("writeDraft") ? 1 : 0)
  .generateReason(({ run, score }) => (
    score === 1 ? "已调用 writeDraft" : `未调用 writeDraft, tools=[${run.output.toolNames.join(",")}]`
  ));

function walkUnknown(value: unknown, visit: (record: Record<string, unknown>) => void): void {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) walkUnknown(item, visit);
    return;
  }
  const record = value as Record<string, unknown>;
  visit(record);
  for (const child of Object.values(record)) walkUnknown(child, visit);
}

export function extractAgentOutput(output: unknown): AskUserActionOutput {
  const texts: string[] = [];
  const toolNames = new Set<string>();
  walkUnknown(output, (record) => {
    if (typeof record.text === "string") texts.push(record.text);
    if (typeof record.content === "string") texts.push(record.content);
    if (typeof record.textDelta === "string") texts.push(record.textDelta);
    if (typeof record.toolName === "string") toolNames.add(record.toolName);
    if (
      typeof record.name === "string" &&
      (record.type === "tool-call" || record.type === "tool-invocation")
    ) {
      toolNames.add(record.name);
    }
  });
  return { toolNames: [...toolNames], text: texts.join("\n") };
}

export const askUserLiveNoReaskScorer = createScorer({
  id: "askuser-live-no-reask",
  description: "live runEvals 轨:从真实 Agent 输出中验证不重新 planDraft/不说表单话术。",
  type: "agent",
})
  .generateScore(({ run }) => {
    const expected = run.groundTruth as AskUserAnswerWordingInput | undefined;
    if (!expected) return 0;
    return evaluateAskUserNoReask(expected, extractAgentOutput(run.output)).ok ? 1 : 0;
  })
  .generateReason(({ run, score }) => {
    const output = extractAgentOutput(run.output);
    if (score === 1) return "真实 Agent 未重新 planDraft";
    return `tools=[${output.toolNames.join(",")}] text=${output.text.slice(0, 120)}`;
  });

export const askUserLiveWriteDraftFollowthroughScorer = createScorer({
  id: "askuser-live-write-draft-followthrough",
  description: "live runEvals 轨:从真实 Agent 输出中验证问卷答案后继续调用 writeDraft。",
  type: "agent",
})
  .generateScore(({ run }) => {
    const output = extractAgentOutput(run.output);
    return output.toolNames.includes("writeDraft") ? 1 : 0;
  })
  .generateReason(({ run, score }) => {
    const output = extractAgentOutput(run.output);
    return score === 1 ? "真实 Agent 已调用 writeDraft" : `未调用 writeDraft, tools=[${output.toolNames.join(",")}]`;
  });

export const askUserScorers = [
  askUserNoReaskScorer,
  askUserWriteDraftFollowthroughScorer,
  askUserLiveNoReaskScorer,
  askUserLiveWriteDraftFollowthroughScorer,
] as const;
