import type { RequestContext } from "@mastra/core/request-context";
import { streamText } from "../llm/streamTextCompat.js";
import { extractJsonArray } from "../utils/extractJsonArray.js";
import {
  getDeepseekModel,
  getSessionSnapshot,
  resolveModelParams,
  type BranchMessage,
  type SessionSnapshot,
} from "../llm/modelConfig.js";
import { runSideChannel } from "../llm/sideChannel.js";
import { repairModelJson } from "../llm/repairToolCallJson.js";

export interface GeneratedQuestion {
  id: string;
  label: string;
  kind: "single" | "multi" | "text" | "slider";
  options: Array<{
    value: string;
    label: string;
    description?: string | null;
    preview?: string | null;
  }>;
  placeholder?: string | null;
  slider?: unknown;
}

export interface GenerateQuestionsInput {
  mode: "initial" | "additional";
  requestContext?: RequestContext;
  rationale?: string;
  topic?: string;
  conversationSummary?: string;
  currentQuestions?: Array<{
    id: string;
    label: string;
    kind: { kind: string } | string;
    options: Array<{ value: string; label: string }>;
  }>;
  currentAnswers?: Record<string, { chosen?: string[]; freeText?: string | null }>;
  abortSignal?: AbortSignal;
  onProgress?: (questions: GeneratedQuestion[]) => void | Promise<void>;
}

export interface GenerateQuestionsResult {
  questions: GeneratedQuestion[];
  transport: "branch" | "fallback";
  branchFailure: string | null;
  toolCallRetries: number;
}

interface QuestionBranchHistory {
  generation: number;
  epoch: number;
  messages: BranchMessage[];
  touchedAt: number;
}

const questionBranches = new Map<string, QuestionBranchHistory>();
const QUESTION_BRANCH_TTL_MS = 30 * 60 * 1000;
const MAX_QUESTION_BRANCHES = 256;

function pruneQuestionBranches(): void {
  const now = Date.now();
  for (const [sessionId, history] of questionBranches) {
    if (now - history.touchedAt > QUESTION_BRANCH_TTL_MS) questionBranches.delete(sessionId);
  }
  while (questionBranches.size > MAX_QUESTION_BRANCHES) {
    const oldest = questionBranches.keys().next().value as string | undefined;
    if (!oldest) break;
    questionBranches.delete(oldest);
  }
}

