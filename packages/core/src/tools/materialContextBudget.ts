// deepseek-v4-flash 上下文虽为 393216 tokens，写稿还需给 65k 输出、主 system、
// 对话历史与技能注入留余量。generateDoc、parseFile 与 readMaterial 共用这一预算，
// 避免上传默认路径和后续读取路径分叉。
export const MATERIAL_CONTEXT_MAX_CHARS = 120_000;

export const READ_MATERIAL_TRUNCATION_GUIDANCE =
  "可改用 summary 模式读取摘要，或使用 range 模式并指定 start/end 分段读取。";

export const PARSE_FILE_TRUNCATION_GUIDANCE =
  "完整原文已保留；调用 storeMaterial 存储本素材后，可使用 readMaterial 的 range 模式并指定 start/end 分段读取全量内容。";

export interface MaterialContextBudgetResult {
  text: string;
  truncated: boolean;
  originalChars: number;
  returnedChars: number;
  omittedChars: number;
  rangeStart: number;
  rangeEnd: number;
}

function safeSliceEnd(text: string, start: number, end: number): number {
  if (end <= start || end >= text.length) return end;
  const previous = text.charCodeAt(end - 1);
  const next = text.charCodeAt(end);
  return previous >= 0xd800 && previous <= 0xdbff && next >= 0xdc00 && next <= 0xdfff
    ? end - 1
    : end;
}

/**
 * 把素材正文及显式截断提示一起限制在模型上下文预算内。
 * originalChars 始终表示完整素材长度；omittedChars 只表示本次请求因预算省略的字符数。
 */
export function applyMaterialContextBudget(
  sourceText: string,
  options: {
    rangeStart?: number;
    requestedEnd?: number;
    guidance?: string;
  } = {},
): MaterialContextBudgetResult {
  const rangeStart = Math.min(
    Math.max(0, Math.floor(options.rangeStart ?? 0)),
    sourceText.length,
  );
  const requestedEnd = Math.min(
    Math.max(
      rangeStart,
      Math.floor(options.requestedEnd ?? sourceText.length),
    ),
    sourceText.length,
  );
  const requestedChars = requestedEnd - rangeStart;
  if (requestedChars <= MATERIAL_CONTEXT_MAX_CHARS) {
    const text = sourceText.slice(rangeStart, requestedEnd);
    return {
      text,
      truncated: false,
      originalChars: sourceText.length,
      returnedChars: text.length,
      omittedChars: 0,
      rangeStart,
      rangeEnd: requestedEnd,
    };
  }

  const guidance = options.guidance ?? READ_MATERIAL_TRUNCATION_GUIDANCE;
  let returnedChars = MATERIAL_CONTEXT_MAX_CHARS;
  let notice = "";
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const omittedChars = requestedChars - returnedChars;
    notice =
      `【素材截断提示】请求读取 ${requestedChars} 字符，本次只返回 ${returnedChars} 字符素材正文，` +
      `已省略 ${omittedChars} 字符。${guidance}`;
    const availableChars = Math.max(
      0,
      MATERIAL_CONTEXT_MAX_CHARS - notice.length - 2,
    );
    const safeEnd = safeSliceEnd(
      sourceText,
      rangeStart,
      rangeStart + Math.min(requestedChars, availableChars),
    );
    const nextReturnedChars = safeEnd - rangeStart;
    if (nextReturnedChars === returnedChars) break;
    returnedChars = nextReturnedChars;
  }

  const rangeEnd = rangeStart + returnedChars;
  const omittedChars = requestedChars - returnedChars;
  notice =
    `【素材截断提示】请求读取 ${requestedChars} 字符，本次只返回 ${returnedChars} 字符素材正文，` +
    `已省略 ${omittedChars} 字符。${guidance}`;
  return {
    text: `${notice}\n\n${sourceText.slice(rangeStart, rangeEnd)}`,
    truncated: true,
    originalChars: sourceText.length,
    returnedChars,
    omittedChars,
    rangeStart,
    rangeEnd,
  };
}
