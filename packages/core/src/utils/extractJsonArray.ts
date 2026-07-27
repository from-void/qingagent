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

function findFirstJsonArrayStart(text: string): number {
  let start = text.indexOf("[");
  while (start !== -1) {
    if (startsJsonValue(text, start)) return start;
    start = text.indexOf("[", start + 1);
  }
  return -1;
}

function scanArrayCandidates(
  raw: string,
  onCandidate: (candidate: string) => string | null,
): string | null {
  const text = stripJsonFence(raw);
  const firstArrayStart = findFirstJsonArrayStart(text);
  if (firstArrayStart === -1) return null;

  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = firstArrayStart; i < text.length; i++) {
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
      if (ch === '"') {
        inString = false;
        continue;
      }
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
      if (depth === 0) {
        return onCandidate(text.slice(firstArrayStart, i + 1));
      }
    }
  }

  return null;
}

export function extractJsonArray(raw: string): string | null {
  return scanArrayCandidates(raw, (candidate) => {
    try {
      const parsed = JSON.parse(candidate);
      if (Array.isArray(parsed)) return candidate;
    } catch {
      /* the first top-level array is malformed */
    }
    return null;
  });
}

export function extractFirstBalancedArray(raw: string): string | null {
  return scanArrayCandidates(raw, (candidate) => candidate);
}
