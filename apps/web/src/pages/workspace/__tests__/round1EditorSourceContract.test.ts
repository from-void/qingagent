import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(testDir, "../../../../../..");

function source(file: string) {
  return readFileSync(path.join(repoRoot, file), "utf8");
}

describe("round1 editor source contract", () => {
  it("does not use native prompt for toolbar link creation", () => {
    expect(source("apps/web/src/pages/workspace/components/DocToolbar.tsx")).not.toContain("window.prompt");
  });

  it("keeps block handle Escape dismissal wired at document level", () => {
    const text = source("apps/web/src/pages/workspace/components/doc/BlockHandle.tsx");
    expect(text).toContain('e.key === "Escape"');
    expect(text).toContain('document.addEventListener("keydown", onKey)');
  });

  it("keeps block handle collapse toggle wired through the PM collapse plugin", () => {
    const text = source("apps/web/src/pages/workspace/components/doc/BlockHandle.tsx");
    expect(text).toContain("getBlockCollapseInfo(editor.state, handle.blockPos)");
    expect(text).toContain('className={`fold-toggle${foldInfo.collapsed ? " is-collapsed" : ""}`}');
    expect(text).toContain("toggleBlockCollapse(editor, foldInfo.blockId)");
  });

  it("keeps block handle and floating toolbar insertion entries aligned", () => {
    const snapshot = source("apps/web/src/pages/workspace/components/doc/BlockHandle.tsx");
    const toolbar = source("apps/web/src/pages/workspace/components/DocToolbar.tsx");

    for (const token of [
      'insertBlock("inlineMath")',
      'insertBlock("blockMath")',
      'insertBlock("diagram")',
      'insertBlock("table")',
      'insertBlock("codeBlock")',
      'insertBlock("horizontalRule")',
      'convertBlock("taskList")',
      'convertBlock("callout")',
    ]) {
      expect(snapshot).toContain(token);
    }

    for (const token of [
      'runCommand("insertInlineMath")',
      'runCommand("insertBlockMath")',
      'runCommand("insertDiagram")',
      'runCommand("insertTable")',
      'runCommand("codeBlock")',
      'runCommand("horizontalRule")',
    ]) {
      expect(toolbar).toContain(token);
    }
  });
});
