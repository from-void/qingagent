import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  __resetDesktopFolderSelectionsForTest,
  assertDirectory,
  consumeDesktopFolderSelection,
  countFolderFiles,
  peekDesktopFolderSelection,
  registerDesktopFolderSelection,
} from "../lib/desktopFolderSelection";

describe("desktop folder selection registry", () => {
  afterEach(() => {
    __resetDesktopFolderSelectionsForTest();
  });

  it("selection token 一次性消费且可校验 webContents id", () => {
    const selection = registerDesktopFolderSelection({
      webContentsId: 7,
      rootPath: "/tmp/docs",
      name: "docs",
      pathLabel: "/tmp/docs",
    });

    expect(selection.pathLabel).toBe(".../docs");
    expect(peekDesktopFolderSelection(selection.selectionToken, 7)?.rootPath).toBe("/tmp/docs");
    expect(peekDesktopFolderSelection(selection.selectionToken, 7)?.rootPath).toBe("/tmp/docs");
    expect(consumeDesktopFolderSelection(selection.selectionToken, 8)).toBeNull();
    expect(consumeDesktopFolderSelection(selection.selectionToken, 7)?.rootPath).toBe("/tmp/docs");
    expect(consumeDesktopFolderSelection(selection.selectionToken, 7)).toBeNull();
  });

  it("默认 pathLabel 使用摘要路径，不保留完整 rootPath", () => {
    const rootPath = "/tmp/qingagent/客户资料/项目A";
    const selection = registerDesktopFolderSelection({
      webContentsId: 1,
      rootPath,
    });

    expect(selection.pathLabel).toBe(".../客户资料/项目A");
    expect(selection.pathLabel).not.toContain(rootPath);
  });

  it("过期 token 不可消费", () => {
    const selection = registerDesktopFolderSelection({
      webContentsId: 1,
      rootPath: "/tmp/docs",
      ttlMs: -1,
    });
    expect(consumeDesktopFolderSelection(selection.selectionToken, 1)).toBeNull();
  });

  it("assertDirectory 拒绝非目录，countFolderFiles 有扫描上限", async () => {
    const root = mkdtempSync(join(tmpdir(), "desktop-folder-"));
    mkdirSync(join(root, "nested"), { recursive: true });
    writeFileSync(join(root, "a.md"), "a");
    writeFileSync(join(root, "nested", "b.md"), "b");
    writeFileSync(join(root, "file.txt"), "file");

    await expect(assertDirectory(root)).resolves.toBe(root);
    await expect(assertDirectory(join(root, "file.txt"))).rejects.toThrow("invalid_path");
    await expect(countFolderFiles(root, 2)).resolves.toEqual({
      fileCount: 2,
      fileCountCapped: true,
    });
    await expect(countFolderFiles(root, 3)).resolves.toEqual({
      fileCount: 3,
      fileCountCapped: false,
    });
    await expect(countFolderFiles(root, -1)).resolves.toEqual({
      fileCount: 0,
      fileCountCapped: true,
    });
  });
});
