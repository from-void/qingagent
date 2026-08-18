import { readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = resolve(__dirname, "../../../..");
const UI_SOURCE_ROOTS = [join(REPO_ROOT, "apps"), join(REPO_ROOT, "packages")];

function collectUiSources(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const name = entry.name;
    const file = join(directory, name);
    if (entry.isDirectory()) {
      if (
        name.startsWith(".")
        || name === "__tests__"
        || name === "node_modules"
        || name === "dist"
      ) continue;
      files.push(...collectUiSources(file));
      continue;
    }
    if (!entry.isFile()) continue;
    if (!/\.(ts|tsx)$/.test(name) || name.endsWith(".d.ts") || name.includes(".test.")) continue;
    files.push(file);
  }
  return files;
}

describe("用户界面不暴露后台连接实现", () => {
  it("apps/packages 全部生产 UI 源码不再出现旧概念", () => {
    const offenders = UI_SOURCE_ROOTS.flatMap(collectUiSources)
      .filter((file) => readFileSync(file, "utf8").includes("外部后台"))
      .map((file) => relative(REPO_ROOT, file));
    expect(offenders).toEqual([]);
  });
});
