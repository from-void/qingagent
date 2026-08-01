import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const WEB_SRC_ROOT = join(__dirname, "..");
const NATIVE_BROWSER_DIALOG = /\b(?:window|globalThis)\s*\.\s*(?:alert|confirm|prompt)\s*\(/;

function collectProductionSources(dir: string): string[] {
  const files: string[] = [];
  for (const name of readdirSync(dir)) {
    const fullPath = join(dir, name);
    if (statSync(fullPath).isDirectory()) {
      if (name === "__tests__" || name === "node_modules") continue;
      files.push(...collectProductionSources(fullPath));
      continue;
    }
    if (!/\.(ts|tsx)$/.test(name) || name.endsWith(".d.ts") || name.includes(".test.")) continue;
    files.push(fullPath);
  }
  return files;
}

describe("Web 产品层禁止浏览器原生弹框", () => {
  it("全部生产 ts/tsx 只能使用 ConfirmProvider 或 ToastProvider", () => {
    const offenders = collectProductionSources(WEB_SRC_ROOT)
      .filter((file) => NATIVE_BROWSER_DIALOG.test(readFileSync(file, "utf8")))
      .map((file) => relative(WEB_SRC_ROOT, file));

    expect(offenders).toEqual([]);
  });
});