export function clearQuestionBranch(sessionId: string): void {
  questionBranches.delete(sessionId);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function normalizeQuestion(raw: unknown, index = 0): GeneratedQuestion | null {
  if (!isRecord(raw)) return null;
  if (typeof raw.label !== "string" || !raw.label.trim()) return null;
  const rawKind = isRecord(raw.kind) ? raw.kind.kind : raw.kind;
  const kind = new Set(["single", "multi", "text", "slider"]).has(String(rawKind))
    ? rawKind as GeneratedQuestion["kind"]
    : Array.isArray(raw.options) && raw.options.length > 0 ? "single" : "text";
  const options = Array.isArray(raw.options)
    ? raw.options.flatMap((option) => {
        if (!isRecord(option) || typeof option.value !== "string" || typeof option.label !== "string") {
          return [];
        }
        return [{
          value: option.value,
          label: option.label,
          ...(typeof option.description === "string" || option.description === null
            ? { description: option.description }
            : {}),
          ...(typeof option.preview === "string" || option.preview === null
            ? { preview: option.preview }
            : {}),
        }];
      })
    : [];
  return {
    id: typeof raw.id === "string" && raw.id.trim() ? raw.id : `q${index + 1}`,
    label: raw.label,
    kind,
    options,
    ...(typeof raw.placeholder === "string" || raw.placeholder === null
      ? { placeholder: raw.placeholder }
      : {}),
    ...(kind === "slider" && "slider" in raw ? { slider: raw.slider } : {}),
  };
}

export function parseGeneratedQuestions(raw: string): GeneratedQuestion[] | null {
  const extracted = extractJsonArray(raw);
  if (!extracted) return null;
  const repaired = repairModelJson(extracted);
  try {
    const parsed = JSON.parse(repaired.ok ? repaired.json : extracted);
    if (!Array.isArray(parsed) || parsed.length === 0) return null;
    const questions = parsed.map((question, index) => normalizeQuestion(question, index));
    return questions.every((question): question is GeneratedQuestion => question !== null)
      ? questions
      : null;
  } catch {
    return null;
  }
}

export function parsePartialGeneratedQuestions(raw: string): GeneratedQuestion[] {
  const start = raw.indexOf("[");
  if (start < 0) return [];
  const questions: GeneratedQuestion[] = [];
  const content = raw.slice(start + 1);
  let position = 0;
  while (position < content.length) {
    while (position < content.length && /[\s,]/.test(content[position]!)) position += 1;
    if (position >= content.length || content[position] === "]") break;
    // 只沿最外层问题数组顺序解析，避免从前导脏数组或 options 子对象误造/漏造题目。
    if (content[position] !== "{") break;
    const objectEnd = findMatchingBrace(content, position);
    if (objectEnd < 0) {
      const partial = normalizePartialQuestion(content.slice(position), questions.length);
      if (partial) questions.push(partial);
      break;
    }
    try {
      const normalized = normalizeQuestion(
        JSON.parse(content.slice(position, objectEnd + 1)),
        questions.length,
      );
      if (normalized) questions.push(normalized);
    } catch {
      // 已闭合但畸形的问题不影响此前成功解析的题目。
    }
    position = objectEnd + 1;
  }
  return questions;
}

function decodeJsonStringContent(content: string): string | null {
  try {
    const parsed = JSON.parse(`"${content}"`);
    return typeof parsed === "string" ? parsed : null;
  } catch {
    return null;
  }
}

function extractTopLevelStringField(
  partial: string,
  field: string,
  options: { allowEmpty?: boolean } = {},
): string | null {
  const key = `"${field}"`;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < partial.length; index += 1) {
    const char = partial[index]!;
    if (!inString && depth === 1 && partial.startsWith(key, index)) {
      let cursor = index + key.length;
      while (cursor < partial.length && /\s/.test(partial[cursor]!)) cursor += 1;
      if (partial[cursor] !== ":") continue;
      cursor += 1;
      while (cursor < partial.length && /\s/.test(partial[cursor]!)) cursor += 1;
      if (partial[cursor] !== '"') return null;
      cursor += 1;
      let value = "";
      let valueEscaped = false;
      for (; cursor < partial.length; cursor += 1) {
        const valueChar = partial[cursor]!;
        if (valueEscaped) {
          value += `\\${valueChar}`;
          valueEscaped = false;
        } else if (valueChar === "\\") {
          valueEscaped = true;
        } else if (valueChar === '"') {
          const decoded = decodeJsonStringContent(value);
          return decoded !== null && (options.allowEmpty || decoded.length > 0) ? decoded : null;
        } else {
          value += valueChar;
        }
      }
      return null;
    }
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\" && inString) {
      escaped = true;
      continue;
    }
    if (char === '"') inString = !inString;
    if (inString) continue;
    if (char === "{") depth += 1;
    if (char === "}") depth -= 1;
  }
  return null;
}

function findMatchingBrace(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\" && inString) {
      escaped = true;
      continue;
    }
    if (char === '"') inString = !inString;
    if (inString) continue;
    if (char === "{") depth += 1;
    if (char === "}" && --depth === 0) return index;
  }
  return -1;
}

