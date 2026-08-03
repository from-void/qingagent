import type { AiBlock, AiRun } from "@qingagent/pm-schema";

const DEFAULT_XHS_TOPIC_TAG_LIMIT = 5;
const NUMBER_SOURCE = String.raw`(?:\d{1,3}|[零〇一二两三四五六七八九十百]{1,5})`;
const TOPIC_LABEL_SOURCE = String.raw`(?:个\s*)?(?:相关\s*)?(?:话题\s*)?标签`;
const COUNT_SUFFIX_SOURCE = String.raw`(?:个(?!\s*(?:字|字符))|(?=\s*(?:$|[，。；、,!！?？\n])))`;
const TOPIC_TAG_PATTERN = /#[\p{L}\p{N}_·-]+/gu;

function parseChineseInteger(value: string): number | null {
  if (/^\d+$/u.test(value)) return Number(value);
  const digits: Record<string, number> = {
    零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4,
    五: 5, 六: 6, 七: 7, 八: 8, 九: 9,
  };
  let total = 0;
  let current = 0;
  for (const char of value) {
    if (char === "十" || char === "百") {
      const unit = char === "十" ? 10 : 100;
      total += (current || 1) * unit;
      current = 0;
      continue;
    }
    const digit = digits[char];
    if (digit === undefined) return null;
    current = digit;
  }
  return total + current;
}

function collectLimits(
  prompt: string,
  pattern: RegExp,
  numberGroup: number,
  options: { skipLowerBound?: boolean } = {},
): number[] {
  const limits: number[] = [];
  for (const match of prompt.matchAll(pattern)) {
    if (options.skipLowerBound) {
      const prefix = prompt.slice(Math.max(0, (match.index ?? 0) - 5), match.index);
      const suffix = prompt.slice((match.index ?? 0) + match[0].length, (match.index ?? 0) + match[0].length + 3);
      if (/(?:至少|不少于|不低于)\s*$/u.test(prefix) || /^\s*(?:以上|起)/u.test(suffix)) {
        continue;
      }
    }
    const value = parseChineseInteger(match[numberGroup] ?? "");
    if (value !== null && Number.isSafeInteger(value) && value >= 0) limits.push(value);
  }
  return limits;
}

/** 从小红书补充要求中提取标签上限；没有显式数量时执行默认 3-5 个的上限 5。 */
export function resolveXhsTopicTagLimit(privatePrompt: string): number {
  const rangePattern = new RegExp(
    `(${NUMBER_SOURCE})\\s*(?:到|至|[-~～—–])\\s*(${NUMBER_SOURCE})\\s*${TOPIC_LABEL_SOURCE}`,
    "gu",
  );
  const leadingMaximumPattern = new RegExp(
    `(?:最多|至多|不超过|不得超过|上限(?:为|是|[:：])?|控制在)\\s*(${NUMBER_SOURCE})\\s*${TOPIC_LABEL_SOURCE}`,
    "gu",
  );
  const trailingMaximumPattern = new RegExp(
    `(?:话题\\s*)?标签(?:数量|总数)?\\s*(?:最多|至多|不超过|不得超过|上限(?:为|是|[:：])?)\\s*(${NUMBER_SOURCE})\\s*${COUNT_SUFFIX_SOURCE}`,
    "gu",
  );
  const contextualMaximumPattern = new RegExp(
    `(?:话题\\s*)?标签[^。！？\\n]{0,12}?(?:最多|至多|不超过|不得超过|上限(?:为|是|[:：])?)\\s*(${NUMBER_SOURCE})\\s*${COUNT_SUFFIX_SOURCE}`,
    "gu",
  );
  const exactAfterNumberPattern = new RegExp(
    `(${NUMBER_SOURCE})\\s*${TOPIC_LABEL_SOURCE}`,
    "gu",
  );
  const exactAfterLabelPattern = new RegExp(
    `(?:话题\\s*)?标签(?:数量|总数)?\\s*(?:为|是|[:：])?\\s*(${NUMBER_SOURCE})\\s*${COUNT_SUFFIX_SOURCE}`,
    "gu",
  );

  const limits = [
    ...collectLimits(privatePrompt, rangePattern, 2),
    ...collectLimits(privatePrompt, leadingMaximumPattern, 1),
    ...collectLimits(privatePrompt, trailingMaximumPattern, 1),
    ...collectLimits(privatePrompt, contextualMaximumPattern, 1),
    ...collectLimits(privatePrompt, exactAfterNumberPattern, 1, { skipLowerBound: true }),
    ...collectLimits(privatePrompt, exactAfterLabelPattern, 1, { skipLowerBound: true }),
  ];
  return limits.length > 0 ? Math.min(...limits) : DEFAULT_XHS_TOPIC_TAG_LIMIT;
}

