/**
 * 按产品消息列表的口径过滤不应展示给用户的内部文本。
 *
 * 这是前后端共享的纯函数：前端用返回值渲染，后端必须对完整流文本调用它，
 * 不能拿单个 text delta 的非空与否推断整轮是否可见。
 */
export function sanitizeVisibleText(body: string): string | null {
  const normalized = body.replace(/\r\n/g, "\n");
  const cleaned = normalized.trim();
  if (isInternalTextFrame(cleaned)) return null;
  return cleaned.length > 0 ? cleaned : null;
}

function isInternalTextFrame(body: string): boolean {
  const lines = body.split("\n");
  return (
    lines.length === 5 &&
    lines[0] === "[tool-result]" &&
    /^toolName: \S/.test(lines[1] ?? "") &&
    /^toolCallId: \S/.test(lines[2] ?? "") &&
    /^args: /.test(lines[3] ?? "") &&
    /^result: /.test(lines[4] ?? "")
  );
}