function normalizePartialQuestion(partial: string, index: number): GeneratedQuestion | null {
  const label = extractTopLevelStringField(partial, "label");
  if (label === null) return null;
  const rawKind = extractTopLevelStringField(partial, "kind");
  if (rawKind !== "single" && rawKind !== "multi" && rawKind !== "text") return null;
  const id = extractTopLevelStringField(partial, "id") ?? `q${index + 1}`;
  const options: GeneratedQuestion["options"] = [];
  const optionsField = partial.indexOf('"options"');
  if (optionsField >= 0) {
    const arrayStart = partial.indexOf("[", optionsField);
    if (arrayStart >= 0) {
      const optionContent = partial.slice(arrayStart + 1);
      let position = 0;
      while (position < optionContent.length) {
        while (position < optionContent.length && /[\s,]/.test(optionContent[position]!)) position += 1;
        if (position >= optionContent.length || optionContent[position] === "]") break;
        if (optionContent[position] !== "{") break;
        const optionEnd = findMatchingBrace(optionContent, position);
        if (optionEnd < 0) break;
        try {
          const parsed = JSON.parse(optionContent.slice(position, optionEnd + 1));
          if (isRecord(parsed) && typeof parsed.value === "string" && typeof parsed.label === "string") {
            options.push({
              value: parsed.value,
              label: parsed.label,
              ...(typeof parsed.description === "string" || parsed.description === null
                ? { description: parsed.description }
                : {}),
              ...(typeof parsed.preview === "string" || parsed.preview === null
                ? { preview: parsed.preview }
                : {}),
            });
          }
        } catch {
          // 畸形 option 只跳过自身，保留题干和此前已完成选项。
        }
        position = optionEnd + 1;
      }
    }
  }
  return {
    id,
    label,
    kind: rawKind,
    options,
    placeholder: extractTopLevelStringField(partial, "placeholder", { allowEmpty: true }) ?? "",
  };
}

async function emitQuestionProgress(
  input: GenerateQuestionsInput,
  questions: GeneratedQuestion[],
  state: { signature: string },
): Promise<void> {
  const signature = JSON.stringify(questions);
  if (!questions.length || signature === state.signature) return;
  state.signature = signature;
  await input.onProgress?.(questions);
}

function currentQuestionSummary(input: GenerateQuestionsInput): string {
  return (input.currentQuestions ?? []).map((question) => {
    const answer = input.currentAnswers?.[question.id];
    const answerText = answer
      ? [...(answer.chosen ?? []), ...(answer.freeText ? [answer.freeText] : [])].join(", ") || "未回答"
      : "未回答";
    return `- ${question.label} → ${answerText}`;
  }).join("\n");
}

function fallbackConversationSummary(input: GenerateQuestionsInput): string {
  if (input.conversationSummary?.trim()) return input.conversationSummary.trim();
  const messages = input.requestContext?.get("messages");
  if (!Array.isArray(messages)) return "（无可用主对话摘要）";
  return messages
    .filter((message): message is Record<string, unknown> => isRecord(message) &&
      (message.role === "user" || message.role === "assistant"))
    .slice(-10)
    .map((message) => {
      const content = typeof message.content === "string"
        ? message.content
        : Array.isArray(message.content)
          ? message.content.flatMap((part) => isRecord(part) && typeof part.text === "string" ? [part.text] : []).join(" ")
          : "";
      return `${message.role === "user" ? "用户" : "助手"}: ${content.slice(0, 500)}`;
    })
    .filter((line) => !line.endsWith(": "))
    .join("\n") || "（无可用主对话摘要）";
}

