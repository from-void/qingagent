type SegmenterConstructor = new (
  locales?: string | string[],
  options?: { granularity: "grapheme" },
) => {
  segment(input: string): Iterable<{ segment: string }>;
};

/** 清除无法编码的孤立 UTF-16 代理项，同时保留合法代理对。 */
export function removeUnpairedSurrogates(value: string): string {
  let result = "";
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        result += value[index]! + value[index + 1]!;
        index += 1;
      }
      continue;
    }
    if (code >= 0xdc00 && code <= 0xdfff) continue;
    result += value[index];
  }
  return result;
}

/**
 * 按用户感知字素拆分文本。现代运行时优先使用 Intl.Segmenter；
 * 旧运行时回退到 code point，至少不会拆断代理对。
 */
export function splitGraphemes(value: string): string[] {
  const sanitized = removeUnpairedSurrogates(value);
  const Segmenter = (
    Intl as typeof Intl & { Segmenter?: SegmenterConstructor }
  ).Segmenter;
  if (!Segmenter) return Array.from(sanitized);
  return Array.from(
    new Segmenter(undefined, { granularity: "grapheme" }).segment(sanitized),
    (item) => item.segment,
  );
}

export function countGraphemes(value: string): number {
  return splitGraphemes(value).length;
}

export function truncateGraphemes(value: string, maxLength: number): string {
  if (!Number.isFinite(maxLength) || maxLength <= 0) return "";
  return splitGraphemes(value).slice(0, Math.floor(maxLength)).join("");
}
