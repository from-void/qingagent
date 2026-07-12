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

  const needle = caseSensitive ? query : query.toLocaleLowerCase();
  const matches: FindMatch[] = [];
  let total = 0;

  for (const segment of segments) {
    const haystack = caseSensitive
      ? segment.text
      : segment.text.toLocaleLowerCase();
    let offset = 0;
    while (offset <= haystack.length) {
      const index = haystack.indexOf(needle, offset);
      if (index < 0) break;
      total += 1;
      if (matches.length < limit) {
        matches.push({
          from: segment.pos + index,
          to: segment.pos + index + query.length,
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