function initialPrompt(input: GenerateQuestionsInput): string {
  return `不要调用任何工具。你是一位写作需求分析专家。根据主对话以及下面的写作方向，直接生成 2-4 个问卷问题，帮助确认用户的写作需求。

写作方向和已知信息：
${input.rationale ?? ""}

具体主题：
${input.topic ?? ""}

只输出纯 JSON 数组，不要解释。格式：
[{"id":"q-theme","label":"问题文本","kind":"single","options":[{"value":"v1","label":"选项1","description":"描述"}],"placeholder":""},{"id":"q-length","label":"目标字数","kind":"slider","options":[],"slider":{"min":200,"max":3000,"step":100,"unit":"字","aboveLabel":"3000字以上"}},{"id":"q-note","label":"补充问题","kind":"text","options":[],"placeholder":"提示文字"}]

要求：id 唯一且为 q-{简短英文主题}；kind 只能是 single/multi/text/slider；选择题不超过 4 个选项；文本题/滑块题 options 为空；slider 仅用于连续量，范围必须合理，字数最小不低于 50，最大值滑到头必须用 aboveLabel 表达“X以上”；使用自然中文；不重复询问主对话中已提供的信息；至少一个 text 开放题；问题与选项不得出现 run_js、readDraft 等英文工具或函数标识符，需要提及能力时改用“运行脚本”“读取草稿”等中文；最外层必须是问题数组。`;
}

function additionalPrompt(input: GenerateQuestionsInput): string {
  return `不要调用任何工具。沿用你刚才已经生成的问题，再生成 1-3 个补充问题，避开所有已有问题和已确认信息。只输出新增问题的纯 JSON 数组，不要解释。

当前问卷及回答：
${currentQuestionSummary(input)}

补充对话摘要：
${input.conversationSummary ?? ""}

格式：
[{"id":"q-extra-tone","label":"问题文本","kind":"single","options":[{"value":"v1","label":"选项1","description":"描述"}],"placeholder":""},{"id":"q-extra-note","label":"补充问题","kind":"text","options":[],"placeholder":"提示文字"}]

要求：id 使用 q-extra-{简短英文主题}；kind 只能是 single/multi/text；选择题不超过 4 个选项；文本题 options 为空；使用自然中文；不得重复已有问题。`;
}

function fallbackPrompt(input: GenerateQuestionsInput): string {
  if (input.mode === "initial") {
    return `${initialPrompt(input)
      .replace(/^不要调用任何工具。/, "")
      .replace("根据主对话以及下面的写作方向", "根据下面的主对话摘要和写作方向")}

主对话摘要：
${fallbackConversationSummary(input)}`;
  }
  // 保持旧 askMore 的 nested kind 表示，解析器同时兼容 flat/nested。
  return `你是一位写作需求分析专家。根据以下对话上下文和已有的问卷问题及回答，生成 1-3 个补充问题，帮助更好地理解用户的写作需求。

对话摘要：
${input.conversationSummary ?? ""}

已有问题及回答：
${currentQuestionSummary(input)}

直接输出纯 JSON 数组，不要有任何其他内容。格式：
[{"id":"q-extra-tone","label":"问题文本","kind":{"kind":"single"},"options":[{"value":"v1","label":"选项1","description":"描述"}],"placeholder":""},{"id":"q-extra-note","label":"补充问题","kind":{"kind":"text"},"options":[],"placeholder":"提示文字"}]

要求：问题应覆盖尚未涉及的方面且不重复已有问题；id 为 q-extra-{简短英文主题}；kind 只能是 single/multi/text；选择题不超过 4 个选项；文本题 options 为空数组；使用中文。`;
}

function prepareBranch(
  input: GenerateQuestionsInput,
  snapshot: SessionSnapshot,
): { steeringTail: BranchMessage[]; progressState: { signature: string } } {
  pruneQuestionBranches();
  const prompt = input.mode === "initial" ? initialPrompt(input) : additionalPrompt(input);
  let steeringTail: BranchMessage[] = [{ role: "user", content: prompt }];
  if (input.mode === "additional") {
    const history = questionBranches.get(snapshot.sessionId);
    if (history && history.generation === snapshot.generation && history.epoch === snapshot.epoch) {
      steeringTail = [...history.messages, { role: "user", content: prompt }];
    }
  }
  return { steeringTail, progressState: { signature: "" } };
}

