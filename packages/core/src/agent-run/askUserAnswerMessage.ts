import type { CoreMessage } from "ai";
import type {
  AskUserAnswer,
  AskUserAnswerCardItem,
  AskUserQuestion,
  ChatMessage,
  ToolCallSpec,
} from "@qingagent/contract-ts";
import type { SessionState } from "../session/sessionState.js";
import { isPlanDraftTool, isQuestionnaireTool } from "./questionnaireTools.js";

export type AskUserAnswerRecord = Record<string, AskUserAnswer>;

export function askUserAnswerMarker(toolCallId: string): string {
  return `[askUserAnswers:${toolCallId}]`;
}

export function hasAskUserAnswerMessage(
  messages: CoreMessage[],
  toolCallId: string,
): boolean {
  const marker = askUserAnswerMarker(toolCallId);
  return messages.some((message) => (
    message.role === "user" &&
    typeof message.content === "string" &&
    message.content.startsWith(marker)
  ));
}

export function normalizeAskUserAnswers(input: Record<string, unknown>): AskUserAnswerRecord {
  const answers: AskUserAnswerRecord = {};
  for (const [questionId, raw] of Object.entries(input)) {
    if (!raw || typeof raw !== "object") continue;
    const record = raw as Record<string, unknown>;
    const chosen = Array.isArray(record.chosen)
      ? record.chosen.filter((value): value is string =>
          typeof value === "string" && value.trim().length > 0,
        )
      : [];
    const freeText =
      typeof record.freeText === "string" ? normalizeFreeText(record.freeText) : "";
    const numericValue =
      typeof record.numericValue === "number" && Number.isFinite(record.numericValue)
        ? record.numericValue
        : null;
    if (chosen.length === 0 && freeText.length === 0 && numericValue == null) continue;
    answers[questionId] = {
      chosen,
      freeText: freeText.length > 0 ? freeText : null,
      // F4 滑块数值答案
      numericValue,
    };
  }
  return answers;
}

export function findAskUserToolCallSpecInChatHistory(
  chatHistory: ChatMessage[],
  toolCallId: string | null | undefined,
): ToolCallSpec | null {
  if (!toolCallId) return null;
  for (const message of chatHistory) {
    for (const part of message.parts) {
      if (
        part.kind === "toolCall" &&
        part.data.id === toolCallId &&
        isQuestionnaireTool(part.data.name) &&
        part.data.body?.kind === "askUser"
      ) {
        return part.data;
      }
    }
  }
  return null;
}

export function buildAskUserAnswerUserMessage(input: {
  toolCallId: string;
  spec?: ToolCallSpec | null;
  answers: Record<string, unknown>;
}): CoreMessage | null {
  const answers = normalizeAskUserAnswers(input.answers);
  if (Object.keys(answers).length === 0) return null;

  const questions = questionsFromSpec(input.spec);
  const orderedQuestionIds =
    questions.length > 0
      ? questions.map((question) => question.id)
      : Object.keys(answers).sort();
  const questionById = new Map(questions.map((question) => [question.id, question]));
  const emitted = new Set<string>();
  const isPlanDraft = input.spec == null || isPlanDraftTool(input.spec.name);
  const lines: string[] = [
    askUserAnswerMarker(input.toolCallId),
    isPlanDraft ? "我已提交写作方向问卷,回答如下:" : "我已提交问卷,回答如下:",
  ];

  const appendLine = (questionId: string) => {
    const answer = answers[questionId];
    if (!answer || emitted.has(questionId)) return;
    emitted.add(questionId);
    const question = questionById.get(questionId);
    const label = question?.label ?? questionId;
    lines.push(`- ${label}:${formatAnswer(question, answer)}`);
  };

  for (const questionId of orderedQuestionIds) appendLine(questionId);
  for (const questionId of Object.keys(answers).sort()) appendLine(questionId);

  lines.push("请基于这些答案继续,不需要再次确认这些问题。");
  return {
    role: "user",
    content: lines.join("\n"),
  };
}

/**
 * e2e-loop-0704 R13 回归(审核态:放弃后问卷提交后约5秒重弹同类问卷):
 * resume 路径下模型只看得到 raw 答案——chosen 里是 "v2" 这类**选项 value**,而问卷
 * 题面/选项文案由 askUser 工具内的子 LLM 生成、只随 suspend payload 发给了前端,
 * 从未进主模型上下文;带标签的答案 user message(buildAskUserAnswerUserMessage)
 * 也只在**下一轮** fresh turn 才被消费。于是模型收到一份自己解读不了的答卷,
 * 转头再弹一份同类问卷(R13 实锤:resume 后 5s 内新 id、rationale 逐字相同)。
 * 修法遵循铁律"把范本/信息补到模型实际走的那个上下文":把题面 label 与选中项
 * label 回填进 resumeData,模型在 resume 后的 tool-result 里直接读得懂答案。
 * 只加字段不改原有 key:normalizeAskUserAnswers / 前端答案卡按原字段消费不受影响。
 */
