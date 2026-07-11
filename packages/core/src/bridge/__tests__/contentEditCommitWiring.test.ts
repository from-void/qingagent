import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const workspaceRoot = fileURLToPath(new URL("../../../../..", import.meta.url));

function productionTypeScriptFiles(root: string): string[] {
  return readdirSync(root, { recursive: true })
    .map(String)
    .filter((relative) =>
      relative.endsWith(".ts") &&
      !relative.includes("__tests__") &&
      !relative.endsWith(".test.ts")
    )
    .map((relative) => join(root, relative));
}

describe("content-edit commit wiring", () => {
  it("requires every production commitDocumentOp await site to advance content time", () => {
    const roots = [
      join(workspaceRoot, "packages/core/src"),
      join(workspaceRoot, "packages/server/src"),
    ];
    const unwired: Array<{ file: string; commits: number; advances: number }> = [];
    let totalCommits = 0;

    for (const file of roots.flatMap(productionTypeScriptFiles)) {
      const source = readFileSync(file, "utf8");
      const commits = source.match(/await\s+commitDocumentOp\s*\(/g)?.length ?? 0;
      if (commits === 0) continue;
      const advances = source.match(/advanceLastContentEditedAt\s*\(/g)?.length ?? 0;
      totalCommits += commits;
      if (advances < commits) {
        unwired.push({ file, commits, advances });
      }
    }

    expect(totalCommits).toBe(5);
    expect(unwired).toEqual([]);
  });
});