type RemovalRange = { start: number; end: number };

function capRuns(
  runs: AiRun[],
  limit: number,
  state: { seen: number; removed: number },
): AiRun[] {
  let visibleText = "";
  const textSegments: Array<{ runIndex: number; start: number; end: number }> = [];
  runs.forEach((run, runIndex) => {
    if ("text" in run) {
      const start = visibleText.length;
      visibleText += run.text;
      textSegments.push({ runIndex, start, end: visibleText.length });
    } else {
      // 防止脚注两侧的文本被拼成一个并不存在的话题标签。
      visibleText += "\uFFFC";
    }
  });

  const removals: RemovalRange[] = [];
  for (const match of visibleText.matchAll(TOPIC_TAG_PATTERN)) {
    state.seen += 1;
    if (state.seen <= limit) continue;
    removals.push({ start: match.index, end: match.index + match[0].length });
    state.removed += 1;
  }
  if (removals.length === 0) return runs;

  const nextRuns = runs.map((run) => ({ ...run }));
  for (const segment of textSegments) {
    const original = runs[segment.runIndex];
    if (!original || !("text" in original)) continue;
    let text = "";
    let cursor = segment.start;
    for (const removal of removals) {
      const start = Math.max(segment.start, removal.start);
      const end = Math.min(segment.end, removal.end);
      if (start >= end) continue;
      text += visibleText.slice(cursor, start);
      cursor = end;
    }
    text += visibleText.slice(cursor, segment.end);
    nextRuns[segment.runIndex] = { ...original, text };
  }
  return nextRuns.filter((run) => !("text" in run) || run.text.length > 0);
}

function capBlock(
  block: AiBlock,
  limit: number,
  state: { seen: number; removed: number },
): void {
  if ("runs" in block && block.runs) block.runs = capRuns(block.runs, limit, state);
  if (block.type === "bulletList" || block.type === "orderedList" || block.type === "taskList") {
    for (const item of block.items) {
      item.runs = capRuns(item.runs, limit, state);
      item.children?.forEach((child) => capBlock(child, limit, state));
    }
  } else if (block.type === "table") {
    for (const row of block.rows) {
      for (const cell of row.cells) cell.blocks.forEach((child) => capBlock(child, limit, state));
    }
  } else if (block.type === "columnList") {
    for (const column of block.columns) column.blocks.forEach((child) => capBlock(child, limit, state));
  } else if ((block.type === "blockquote" || block.type === "callout") && block.blocks) {
    block.blocks.forEach((child) => capBlock(child, limit, state));
  }
}

/** 按阅读顺序机械保留前 N 个 #话题；只处理正文 run，不碰代码、图表源码或属性。 */
export function capXhsTopicTags(
  blocks: AiBlock[],
  limit: number,
): { topicCount: number; removedCount: number } {
  if (!Number.isSafeInteger(limit) || limit < 0) return { topicCount: 0, removedCount: 0 };
  const state = { seen: 0, removed: 0 };
  blocks.forEach((block) => capBlock(block, limit, state));
  return { topicCount: state.seen, removedCount: state.removed };
}
