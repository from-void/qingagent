function getLastFenceContent(raw: string): string | null {
  const fencePattern = /^[ \t]*```[ \t]*([a-zA-Z0-9_-]+)?[ \t]*\r?$/gm;
  let openEnd: number | null = null;
  let lastContent: string | null = null;
  let match: RegExpExecArray | null;

  while ((match = fencePattern.exec(raw)) !== null) {
    if (openEnd === null) {
      openEnd = fencePattern.lastIndex;
      if (raw[openEnd] === "\n") openEnd += 1;
      lastContent = raw.slice(openEnd);
      continue;
    }

    lastContent = raw.slice(openEnd, match.index);
    openEnd = null;
  }

  return lastContent;
}

function startsJsonValue(text: string, arrayStart: number): boolean {
  let cursor = arrayStart + 1;
  while (cursor < text.length && /\s/.test(text[cursor]!)) cursor += 1;
  if (cursor >= text.length) return true;

  const first = text[cursor]!;
  if (
    first === "]" ||
    first === "{" ||
    first === "[" ||
    first === '"' ||
    first === "-" ||
    (first >= "0" && first <= "9")
  ) {
    return true;
  }

  return ["true", "false", "null"].some((literal) => {
    if (!text.startsWith(literal, cursor)) return false;
    const next = text[cursor + literal.length];
    return next === undefined || next === "," || next === "]" || /\s/.test(next);
  });
}

function findNextJsonArrayStart(text: string, fromIndex: number): number {
  let start = text.indexOf("[", fromIndex);
  while (start !== -1) {
    if (startsJsonValue(text, start)) return start;
    start = text.indexOf("[", start + 1);
  }
  return -1;
}

interface ArrayCandidateScan {
  candidates: Array<{ candidate: string; start: number }>;
  lastUnbalancedStart: number | null;
}

function findBalancedArrayEnd(text: string, arrayStart: number): number {
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = arrayStart; i < text.length; i++) {
    const ch = text[i]!;

    if (inString) {
      if (escape) {
        escape = false;
        continue;
      }
      if (ch === "\\") {
        escape = true;
        continue;
      }
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "[") {
      depth += 1;
      continue;
    }
    if (ch === "]") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function scanArrayCandidates(raw: string): ArrayCandidateScan {
  const text = getLastFenceContent(raw) ?? raw;
  const candidates: Array<{ candidate: string; start: number }> = [];
  let lastUnbalancedStart: number | null = null;
  let cursor = 0;

  while (cursor < text.length) {
    const arrayStart = findNextJsonArrayStart(text, cursor);
    if (arrayStart === -1) break;
    const arrayEnd = findBalancedArrayEnd(text, arrayStart);
    if (arrayEnd === -1) {
      lastUnbalancedStart = arrayStart;
      cursor = arrayStart + 1;
      continue;
    }
    candidates.push({
      candidate: text.slice(arrayStart, arrayEnd + 1),
      start: arrayStart,
    });
    cursor = arrayEnd + 1;
  }

  return { candidates, lastUnbalancedStart };
}

function parseArrayCandidate(candidate: string): unknown[] | null {
  try {
    const parsed = JSON.parse(candidate);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isObjectArray(value: unknown[]): boolean {
  return value.length > 0 && value.every(
    (item) => item !== null && typeof item === "object" && !Array.isArray(item),
  );
}

/**
 * 提取 LLM 输出中的对象数组负载。
 *
 * 契约：候选仅限平衡的顶层非空对象元素数组；存在 code fence 时只搜索最后一个
 * fence。末尾出现未闭合候选时整体失败，否则默认返回最后一个候选；传入 validate
 * 时返回最后一个通过预校验的候选。
 */
export function extractJsonArray(
  raw: string,
  validate?: (arr: unknown[]) => boolean,
): string | null {
  const scan = scanArrayCandidates(raw);
  if (scan.lastUnbalancedStart !== null && !validate) return null;

  const objectCandidates = scan.candidates.flatMap(({ candidate, start }) => {
    const parsed = parseArrayCandidate(candidate);
    return parsed !== null && isObjectArray(parsed)
      ? [{ candidate, parsed, start }]
      : [];
  });

  for (let index = objectCandidates.length - 1; index >= 0; index -= 1) {
    const current = objectCandidates[index]!;
    if (
      (scan.lastUnbalancedStart === null || current.start > scan.lastUnbalancedStart) &&
      (!validate || validate(current.parsed))
    ) {
      return current.candidate;
    }
  }
  return null;
}

/** @deprecated 使用 extractJsonArray；保留此导出仅为兼容已有内部调用。 */
export function extractFirstBalancedArray(
  raw: string,
  validate?: (arr: unknown[]) => boolean,
): string | null {
  return extractJsonArray(raw, validate);
}
