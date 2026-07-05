export type RepairToolCallJsonResult =
  | { ok: true; json: string; changed: boolean }
  | { ok: false; reason: "noHighConfidenceRepair" | "unclosedString" };

type StackFrame =
  | { kind: "object"; state: "keyOrEnd" | "colon" | "value" | "commaOrEnd" }
  | { kind: "array"; state: "valueOrEnd" | "commaOrEnd" };

function canParseJson(input: string): boolean {
  try {
    JSON.parse(input);
    return true;
  } catch {
    return false;
  }
}

function nextNonWhitespace(input: string, start: number): string | undefined {
  for (let i = start; i < input.length; i += 1) {
    const ch = input[i]!;
    if (!/\s/.test(ch)) return ch;
  }
  return undefined;
}

function nextNonWhitespaceIndex(input: string, start: number): number {
  for (let i = start; i < input.length; i += 1) {
    if (!/\s/.test(input[i]!)) return i;
  }
  return -1;
}

function stripLeadingJsonNoise(input: string): string {
  return input.replace(/^[\uFEFF\u200B\u200C\u200D]+/, "");
}

function currentStringIsValue(stack: StackFrame[]): boolean {
  const top = stack[stack.length - 1];
  if (!top) return true;
  if (top.kind === "array") return top.state === "valueOrEnd";
  return top.state === "value";
}

function currentStringIsObjectValue(stack: StackFrame[]): boolean {
  const top = stack[stack.length - 1];
  return top?.kind === "object" && top.state === "value";
}

function currentPrimitiveIsValue(stack: StackFrame[]): boolean {
  return currentStringIsValue(stack);
}

function isValueStart(ch: string | undefined): boolean {
  return (
    ch === "{" ||
    ch === "[" ||
    ch === "\"" ||
    ch === "-" ||
    ch === "t" ||
    ch === "f" ||
    ch === "n" ||
    (ch !== undefined && ch >= "0" && ch <= "9")
  );
}

function isPrimitiveStart(ch: string): boolean {
  return ch === "-" || ch === "t" || ch === "f" || ch === "n" || (ch >= "0" && ch <= "9");
}

function isPrimitiveContinue(ch: string): boolean {
  return /[A-Za-z0-9+\-.eE]/.test(ch);
}

function markValueCompleted(stack: StackFrame[]): void {
  const top = stack[stack.length - 1];
  if (!top) return;
  if (top.kind === "array" && top.state === "valueOrEnd") {
    top.state = "commaOrEnd";
  } else if (top.kind === "object" && top.state === "value") {
    top.state = "commaOrEnd";
  }
}

function closeContainer(stack: StackFrame[]): void {
  stack.pop();
  markValueCompleted(stack);
}

function onStringClosed(stack: StackFrame[], wasValue: boolean): void {
  const top = stack[stack.length - 1];
  if (!top) return;
  if (wasValue) {
    markValueCompleted(stack);
    return;
  }
  if (top.kind === "object" && top.state === "keyOrEnd") {
    top.state = "colon";
  }
}

function onStructuralChar(stack: StackFrame[], ch: string): void {
  const top = stack[stack.length - 1];
  if (ch === "{") {
    stack.push({ kind: "object", state: "keyOrEnd" });
    return;
  }
  if (ch === "[") {
    stack.push({ kind: "array", state: "valueOrEnd" });
    return;
  }
  if (ch === "}") {
    if (top?.kind === "object") closeContainer(stack);
    return;
  }
  if (ch === "]") {
    if (top?.kind === "array") closeContainer(stack);
    return;
  }
  if (ch === ":" && top?.kind === "object" && top.state === "colon") {
    top.state = "value";
    return;
  }
  if (ch === "," && top?.state === "commaOrEnd") {
    top.state = top.kind === "object" ? "keyOrEnd" : "valueOrEnd";
  }
}

function findStringEnd(input: string, quoteIdx: number): number {
  let escaped = false;
  for (let i = quoteIdx + 1; i < input.length; i += 1) {
    const ch = input[i]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (ch === "\"") return i;
  }
  return -1;
}

function looksLikeSplitObjectValueString(input: string, afterQuoteIdx: number, stack: StackFrame[]): boolean {
  if (!currentStringIsObjectValue(stack)) return false;

  const commaIdx = nextNonWhitespaceIndex(input, afterQuoteIdx);
  if (commaIdx < 0 || input[commaIdx] !== ",") return false;

  const fragmentQuoteIdx = nextNonWhitespaceIndex(input, commaIdx + 1);
  if (fragmentQuoteIdx < 0 || input[fragmentQuoteIdx] !== "\"") return false;

  const fragmentEndIdx = findStringEnd(input, fragmentQuoteIdx);
  if (fragmentEndIdx < 0) return false;

  const afterFragmentIdx = nextNonWhitespaceIndex(input, fragmentEndIdx + 1);
  // 合法对象的下一个 key 一定是 "key":；不是 key 的相邻字符串片段才按 GLM 拆片修复。
  return afterFragmentIdx < 0 || input[afterFragmentIdx] !== ":";
}

