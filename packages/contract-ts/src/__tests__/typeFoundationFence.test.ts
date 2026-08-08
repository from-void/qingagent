import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("../../../..", import.meta.url));
const skippedDirectories = new Set([
  ".git",
  ".turbo",
  "build",
  "coverage",
  "dist",
  "migrations",
  "node_modules",
]);

function findRetiredReferences(directory: string, pattern: RegExp): string[] {
  const matches: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!skippedDirectories.has(entry.name)) {
        matches.push(...findRetiredReferences(path, pattern));
      }
      continue;
    }
    if (pattern.test(readFileSync(path, "utf8"))) matches.push(path);
  }
  return matches;
}

describe("文档类型底座围栏", () => {
  it("产品源码树不再包含已退役的 section 类型与镜像字段", () => {
    const retiredPattern = new RegExp(["Legacy", "Section|legacy", "Sections"].join(""));
    const matches = ["packages", "apps"].flatMap((directory) => (
      findRetiredReferences(join(repoRoot, directory), retiredPattern)
    ));
    expect(matches).toEqual([]);
  });
});
