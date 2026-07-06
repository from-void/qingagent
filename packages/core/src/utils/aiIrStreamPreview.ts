/** 从半截 QingML/HTML 子集里剥标签提取已流出的正文，容忍尾部标签未闭合。 */
export function aiIrStreamPreviewFromMarkup(partial: string): string {
  const source = stripFirstFence(partial);
  let out = "";
  let index = 0;

  while (index < source.length) {
    const ch = source[index];
    if (ch !== "<") {
      out += ch;
      index += 1;
      continue;
    }

    const rest = source.slice(index);
    if (!looksLikeTagStart(rest)) {
      out += ch;
      index += 1;
      continue;
    }

    const end = source.indexOf(">", index + 1);
    if (end < 0) break;

    const tagBody = source.slice(index + 1, end).trim().toLowerCase();
    if (/^br(?:\s|\/|$)/.test(tagBody)) out += "\n";
    index = end + 1;
  }

  return decodeHtmlEntities(out);
}

/** 取文本末尾一段做滚动摘录(去掉换行,最多 maxChars 个码点)。 */
export function tailExcerpt(text: string, maxChars = 60): string {
  const flat = text.replace(/\s+/g, " ").trim();
  const chars = Array.from(flat);
  return chars.length <= maxChars ? flat : chars.slice(-maxChars).join("");
}

/** 取文本开头一段做预览摘录(去掉换行,最多 maxChars 个码点)。
 *  用于草稿完成卡的内容预览,直播 / 历史重开都有内容(不依赖客户端临时态)。 */
export function headExcerpt(text: string, maxChars = 220): string {
  const flat = text.replace(/\s+/g, " ").trim();
  const chars = Array.from(flat);
  return chars.length <= maxChars ? flat : chars.slice(0, maxChars).join("");
}

function stripFirstFence(raw: string): string {
  const fence = /```(?:html|qingml|xml)?[ \t]*\n?([\s\S]*?)(?:```|$)/i.exec(raw);
  return fence?.[1] ?? raw;
}

function looksLikeTagStart(raw: string): boolean {
  return /^<\/?[a-zA-Z][\w:.-]*(?:\s|\/|>|$)/.test(raw) || /^<!--/.test(raw) || /^<![a-zA-Z]/.test(raw);
}

function decodeHtmlEntities(text: string): string {
  return text.replace(/&(#x[0-9a-fA-F]+|#\d+|lt|gt|amp|quot|apos);/g, (_, entity: string) => {
    switch (entity) {
      case "lt":
        return "<";
      case "gt":
        return ">";
      case "amp":
        return "&";
      case "quot":
        return '"';
      case "apos":
        return "'";
      default:
        if (entity.startsWith("#x")) return codePointToString(Number.parseInt(entity.slice(2), 16));
        if (entity.startsWith("#")) return codePointToString(Number.parseInt(entity.slice(1), 10));
        return `&${entity};`;
    }
  });
}

function codePointToString(codePoint: number): string {
  if (!Number.isFinite(codePoint)) return "";
  try {
    return String.fromCodePoint(codePoint);
  } catch {
    return "";
  }
}
