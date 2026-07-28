import type { DocDimensions } from "./docDimensions";
import { canUseDocumentEditing, workspaceVisualState } from "./workspacePageView";

export interface FindSegment {
  text: string;
  pos: number;
}

export interface FindMatch {
  from: number;
  to: number;
}

export interface FindResult {
  matches: FindMatch[];
  total: number;
  truncated: boolean;
}

export const FIND_MATCH_LIMIT = 1000;

export type FindBarMode = "full" | "find-only" | "hidden";

export interface FindShortcutLike {
  key: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
  defaultPrevented?: boolean;
}

export function collectMatches(
  segments: FindSegment[],
  query: string,
  caseSensitive: boolean,
  limit = FIND_MATCH_LIMIT,
): FindResult {
  if (query === "" || limit <= 0) {
    return { matches: [], total: 0, truncated: false };
  }

  const needle = caseSensitive ? query : foldFindText(query).text;
  const matches: FindMatch[] = [];
  let total = 0;

  for (const segment of segments) {
    const folded = caseSensitive ? null : foldFindText(segment.text);
    const haystack = folded?.text ?? segment.text;
    let offset = 0;
    while (offset <= haystack.length) {
      const index = haystack.indexOf(needle, offset);
      if (index < 0) break;
      total += 1;
      if (matches.length < limit) {
        const originalFrom = folded?.starts[index] ?? index;
        const originalTo = folded?.ends[index + needle.length - 1]
          ?? index + query.length;
        matches.push({
          from: segment.pos + originalFrom,
          to: segment.pos + originalTo,
        });
      }
      offset = index + Math.max(needle.length, 1);
    }
  }

  return {
    matches,
    total,
    truncated: total > matches.length,
  };
}

function foldFindText(value: string): {
  text: string;
  starts: number[];
  ends: number[];
} {
  const text = value.toLocaleLowerCase();
  let originalOffset = 0;
  const starts: number[] = [];
  const ends: number[] = [];

  for (const char of value) {
    const originalFrom = originalOffset;
    originalOffset += char.length;
    const folded = char.toLocaleLowerCase();
    for (let index = 0; index < folded.length; index += 1) {
      starts.push(originalFrom);
      ends.push(originalOffset);
    }
  }

  // Unicode 条件大小写（如希腊词尾 sigma）会改变完整字符串的折叠字符，
  // 但通常不改变长度；text 必须采用完整字符串折叠，映射才沿用原有查找语义。
  if (starts.length !== text.length) {
    return foldFindTextFromPrefixes(value, text);
  }
  return { text, starts, ends };
}

function foldFindTextFromPrefixes(
  value: string,
  text: string,
): { text: string; starts: number[]; ends: number[] } {
  const starts: number[] = [];
  const ends: number[] = [];
  let originalOffset = 0;
  let foldedOffset = 0;

  for (const char of value) {
    const originalFrom = originalOffset;
    originalOffset += char.length;
    const nextFoldedOffset = value
      .slice(0, originalOffset)
      .toLocaleLowerCase()
      .length;
    const from = Math.min(foldedOffset, text.length);
    const to = Math.min(Math.max(from, nextFoldedOffset), text.length);
    for (let index = from; index < to; index += 1) {
      starts[index] = originalFrom;
      ends[index] = originalOffset;
    }
    foldedOffset = nextFoldedOffset;
  }

  for (let index = 0; index < text.length; index += 1) {
    starts[index] ??= starts[index - 1] ?? 0;
    ends[index] ??= ends[index - 1] ?? Math.min(1, value.length);
  }
  return { text, starts, ends };
}

export function stepCursor(cur: number, total: number, dir: 1 | -1): number {
  if (total <= 0) return -1;
  if (dir === 1) return cur < 0 ? 0 : (cur + 1) % total;
  return cur < 0 ? total - 1 : (cur - 1 + total) % total;
}

export function planReplaceAll(
  matches: FindMatch[],
  replacement: string,
): { from: number; to: number; insert: string }[] {
  return matches
    .map((match) => ({ from: match.from, to: match.to, insert: replacement }))
    .sort((a, b) => b.from - a.from);
}

export function collectReplaceAllPlans(
  segments: FindSegment[],
  query: string,
  caseSensitive: boolean,
  replacement: string,
): { from: number; to: number; insert: string }[] {
  const result = collectMatches(
    segments,
    query,
    caseSensitive,
    Number.POSITIVE_INFINITY,
  );
  return planReplaceAll(result.matches, replacement);
}

export function formatFindCount(
  cur: number,
  total: number,
  truncated: boolean,
  limit = FIND_MATCH_LIMIT,
): string {
  if (total <= 0) return "0/0";
  const current = cur >= 0 ? cur + 1 : 0;
  const totalText = truncated ? `${limit}+` : String(total);
  return `${current}/${totalText}`;
}

export function resolveFindBarMode(
  dim: DocDimensions,
  viewingVersion: number | null,
  presentationRun: unknown | null,
): FindBarMode {
  if (workspaceVisualState(dim) === "bigplan") return "hidden";
  return canUseDocumentEditing(
    dim,
    viewingVersion,
    presentationRun as Parameters<typeof canUseDocumentEditing>[2],
  )
    ? "full"
    : "find-only";
}

export function shouldInterceptFindShortcut(
  event: FindShortcutLike,
  activeElInLeft: boolean,
  mode: FindBarMode,
): boolean {
  if (event.defaultPrevented) return false;
  if (activeElInLeft) return false;
  if (mode === "hidden") return false;
  if (!(event.metaKey || event.ctrlKey)) return false;
  if (event.shiftKey || event.altKey) return false;
  return event.key === "f" || event.key === "F";
}
