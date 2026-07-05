export type RepairJsonSyntaxResult =
  | { ok: true; json: string; changed: boolean; repairs: string[] }
  | { ok: false; reason: "unclosedString" | "noHighConfidenceRepair"; repairs: string[] };

function canParseJson(input: string): boolean {
  try {
    JSON.parse(input);
    return true;
  } catch {
    return false;
  }
}

function stripJsonFence(input: string): { text: string; changed: boolean } {
  const trimmed = input.trim();
  const match = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (!match) return { text: input, changed: false };
  return { text: match[1]!.trim(), changed: true };
}

function stripTrailingCommas(input: string): { text: string; changed: boolean } {
  let text = "";
  let changed = false;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i]!;

    if (escaped) {
      text += ch;
      escaped = false;
      continue;
    }

    if (ch === "\\") {
      text += ch;
      escaped = true;
      continue;
    }

    if (ch === "\"") {
      text += ch;
      inString = !inString;
      continue;
    }

    if (!inString && ch === ",") {
      let j = i + 1;
      while (j < input.length && /\s/.test(input[j]!)) j += 1;
      if (input[j] === "}" || input[j] === "]") {
        changed = true;
        continue;
      }
    }

    text += ch;
  }

  return { text, changed };
}

function repairShiftedTextClosers(input: string): { text: string; changed: boolean } {
  const text = input.replace(
    /("text"\s*:\s*"(?:\\.|[^"\\])*")(\s*)\](\s*)\}(\s*)\]/g,
    "$1$2}$3]$4}",
  );
  return { text, changed: text !== input };
}

/**
 * 修复模型 JSON 的纯语法损伤:围栏、尾逗号、缺失的中/花括号闭合。
 *
 * 它不猜字段、不补内容、不处理未闭字符串;最后必须 JSON.parse 成功才返回 ok。
 * 文档链路还必须继续过 AI-IR schema 与 PM 编译校验,这里不能单独作为成功依据。
 */
export function repairJsonSyntax(input: string): RepairJsonSyntaxResult {
  if (canParseJson(input)) return { ok: true, json: input, changed: false, repairs: [] };

  const repairs: string[] = [];
  let source = input.trim();
  const fenced = stripJsonFence(source);
  if (fenced.changed) {
    source = fenced.text;
    repairs.push("strip_fence");
    if (canParseJson(source)) return { ok: true, json: source, changed: true, repairs };
  }

  const noTrailingCommas = stripTrailingCommas(source);
  if (noTrailingCommas.changed) {
    source = noTrailingCommas.text;
    repairs.push("strip_trailing_comma");
    if (canParseJson(source)) return { ok: true, json: source, changed: true, repairs };
  }

  const shiftedTextClosers = repairShiftedTextClosers(source);
  if (shiftedTextClosers.changed) {
    source = shiftedTextClosers.text;
    repairs.push("repair_shifted_text_closers");
    if (canParseJson(source)) return { ok: true, json: source, changed: true, repairs };
  }

  const stack: string[] = [];
  let output = "";
  let inString = false;
  let escaped = false;
  let changed = repairs.length > 0;

  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i]!;

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

    if (ch === "\"") {
      output += ch;
      inString = !inString;
      continue;
    }

    if (inString) {
      output += ch;
      continue;
    }

    if (ch === "{" || ch === "[") {
      stack.push(ch === "{" ? "}" : "]");
      output += ch;
      continue;
    }

    if (ch === "}" || ch === "]") {
      while (stack.length > 0 && stack[stack.length - 1] !== ch) {
        const missing = stack.pop()!;
        output += missing;
        changed = true;
        repairs.push(`insert_missing_${missing === "]" ? "bracket" : "brace"}_before_${ch}`);
      }
      if (stack[stack.length - 1] === ch) {
        stack.pop();
        output += ch;
        continue;
      }
      // 多余闭合符不删:这类修复置信度低,交给最终 parse 判失败。
      output += ch;
      continue;
    }

    output += ch;
  }

  if (inString) return { ok: false, reason: "unclosedString", repairs };

  if (stack.length > 0) {
    const missing = stack.reverse().join("");
    output += missing;
    changed = true;
    repairs.push("append_missing_closers");
  }

  if (!changed) return { ok: false, reason: "noHighConfidenceRepair", repairs };
  if (!canParseJson(output)) return { ok: false, reason: "noHighConfidenceRepair", repairs };
  return { ok: true, json: output, changed: true, repairs };
}
