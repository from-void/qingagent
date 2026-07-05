// 思考流「滚动文案」解析器(纯函数,便于单测)。
// 把流式思考文本按段落切分,每段取「第一句」(到首个句末标点 。!？ 为止);
// 只保留含中文(或中英混杂)的句子,纯英文丢弃。返回有序句子列表(稳定前缀:
// 已完成段落的首句不会再变),上层据此做 ~0.7s 一条的轮播预览。

const CJK_RE = /[一-鿿]/;
// 句末标点:中文句号/问号/叹号 + 英文问号/叹号。
// 故意不含英文句点 `.` —— 否则 "1." 列表号、"V3."、"1.6T" 等会被误断成句末。
const SENTENCE_RE = /[^。！？?!]*[。！？?!]/;

/** 文本是否含中文字符(用于过滤纯英文段)。 */
export function hasChinese(text: string): boolean {
  return CJK_RE.test(text);
}

/**
 * 从思考全文提取「每段首句」的有序列表(只要含中文的)。
 * - 段落:按一个或多个换行切分(空行/单换行都算段界)。
 * - 首句:该段从头到首个句末标点(含标点)。无句末标点 = 该段还没出一句完整话 → 跳过。
 * - 纯英文首句丢弃;中文或中英混杂保留。
 * - 句子去首尾空白;过短(去标点后 < 2 字)丢弃,避免 “1.”“等。” 这类碎片。
 */
/** 去掉行内 markdown 符号(粗体/代码/删除线 + 段首列表/标题/引用号),让流式思考预览
 *  不带 ** ` # - 这些原始符号(简单转义,不做完整渲染)。 */
export function stripInlineMarkdown(text: string): string {
  return text
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/~~([^~]+)~~/g, "$1")
    .replace(/^\s*#{1,6}\s+/, "")
    .replace(/^\s*[-*+]\s+/, "")
    .replace(/^\s*\d+[.)]\s+/, "")
    .replace(/^\s*>\s?/, "")
    .trim();
}

export function extractThinkingMarqueeSentences(text: string): string[] {
  if (!text) return [];
  const out: string[] = [];
  for (const rawSeg of text.split(/\n+/)) {
    const seg = stripInlineMarkdown(rawSeg.trim());
    if (!seg) continue;
    const m = seg.match(SENTENCE_RE);
    if (!m) continue; // 该段尚无完整一句(常见于正在流式的末段)→ 跳过
    const sentence = m[0].trim();
    if (!hasChinese(sentence)) continue; // 纯英文不展示
    // 去掉句末标点后的有效内容太短则丢弃(碎片)
    const core = sentence.replace(/[。！？?!]\s*$/, "").trim();
    if (core.length < 2) continue;
    out.push(sentence);
  }
  return out;
}
