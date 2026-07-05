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

  let start = firstArrayStart;

  while (start !== -1) {
    let depth = 0;
    let inString = false;
    let escape = false;

    for (let i = start; i < text.length; i++) {
      const ch = text[i]!;

      if (escape) {
        escape = false;
        continue;
      }
      if (ch === "\\") {
        escape = true;
        continue;
      }
      if (ch === '"') {
        inString = !inString;
        continue;
      }
      if (inString) continue;

      if (ch === "[") {
        depth++;
      } else if (ch === "]") {
        depth--;
        if (depth === 0) {
          const candidate = text.slice(start, i + 1);
          const result = onCandidate(candidate);
          if (result !== null) return result;
          break;
        }
      }
    }

    start = text.indexOf("[", start + 1);
  }

  return null;
}

export function extractJsonArray(raw: string): string | null {
  return scanArrayCandidates(raw, (candidate) => {
    try {
      const parsed = JSON.parse(candidate);
      if (Array.isArray(parsed)) return candidate;
    } catch {
      /* try the next candidate */
    }
    return null;
  });
}

export function extractFirstBalancedArray(raw: string): string | null {
  return scanArrayCandidates(raw, (candidate) => candidate);
}
