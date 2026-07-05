// 从流式累积的 AI-IR JSON 半成品里提取正文文本,供写稿小卡片实时预览。
// 输入是不可信的半截 JSON(最后一个字符串经常没闭合),用正则容错提取
// 所有 "text":"..." 值(含未闭合的尾巴),不走 JSON.parse。

const TEXT_VALUE_RE = /"text"\s*:\s*"((?:[^"\\]|\\.)*)("|$)/g;

/** 还原 JSON 字符串转义(只处理常见几种,未知转义原样保留)。 */
function unescapeJsonString(s: string): string {
  return s.replace(/\\(["\\/bfnrt]|u[0-9a-fA-F]{4})/g, (_, esc: string) => {
    switch (esc[0]) {
      case '"':
        return '"';
      case "\\":
        return "\\";
      case "/":
        return "/";
      case "n":
      case "r":
        return "\n";
      case "t":
        return "\t";
      case "b":
      case "f":
        return "";
      case "u":
        try {
          return String.fromCharCode(parseInt(esc.slice(1), 16));
        } catch {
          return "";
        }
      default:
        return esc;
    }
  });
}

/** 提取半截 AI-IR JSON 里已写出的全部正文(按出现顺序拼接,换行分隔)。 */
export function extractStreamingText(raw: string): string {
  const parts: string[] = [];
  TEXT_VALUE_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TEXT_VALUE_RE.exec(raw)) !== null) {
    if (m[1]) parts.push(unescapeJsonString(m[1]));
    // 防零宽匹配死循环(未闭合尾串匹配到 $ 时)
    if (m.index === TEXT_VALUE_RE.lastIndex) TEXT_VALUE_RE.lastIndex++;
  }
  return parts.join("\n");
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
