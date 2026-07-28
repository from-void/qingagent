export type ChipRichTextPart =
  | { kind: "text"; text: string }
  | { kind: "chip"; index: number; marker: string };

const CHIP_MARKER_AT_START = /^\{\{chip:(\d+)\}\}/;
const CHIP_MARKER_ANYWHERE = /\{\{chip:\d+\}\}/;
const ESCAPED_RICH_TEXT_PREFIX = "\u001eqa-chip-rich-text-v1\u001f";

/**
 * 序列化正文与 chip 占位符。正文含 `{{chip:N}}` 字面量时启用带版本的转义协议，
 * 同时转义反斜杠；不含冲突字面量时保持历史 wire 文本完全不变。
 */
export function serializeChipRichText(parts: readonly ChipRichTextPart[]): string {
  const escaped = parts.some(
    (part) => part.kind === "text" && CHIP_MARKER_ANYWHERE.test(part.text),
  );
  let output = escaped ? ESCAPED_RICH_TEXT_PREFIX : "";
  for (const part of parts) {
    if (part.kind === "chip") {
      output += `{{chip:${part.index}}}`;
      continue;
    }
    output += escaped
      ? part.text
        .replace(/\\/g, "\\\\")
        .replace(/\{\{chip:\d+\}\}/g, (marker) => `\\${marker}`)
      : part.text;
  }
  return output;
}

/**
 * 解析 chip richText。无版本前缀时沿用历史语义；有前缀时只把未转义 marker
 * 识别为 chip，并把字面 marker 与反斜杠无损还原为正文。
 */
export function parseChipRichText(value: string): ChipRichTextPart[] {
  const escaped = value.startsWith(ESCAPED_RICH_TEXT_PREFIX);
  const source = escaped ? value.slice(ESCAPED_RICH_TEXT_PREFIX.length) : value;
  const parts: ChipRichTextPart[] = [];
  let text = "";
  let index = 0;

  const flushText = () => {
    if (!text) return;
    parts.push({ kind: "text", text });
    text = "";
  };

  while (index < source.length) {
    if (escaped && source[index] === "\\") {
      if (source[index + 1] === "\\") {
        text += "\\";
        index += 2;
        continue;
      }
      const escapedMarker = source.slice(index + 1).match(CHIP_MARKER_AT_START);
      if (escapedMarker) {
        text += escapedMarker[0];
        index += escapedMarker[0].length + 1;
        continue;
      }
      text += "\\";
      index += 1;
      continue;
    }

    const marker = source.slice(index).match(CHIP_MARKER_AT_START);
    if (marker) {
      flushText();
      parts.push({
        kind: "chip",
        index: Number(marker[1]),
        marker: marker[0],
      });
      index += marker[0].length;
      continue;
    }

    text += source[index];
    index += 1;
  }

  flushText();
  return parts;
}
