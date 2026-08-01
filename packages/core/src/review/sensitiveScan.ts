import type { LexiconEntry } from "@qingagent/db";

export interface ScanHit {
  word: string;
  replacementHint: string | null;
  reviewAction: "annotate";
  note: string | null;
  count: number;
  samples: string[];
}

const CONTEXT_FREE_PLACEHOLDER_REPLACEMENT = /^(?:该|此|相关|有关)(?:事项|内容|情况|问题|对象)$/u;

function replacementHint(replacement: string | null): string | null {
  if (!replacement || CONTEXT_FREE_PLACEHOLDER_REPLACEMENT.test(replacement.trim())) return null;
  return replacement;
}

export function scanText(text: string, entries: LexiconEntry[]): ScanHit[] {
  if (!text || entries.length === 0) return [];
  const seenWords = new Set<string>();
  const unique = entries
    .filter((entry) => entry.word.length > 0 && !seenWords.has(entry.word) && seenWords.add(entry.word))
    .sort((a, b) => b.word.length - a.word.length);
  const occupied = new Uint8Array(text.length);
  const matches: Array<{ entry: LexiconEntry; start: number }> = [];

  for (const entry of unique) {
    let from = 0;
    while (from <= text.length - entry.word.length) {
      const start = text.indexOf(entry.word, from);
      if (start < 0) break;
      const end = start + entry.word.length;
      let available = true;
      for (let index = start; index < end; index += 1) {
        if (occupied[index]) {
          available = false;
          break;
        }
      }
      if (available) {
        occupied.fill(1, start, end);
        matches.push({ entry, start });
      }
      from = start + Math.max(entry.word.length, 1);
    }
  }

  matches.sort((a, b) => a.start - b.start);
  const hits = new Map<string, ScanHit>();
  for (const match of matches) {
    let hit = hits.get(match.entry.word);
    if (!hit) {
      hit = {
        word: match.entry.word,
        replacementHint: replacementHint(match.entry.replacement),
        // 扫描只负责确定性命中，词库候选不能越过语境判断直接改稿。
        reviewAction: "annotate",
        note: match.entry.note,
        count: 0,
        samples: [],
      };
      hits.set(match.entry.word, hit);
    }
    hit.count += 1;
    if (hit.samples.length < 3) {
      const before = text.slice(Math.max(0, match.start - 15), match.start);
      const afterStart = match.start + match.entry.word.length;
      const after = text.slice(afterStart, afterStart + 15);
      hit.samples.push(`${before}【${match.entry.word}】${after}`);
    }
  }
  return Array.from(hits.values());
}