export function enrichAskUserResumeAnswersWithLabels(
  answersInput: Record<string, unknown>,
  spec: ToolCallSpec | null | undefined,
): Record<string, unknown> {
  const questions = questionsFromSpec(spec);
  if (questions.length === 0) return answersInput;
  const questionById = new Map(questions.map((question) => [question.id, question]));
  const enriched: Record<string, unknown> = {};
  for (const [questionId, raw] of Object.entries(answersInput)) {
    const question = questionById.get(questionId);
    if (!question || !raw || typeof raw !== "object" || Array.isArray(raw)) {
      enriched[questionId] = raw;
      continue;
    }
    const record = raw as Record<string, unknown>;
    const chosen = Array.isArray(record.chosen)
      ? record.chosen.filter((value): value is string => typeof value === "string")
      : [];
    const chosenLabels = chosen.map((value) => optionLabel(question, value));
    enriched[questionId] = {
      ...record,
      questionLabel: question.label,
      ...(chosenLabels.length > 0 ? { chosenLabels } : {}),
    };
  }
  return enriched;
}

export function appendAskUserAnswerMessageIfMissing(
  state: Pick<SessionState, "messages" | "chatHistory">,
  toolCallId: string | null | undefined,
  answers: Record<string, unknown>,
  spec?: ToolCallSpec | null,
): boolean {
  if (!toolCallId || hasAskUserAnswerMessage(state.messages, toolCallId)) {
    return false;
  }
  const message = buildAskUserAnswerUserMessage({
    toolCallId,
    spec: spec ?? findAskUserToolCallSpecInChatHistory(state.chatHistory, toolCallId),
    answers,
  });
  if (!message) return false;
  state.messages.push(message);
  return true;
}

export function appendMissingAskUserAnswerMessagesFromChatHistory(
  state: Pick<SessionState, "messages" | "chatHistory">,
): number {
  let appended = 0;
  for (const message of state.chatHistory) {
    for (const part of message.parts) {
      if (part.kind !== "toolCall") continue;
      const spec = part.data;
      if (!isQuestionnaireTool(spec.name) || spec.result?.kind !== "askUserAnswers") continue;
      if (appendAskUserAnswerMessageIfMissing(state, spec.id, spec.result.data, spec)) {
        appended++;
      }
    }
  }
  return appended;
}

export function visibleAskUserAnswerMessageId(toolCallId: string): string {
  return `askuser-answer:${toolCallId}`;
}

export function hasVisibleAskUserAnswerMessage(
  state: Pick<SessionState, "chatHistory">,
  toolCallId: string | null | undefined,
): boolean {
  if (!toolCallId) return false;
  const messageId = visibleAskUserAnswerMessageId(toolCallId);
  return state.chatHistory.some((message) => message.id === messageId);
}

export function buildAskUserAnswerCardItems(
  spec: ToolCallSpec | null | undefined,
  answersInput: Record<string, unknown>,
): AskUserAnswerCardItem[] {
  const answers = normalizeAskUserAnswers(answersInput);
  const answerIds = Object.keys(answers);
  if (answerIds.length === 0) return [];

  const questions = questionsFromSpec(spec);
  const questionById = new Map(questions.map((question) => [question.id, question]));
  const orderedIds =
    questions.length > 0
      ? [...questions.map((question) => question.id), ...answerIds.sort()]
      : answerIds.sort();
  const seen = new Set<string>();
  const items: AskUserAnswerCardItem[] = [];

  for (const questionId of orderedIds) {
    if (seen.has(questionId)) continue;
    seen.add(questionId);
    const answer = answers[questionId];
    if (!answer) continue;
    const question = questionById.get(questionId);
    const formatted = formatAnswerCardItem(question, answer);
    items.push({
      questionId,
      questionLabel: question?.label ?? questionId,
      answerText: formatted.answerText,
      selectedOptionLabels: formatted.selectedOptionLabels,
      freeText: formatted.freeText,
      numericText: formatted.numericText,
    });
  }

  return items;
}

