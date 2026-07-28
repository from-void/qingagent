/**
 * 把流式尾巴拼成完整缓冲:
 * - 尾巴完全包含在缓冲末尾(没新增)→ 维持。
 * - 有重叠→ 只追加新增部分。
 * - 完全无重叠(可能换了赛道/重来)→ 以新尾巴重建。
 */
export function mergeTail(buffer: string, tail: string): string {
  if (!buffer) return tail;
  if (!tail) return buffer;
  if (buffer.endsWith(tail)) return buffer;
  const maxK = Math.min(buffer.length, tail.length);
  for (let k = maxK; k > 0; k--) {
    if (buffer.endsWith(tail.slice(0, k))) return buffer + tail.slice(k);
  }
  return tail;
}

/** lane 切换或 winner 全文帧必须替换缓冲；普通同 lane 尾帧才允许重叠续接。 */
export function mergeDraftExcerpt(buffer: string, excerpt: string, reset: boolean): string {
  return reset ? excerpt : mergeTail(buffer, excerpt);
}