async function runFallback(input: GenerateQuestionsInput): Promise<GeneratedQuestion[]> {
  let last: GeneratedQuestion[] = [];
  const progressState = { signature: "" };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const result = streamText({
      model: getDeepseekModel(input.requestContext, "flash", {
        callSite: input.mode === "initial" ? "planDraft" : "askMore",
      }),
      ...resolveModelParams(input.requestContext),
      abortSignal: input.abortSignal,
      prompt: fallbackPrompt(input),
    });
    let raw = "";
    for await (const delta of result.textStream) {
      raw += delta;
      const partial = parsePartialGeneratedQuestions(raw);
      if (partial.length > 0) last = partial;
      await emitQuestionProgress(input, partial, progressState);
    }
    const parsed = parseGeneratedQuestions(raw);
    if (parsed) {
      last = parsed;
      await emitQuestionProgress(input, parsed, progressState);
      break;
    }
  }
  return last;
}

function rememberFallbackQuestions(
  snapshot: SessionSnapshot,
  input: GenerateQuestionsInput,
  questions: GeneratedQuestion[],
): void {
  if (questions.length === 0) return;
  const prompt = input.mode === "initial" ? initialPrompt(input) : additionalPrompt(input);
  const previous = input.mode === "additional" ? questionBranches.get(snapshot.sessionId) : null;
  const prefix = previous && previous.generation === snapshot.generation && previous.epoch === snapshot.epoch
    ? previous.messages
    : [];
  const messages: BranchMessage[] = [
    ...prefix,
    { role: "user", content: prompt },
    { role: "assistant", content: JSON.stringify(questions) },
  ];
  questionBranches.delete(snapshot.sessionId);
  questionBranches.set(snapshot.sessionId, {
    generation: snapshot.generation,
    epoch: snapshot.epoch,
    messages,
    touchedAt: Date.now(),
  });
}

/** 通用出题入口：优先借道主链快照，任何单次分支失败都完整降级到原独立模型路径。 */
export async function generateQuestions(input: GenerateQuestionsInput): Promise<GenerateQuestionsResult> {
  if (input.abortSignal?.aborted) throw new DOMException("Question generation aborted", "AbortError");
  const snapshot = getSessionSnapshot(input.requestContext);
  const prepared = snapshot ? prepareBranch(input, snapshot) : null;
  let lastPartial: GeneratedQuestion[] = [];
  let branchText = "";
  const result = await runSideChannel({
    callSite: input.mode === "initial" ? "planDraft" : "askMore",
    requestContext: input.requestContext,
    steeringTail: prepared?.steeringTail ?? (input.mode === "initial" ? initialPrompt(input) : additionalPrompt(input)),
    abortSignal: input.abortSignal,
    streamTextDeltas: true,
    onTextDelta: async (_delta, accumulated) => {
      const partial = parsePartialGeneratedQuestions(accumulated);
      if (partial.length > 0) lastPartial = partial;
      if (prepared) await emitQuestionProgress(input, partial, prepared.progressState);
    },
    parse: (text) => {
      branchText = text;
      const questions = parseGeneratedQuestions(text) ?? lastPartial;
      return questions.length > 0 ? questions : null;
    },
    fallback: async () => {
      const questions = await runFallback(input);
      if (snapshot) rememberFallbackQuestions(snapshot, input, questions);
      return questions;
    },
  });
  if (result.transport === "branch" && snapshot && prepared) {
    questionBranches.delete(snapshot.sessionId);
    questionBranches.set(snapshot.sessionId, {
      generation: snapshot.generation,
      epoch: snapshot.epoch,
      messages: [...prepared.steeringTail, { role: "assistant", content: branchText }],
      touchedAt: Date.now(),
    });
    await emitQuestionProgress(input, result.value, prepared.progressState);
  }
  return {
    questions: result.value,
    transport: result.transport,
    branchFailure: result.branchFailure,
    toolCallRetries: result.toolCallRetries,
  };
}
