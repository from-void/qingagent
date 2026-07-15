/**
 * 从可能混有 Markdown 围栏、前导话或尾随散文的模型输出中提取首个完整 JSON 值。
 */
export function extractJson(text: string): string {
  const trimmed = text.trim();

  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenceMatch) {
    const body = fenceMatch[1]!.trim();
    return extractFirstParsableJsonValue(body) ?? body;
  }

  const jsonValue = extractFirstParsableJsonValue(trimmed);
  if (jsonValue) return jsonValue;

  const startIdx = findFirstJsonStart(trimmed);
  if (startIdx >= 0) return trimmed.slice(startIdx);

  return trimmed;
}

function extractFirstParsableJsonValue(text: string): string | null {
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (ch !== "[" && ch !== "{") continue;

    const endIdx = findBalancedJsonEnd(text, i);
    // 首个疑似 JSON 都不闭合时不能继续捞内部数组，否则截断对象会假成功。
    if (endIdx < 0) {
      const tail = text.slice(i);
      const sanitizedTail = sanitizeUnescapedQuotesInJsonStrings(tail);
      if (sanitizedTail !== tail) {
        const sanitizedEndIdx = findBalancedJsonEnd(sanitizedTail, 0);
        if (sanitizedEndIdx >= 0) {
          const candidate = sanitizedTail.slice(0, sanitizedEndIdx + 1);
          try {
            JSON.parse(candidate);
            return candidate;
          } catch {
            // 继续走原失败路径。
          }
        }
      }
      return null;
    }

    const candidate = text.slice(i, endIdx + 1);
    try {
      JSON.parse(candidate);
      return candidate;
    } catch {
      const sanitized = sanitizeUnescapedQuotesInJsonStrings(candidate);
      if (sanitized !== candidate) {
        try {
          JSON.parse(sanitized);
          return sanitized;
        } catch {
          // 这个候选不是裸引号可恢复形态，保持原有失败语义。
        }
      }
      // 平衡候选解析失败时跳过整个候选，不下钻嵌套括号以免截断内容假成功。
      i = endIdx;
    }
  }
  return null;
}

function sanitizeUnescapedQuotesInJsonStrings(text: string): string {
  let out = "";
  let inString = false;
  let escape = false;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (escape) {
      out += ch;
      escape = false;
      continue;
    }
    if (ch === "\\") {
      out += ch;
      escape = true;
      continue;
    }
    if (ch !== '"') {
      out += ch;
      continue;
    }
    if (!inString) {
      inString = true;
      out += ch;
      continue;
    }

    const next = nextNonWhitespaceChar(text, i + 1);
    if (next === null || next === ":" || next === "," || next === "}" || next === "]") {
      inString = false;
      out += ch;
      continue;
    }
    out += '\\"';
  }

  return out;
}

function nextNonWhitespaceChar(text: string, start: number): string | null {
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i]!;
    if (!/\s/.test(ch)) return ch;
  }
  return null;
}

function findFirstJsonStart(text: string): number {
  const bracketIdx = text.indexOf("[");
  const braceIdx = text.indexOf("{");
  if (bracketIdx === -1) return braceIdx;
  if (braceIdx === -1) return bracketIdx;
  return Math.min(bracketIdx, braceIdx);
}

function findBalancedJsonEnd(text: string, startIdx: number): number {
  const first = text[startIdx];
  if (first !== "[" && first !== "{") return -1;

  const stack: string[] = [first === "[" ? "]" : "}"];
  let inString = false;
  let escape = false;

  for (let i = startIdx + 1; i < text.length; i++) {
    const ch = text[i]!;
    if (escape) {
      escape = false;
      continue;
    }
    if (ch === "\\") {
      escape = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;

    if (ch === "[" || ch === "{") {
      stack.push(ch === "[" ? "]" : "}");
      continue;
    }
    if (ch === "]" || ch === "}") {
      if (stack.at(-1) !== ch) return -1;
      stack.pop();
      if (stack.length === 0) return i;
    }
  }

  return -1;
}
