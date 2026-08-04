import { lstatSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const legacyTerms = [
  "DocSection",
  "DocVersion",
  "docSections",
  "sectionIndex",
  "SpanPatch",
  "WireFrame",
  "docVersionWritten",
  "ViewDocSection",
  "ViewDocVersion",
  "PresentationDocSection",
  "DocDiffHunk",
];

export const legacyBanExtraTerms = [
  "htmlToDocSections",
  "text.replace(before",
  ".replace(before",
  "normalizedReplace",
  "text.length + 2",
];

const scanRoots = ["apps", "packages"];
const extensions = new Set([".ts", ".tsx", ".mts", ".cts"]);
const ignoredDirs = new Set(["node_modules", "dist", "build", ".git", ".turbo", "coverage"]);

export function scanTerms({ root = repoRoot, terms = legacyTerms } = {}) {
  const absoluteRoot = path.resolve(root);
  const results = [];
  for (const scanRoot of scanRoots) {
    walk(path.join(absoluteRoot, scanRoot), (file) => {
      const content = readFileSync(file, "utf8");
      const matches = [];
      for (const term of terms) {
        const count = countOccurrences(content, term);
        if (count > 0) {
          matches.push({ term, count });
        }
      }
      if (matches.length > 0) {
        const relativePath = path.relative(absoluteRoot, file);
        results.push({
          path: relativePath,
          group: classify(relativePath),
          phase: phaseForPath(relativePath),
          matches,
        });
      }
    });
  }
  return results;
}

export function summarize(results) {
  const groups = new Map();
  for (const result of results) {
    const group = groups.get(result.group) ?? { files: 0, hits: 0, terms: new Map() };
    group.files += 1;
    for (const match of result.matches) {
      group.hits += match.count;
      group.terms.set(match.term, (group.terms.get(match.term) ?? 0) + match.count);
    }
    groups.set(result.group, group);
  }
  return groups;
}

export function formatLedger(results) {
  const groups = summarize(results);
  const lines = [];
  lines.push("PM legacy impact ledger");
  lines.push(`terms: ${legacyTerms.join("|")}`);
  lines.push("");
  for (const groupName of ["runtime", "test", "fixture", "telemetry"]) {
    const group = groups.get(groupName) ?? { files: 0, hits: 0, terms: new Map() };
    lines.push(`## ${groupName}`);
    lines.push(`files=${group.files} hits=${group.hits}`);
    for (const [term, count] of [...group.terms.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      lines.push(`- ${term}: ${count}`);
    }
    const groupResults = results.filter((result) => result.group === groupName);
    for (const result of groupResults) {
      const terms = result.matches.map((match) => `${match.term}:${match.count}`).join(", ");
      lines.push(`  - ${result.path} [${result.phase}] ${terms}`);
    }
    lines.push("");
  }
  lines.push("presentation/animation runtime surface:");
  lines.push(surfaceLine(results, "nativeDiffAnimation.ts", "Phase D1"));
  lines.push(surfaceLine(results, "presentationSpans.ts", "Phase D1"));
  return lines.join("\n");
}

export function classify(relativePath) {
  if (relativePath.includes("/diagnostics/")) return "telemetry";
  if (relativePath.includes("__tests__") || /\.test\.[tj]sx?$/.test(relativePath)) return "test";
  if (relativePath.includes("__fixtures__") || relativePath.includes("/fixtures/") || relativePath.includes("/mocks/")) return "fixture";
  return "runtime";
}

export function phaseForPath(relativePath) {
  if (relativePath.includes("nativeDiffAnimation.ts") || relativePath.includes("presentationSpans.ts")) {
    return "待收敛 Phase D1";
  }
  if (classify(relativePath) === "test") return "测试迁移期白名单";
  if (classify(relativePath) === "fixture") return "fixture/mock 迁移期白名单";
  if (classify(relativePath) === "telemetry") return "telemetry-only 白名单";
  return "待收敛 Phase A-F";
}

function surfaceLine(results, filename, phase) {
  const hit = results.find((result) => result.path.endsWith(filename));
  if (!hit) return `- ${filename}: no current legacy term hit (${phase} watch)`;
  return `- ${hit.path}: ${phase} 收敛 (${hit.matches.map((match) => match.term).join(", ")})`;
}

function countOccurrences(content, term) {
  let count = 0;
  let index = content.indexOf(term);
  while (index >= 0) {
    if (
      !isIdentifier(term) ||
      (!isIdentifierPart(content[index - 1]) && !isIdentifierPart(content[index + term.length]))
    ) {
      count += 1;
    }
    index = content.indexOf(term, index + term.length);
  }
  return count;
}

function isIdentifier(term) {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(term);
}

function isIdentifierPart(char) {
  return char !== undefined && /[A-Za-z0-9_$]/.test(char);
}

function walk(dir, onFile) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (ignoredDirs.has(entry)) continue;
    const fullPath = path.join(dir, entry);
    let stat;
    try {
      stat = lstatSync(fullPath);
    } catch {
      continue;
    }
    if (stat.isSymbolicLink()) continue;
    if (stat.isDirectory()) {
      if (entry.startsWith(".")) continue;
      walk(fullPath, onFile);
      continue;
    }
    if (extensions.has(path.extname(entry))) {
      onFile(fullPath);
    }
  }
}
