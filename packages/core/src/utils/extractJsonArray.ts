function stripJsonFence(raw: string): string {
  let text = raw.trim();
  text = text.replace(/^```[a-zA-Z0-9_-]*[ \t]*\r?\n?/i, "");
  text = text.replace(/\r?\n?```\s*$/i, "");
  return text.trim();
}

function startsJsonValue(text: string, arrayStart: number): boolean {
  let cursor = arrayStart + 1;
  while (cursor < text.length && /\s/.test(text[cursor]!)) cursor += 1;
  if (cursor >= text.length) return true;

  const first = text[cursor]!;
  if (
    first === "]" ||
    first === "{" ||
    first === "[" ||
    first === '"' ||
    first === "-" ||
    (first >= "0" && first <= "9")
  ) {
    return true;
  }

  return ["true", "false", "null"].some((literal) => {
    if (!text.startsWith(literal, cursor)) return false;
    const next = text[cursor + literal.length];
    return next === undefined || next === "," || next === "]" || /\s/.test(next);
  });
}

function findNextJsonArrayStart(text: string, fromIndex: number): number {
  let start = text.indexOf("[", fromIndex);
  while (start !== -1) {
    if (startsJsonValue(text, start)) return start;
    start = text.indexOf("[", start + 1);
  }
  return -1;
}

interface ArrayCandidateScan {
  candidates: string[];
  hasUnbalancedCandidate: boolean;
}

function findBalancedArrayEnd(text: string, arrayStart: number): number {
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = arrayStart; i < text.length; i++) {
    const ch = text[i]!;

    if (inString) {
      if (escape) {
        escape = false;
        continue;
      }
      if (ch === "\\") {
        escape = true;
        continue;
      }
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "[") {
      depth += 1;
      continue;
    }
    if (ch === "]") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function scanArrayCandidates(raw: string): ArrayCandidateScan {
  const text = stripJsonFence(raw);
  const candidates: string[] = [];
  let cursor = 0;

  while (cursor < text.length) {
    const arrayStart = findNextJsonArrayStart(text, cursor);
    if (arrayStart === -1) break;
    const arrayEnd = findBalancedArrayEnd(text, arrayStart);
    if (arrayEnd === -1) {
      return { candidates, hasUnbalancedCandidate: true };
    }
    candidates.push(text.slice(arrayStart, arrayEnd + 1));
    cursor = arrayEnd + 1;
  }

  return { candidates, hasUnbalancedCandidate: false };
}

function parseArrayCandidate(candidate: string): unknown[] | null {
  try {
    const parsed = JSON.parse(candidate);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isObjectArray(value: unknown[]): boolean {
  return value.length > 0 && value.every(
    (item) => item !== null && typeof item === "object" && !Array.isArray(item),
  );
}

export function extractJsonArray(raw: string): string | null {
  const scan = scanArrayCandidates(raw);
  const parsedCandidates = scan.candidates.flatMap((candidate) => {
    const parsed = parseArrayCandidate(candidate);
    return parsed === null ? [] : [{ candidate, parsed }];
  });
  const objectCandidate = parsedCandidates.find(({ parsed }) => isObjectArray(parsed));
  if (objectCandidate) return objectCandidate.candidate;
  if (scan.hasUnbalancedCandidate) return null;
  return parsedCandidates[0]?.candidate ?? null;
}

export function extractFirstBalancedArray(raw: string): string | null {
  const scan = scanArrayCandidates(raw);
  const objectCandidate = scan.candidates.find((candidate) => {
    const parsed = parseArrayCandidate(candidate);
    return parsed !== null && isObjectArray(parsed);
  });
  if (objectCandidate) return objectCandidate;
  if (scan.hasUnbalancedCandidate) return null;
  return scan.candidates[0] ?? null;
}