/**
 * 只做高置信度修复:开头 BOM/零宽噪声清理、字符串值内部成对裸半角双引号补 `\"`、
 * 数组元素之间缺失的逗号补 `,`。
 * 不补括号、不猜字段；修完仍无法 JSON.parse 就放弃。
 *
 * ⚠️ 真正的"语义安全网"是修完那次 JSON.parse（末尾 canParseJson），不是上层 zod schema
 * ——editDraft 的 schema 里 find/replace 是 z.string()、block 是 z.unknown()，太弱，挡不住
 * "把内容引号误判成闭合"这类语义错。本函数的护栏：值字符串里的裸引号必须成对出现；
 * 单个裸引号会把 `replace:"结尾"字"` 修成 `结尾"字` 这类可 parse 但语义被吞的结果，必须 fail-closed。
 * 改这里务必保留末尾的 canParseJson 再校验（回归用例见 repairToolCallJson.test.ts 的"贴结构符"那条）。
 */
export function repairModelJson(input: string): RepairToolCallJsonResult {
  if (canParseJson(input)) return { ok: true, json: input, changed: false };

  const source = stripLeadingJsonNoise(input);
  if (source !== input && canParseJson(source)) return { ok: true, json: source, changed: true };

  const stack: StackFrame[] = [];
  let output = "";
  let inString = false;
  let escaped = false;
  let stringIsValue = false;
  let repairedQuotesInValue = 0;
  let primitiveActive = false;
  let skipSplitFragmentSyntax: "comma" | "openingQuote" | null = null;
  let changed = source !== input;

  const insertMissingArrayCommaIfNeeded = (ch: string) => {
    const top = stack[stack.length - 1];
    if (top?.kind !== "array" || top.state !== "commaOrEnd" || !isValueStart(ch)) return;
    output += ",";
    top.state = "valueOrEnd";
    changed = true;
  };

  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i]!;

    if (!inString) {
      if (primitiveActive && !isPrimitiveContinue(ch)) {
        primitiveActive = false;
        markValueCompleted(stack);
      }
      if (!primitiveActive) insertMissingArrayCommaIfNeeded(ch);
      output += ch;
      if (ch === "\"") {
        inString = true;
        escaped = false;
        stringIsValue = currentStringIsValue(stack);
        repairedQuotesInValue = 0;
        skipSplitFragmentSyntax = null;
      } else if (!primitiveActive && currentPrimitiveIsValue(stack) && isPrimitiveStart(ch)) {
        primitiveActive = true;
      } else {
        onStructuralChar(stack, ch);
      }
      continue;
    }

    if (skipSplitFragmentSyntax === "comma") {
      if (/\s/.test(ch)) {
        changed = true;
        continue;
      }
      if (ch === ",") {
        changed = true;
        skipSplitFragmentSyntax = "openingQuote";
        continue;
      }
      skipSplitFragmentSyntax = null;
    }

    if (skipSplitFragmentSyntax === "openingQuote") {
      if (/\s/.test(ch)) {
        changed = true;
        continue;
      }
      if (ch === "\"") {
        changed = true;
        skipSplitFragmentSyntax = null;
        continue;
      }
      skipSplitFragmentSyntax = null;
    }

    if (escaped) {
      output += ch;
      escaped = false;
      continue;
    }

    if (ch === "\\") {
      output += ch;
      escaped = true;
      continue;
    }

    if (ch !== "\"") {
      output += ch;
      continue;
    }

    const next = nextNonWhitespace(source, i + 1);
    const isSplitObjectValueString = looksLikeSplitObjectValueString(source, i + 1, stack);
    if (isSplitObjectValueString) {
      output += "\\\"";
      if (stringIsValue) repairedQuotesInValue += 1;
      skipSplitFragmentSyntax = "comma";
      changed = true;
      continue;
    }

    const shouldClose = stringIsValue
      ? next === undefined || next === "," || next === "}" || next === "]"
      : next === ":";

    if (shouldClose) {
      if (stringIsValue && repairedQuotesInValue % 2 !== 0) {
        return { ok: false, reason: "noHighConfidenceRepair" };
      }
      output += ch;
      inString = false;
      onStringClosed(stack, stringIsValue);
    } else {
      output += "\\\"";
      if (stringIsValue) repairedQuotesInValue += 1;
      changed = true;
    }
  }

  if (inString) return { ok: false, reason: "unclosedString" };
  if (primitiveActive) markValueCompleted(stack);
  if (!changed) return { ok: false, reason: "noHighConfidenceRepair" };
  if (!canParseJson(output)) return { ok: false, reason: "noHighConfidenceRepair" };
  return { ok: true, json: output, changed: true };
}

export function repairToolCallJson(input: string): RepairToolCallJsonResult {
  return repairModelJson(input);
}
