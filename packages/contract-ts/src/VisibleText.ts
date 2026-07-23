/**
 * 按产品消息列表的口径过滤不应展示给用户的内部文本。
 *
 * 这是前后端共享的纯函数：前端用返回值渲染，后端必须对完整流文本调用它，
 * 不能拿单个 text delta 的非空与否推断整轮是否可见。
 */
export function sanitizeVisibleText(body: string): string | null {
  const normalized = body.replace(/\r\n/g, "\n");
  if (isInternalTextBlock(normalized)) return null;
  const lines = normalized
    .split("\n")
    .filter((line) => !isInternalTextLine(line));
  const cleaned = lines.join("\n").trim();
  return cleaned.length > 0 ? cleaned : null;
}

function stripMarkdownFence(text: string): string {
  const match = text.trim().match(/^```[a-zA-Z0-9_-]*\s*\n([\s\S]*?)\n```$/);
  return match ? match[1]!.trim() : text.trim();
}

function isInternalTextBlock(body: string): boolean {
  const text = stripMarkdownFence(body);
  if (/\bAI-IR\b/i.test(text)) return true;
  if (/\[(?:tool-result|tool-call|askUserAnswers|internal|transcript)\]/i.test(text)) {
    return true;
  }
  if (/\bnumericValue\b/.test(text)) return true;
  if (/\bblock-[A-Za-z0-9_-]+\b/.test(text)) return true;
  if (/^\s*(?:system|developer)\s*:/i.test(text)) return true;
  if (/you are (?:chatgpt|codex|qingagent)/i.test(text)) return true;
  if (
    /^\s*[\[{]/.test(text) &&
    /"(?:blocks|blockId|attrs|content|chosen|freeText|numericValue|tool|args|result)"/.test(
      text,
    )
  ) {
    return true;
  }
  return false;
}

function isInternalTextLine(line: string): boolean {
  const text = line.trim();
  if (!text) return false;
  if (isInternalTextBlock(text)) return true;
  if (
    /^(?:let me|let's|i need to|i should|i will|i'll|we need to|we should|now i|the user wants|need to)\b/i.test(
      text,
    )
  ) {
    return true;
  }
  return /\b(?:different approach|tool result|tool call|system prompt|developer instruction)\b/i.test(
    text,
  );
}
