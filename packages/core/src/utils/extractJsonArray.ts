function stripJsonFence(raw: string): string {
  let text = raw.trim();
  text = text.replace(/^```[a-zA-Z0-9_-]*[ \t]*\r?\n?/i, "");
  text = text.replace(/\r?\n?```\s*$/i, "");
  return text.trim();
}

function scanArrayCandidates(
  raw: string,
  onCandidate: (candidate: string) => string | null,
): string | null {
  const text = stripJsonFence(raw);
  const firstArrayStart = text.indexOf("[");
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