/**
 * fullpage 开场问卷(写作方向建模)提交后,对话里会有两处等价内容:
 * ① askUser fullpage 工具调用置 done 后渲染的「已提交答案」汇总卡(ToolCallRow);
 * ② 这里生成的可见答卷卡「已提交写作方向问卷」(askUserAnswerCard)。
 * 用户走查裁定:保留「已提交答案」那层(以用户名义的提交,正统),去掉重复的可见卡。
 * 因此 fullpage 模式不再生成可见卡;overlay 内联反问(写作中途澄清)工具调用只走
 * 一行状态、没有汇总卡,仍保留可见卡以承载答案展示与刷新复原。
 */
function isFullpageAskUserSpec(spec: ToolCallSpec | null | undefined): boolean {
  return spec?.body.kind === "askUser" && spec.body.data.mode?.kind === "fullpage";
}

export function buildVisibleAskUserAnswerMessage(
  toolCallId: string | null | undefined,
  answersInput: Record<string, unknown>,
  spec: ToolCallSpec | null | undefined,
): ChatMessage | null {
  if (!toolCallId) return null;
  if (isFullpageAskUserSpec(spec)) return null;
  const items = buildAskUserAnswerCardItems(spec, answersInput);
  if (items.length === 0) return null;

  return {
    id: visibleAskUserAnswerMessageId(toolCallId),
    role: { kind: "user" },
    ts: new Date().toISOString(),
    parts: [
      {
        kind: "askUserAnswerCard",
        data: {
          toolCallId,
          title: spec == null || isPlanDraftTool(spec.name)
            ? "已提交写作方向问卷"
            : "已提交问卷",
          items,
        },
      },
    ],
    chips: null,
  };
}

export function appendMissingVisibleAskUserAnswerMessagesFromChatHistory(
  state: Pick<SessionState, "chatHistory">,
): number {
  let appended = 0;
  for (const message of [...state.chatHistory]) {
    for (const part of message.parts) {
      if (part.kind !== "toolCall") continue;
      const spec = part.data;
      if (!isQuestionnaireTool(spec.name) || spec.result?.kind !== "askUserAnswers") continue;
      if (hasVisibleAskUserAnswerMessage(state, spec.id)) continue;
      const visible = buildVisibleAskUserAnswerMessage(spec.id, spec.result.data, spec);
      if (!visible) continue;
      state.chatHistory.push(visible);
      appended++;
    }
  }
  return appended;
}

function questionsFromSpec(spec: ToolCallSpec | null | undefined): AskUserQuestion[] {
  if (spec?.body.kind !== "askUser") return [];
  return Array.isArray(spec.body.data.questions) ? spec.body.data.questions : [];
}

function formatAnswer(question: AskUserQuestion | undefined, answer: AskUserAnswer): string {
  const selectedLabels = answer.chosen.map((value) => optionLabel(question, value));
  const segments = selectedLabels.length > 0 ? [selectedLabels.join("、")] : [];
  // F4 滑块:数值答案;命中最大值时用 aboveLabel(「X 以上」语义)。
  if (answer.numericValue != null) {
    const slider = question?.slider ?? null;
    const atMax = slider && answer.numericValue >= slider.max && slider.aboveLabel;
    segments.unshift(atMax ? slider.aboveLabel! : `${answer.numericValue}${slider?.unit ?? ""}`);
  }
  const freeText = normalizeFreeText(answer.freeText);
  if (freeText) segments.push(`补充:${freeText}`);
  return segments.length > 0 ? segments.join(";") : "未作答";
}

function optionLabel(question: AskUserQuestion | undefined, value: string): string {
  const option = question?.options.find((candidate) => candidate.value === value);
  return option?.label ?? value;
}

function normalizeFreeText(value: string | null): string {
  return (value ?? "").replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
}

function formatAnswerCardItem(
  question: AskUserQuestion | undefined,
  answer: AskUserAnswer,
): {
  answerText: string;
  selectedOptionLabels: string[];
  freeText: string | null;
  numericText: string | null;
} {
  const selectedLabels = answer.chosen.map((value) => optionLabel(question, value));
  const segments = selectedLabels.length > 0 ? [selectedLabels.join("、")] : [];
  let numericText: string | null = null;
  if (answer.numericValue != null) {
    const slider = question?.slider ?? null;
    const atMax = slider && answer.numericValue >= slider.max && slider.aboveLabel;
    numericText = atMax ? slider.aboveLabel! : `${answer.numericValue}${slider?.unit ?? ""}`;
    segments.unshift(numericText);
  }
  const freeText = normalizeFreeText(answer.freeText);
  if (freeText) {
    segments.push(question?.kind.kind === "text" || segments.length === 0 ? freeText : `补充：${freeText}`);
  }
  return {
    answerText: segments.length > 0 ? segments.join("；") : "未作答",
    selectedOptionLabels: selectedLabels,
    freeText: freeText.length > 0 ? freeText : null,
    numericText,
  };
}
