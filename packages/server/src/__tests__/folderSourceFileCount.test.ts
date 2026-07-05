import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  __resetBrowserFolderBridgeForTest,
  getQingagentSessionWorkspace,
  openBrowserFolderBridgeConnection,
  registerSessionFolderSources,
  resolveBrowserFolderBridgeResponse,
  unregisterSessionFolderSources,
  type BrowserFolderBridgeEntry,
} from "@qingagent/core";
import type { FolderSourceRecord } from "@qingagent/contract-ts";
import { countFolderSourceFiles } from "../lib/folderSourceFileCount";

function makeSource(sessionId: string, root: string): FolderSourceRecord {
  const mountName = `source_${sessionId.replace(/[^a-z0-9_]/gi, "_").toLowerCase()}`;
  return {
    id: `fld_${sessionId}`,
    sessionId,
    provider: "desktop-local",
    name: "测试资料",
    pathLabel: "~/测试资料",
    mountName,
    mountPath: `/sources/${mountName}`,
    readOnly: true,
    fileCount: null,
    fileCountCapped: false,
    status: "connected",
    error: null,
    createdAt: "2026-07-04T00:00:00.000Z",
    updatedAt: "2026-07-04T00:00:00.000Z",
    desktopRootPath: root,
  };
}

function registerDesktopFixture(sessionId: string): { root: string; source: FolderSourceRecord } {
  process.env.QINGAGENT_RUNTIME = "desktop";
  process.env.QINGAGENT_ENABLE_LOCAL_FOLDER_SOURCES = "1";
  const root = mkdtempSync(join(tmpdir(), "qingagent-folder-count-"));
  const source = makeSource(sessionId, root);
  registerSessionFolderSources(sessionId, [source]);
  return { root, source };
}

afterEach(() => {
  delete process.env.QINGAGENT_RUNTIME;
  delete process.env.QINGAGENT_ENABLE_LOCAL_FOLDER_SOURCES;
  delete process.env.QINGAGENT_ENABLE_BROWSER_FOLDER_SOURCES;
  __resetBrowserFolderBridgeForTest();
});

describe("countFolderSourceFiles", () => {
  it("desktop-local 递归统计排除隐藏文件、.git 和 node_modules", async () => {
    const sessionId = "count_hidden";
    const { root, source } = registerDesktopFixture(sessionId);
    try {
      mkdirSync(join(root, "nested"));
      mkdirSync(join(root, ".git"));
      mkdirSync(join(root, "node_modules"));
      writeFileSync(join(root, "visible.md"), "a");
      writeFileSync(join(root, "nested", "visible.txt"), "b");
      writeFileSync(join(root, ".hidden.md"), "hidden");
      writeFileSync(join(root, "nested", ".hidden.txt"), "hidden");
      writeFileSync(join(root, ".git", "ignored"), "ignored");
      writeFileSync(join(root, "node_modules", "ignored.js"), "ignored");

      const workspace = await getQingagentSessionWorkspace(sessionId);
      const result = await countFolderSourceFiles(workspace.filesystem!, source.mountPath);

      expect(result).toEqual({ fileCount: 2, fileCountCapped: false });
    } finally {
      unregisterSessionFolderSources(sessionId);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("desktop-local 递归统计到上限后返回 capped=true", async () => {
    const sessionId = "count_capped";
    const { root, source } = registerDesktopFixture(sessionId);
    try {
      writeFileSync(join(root, "a.md"), "a");
      writeFileSync(join(root, "b.md"), "b");
      writeFileSync(join(root, "c.md"), "c");

      const workspace = await getQingagentSessionWorkspace(sessionId);
      const result = await countFolderSourceFiles(workspace.filesystem!, source.mountPath, { limit: 2 });

      expect(result).toEqual({ fileCount: 2, fileCountCapped: true });
    } finally {
      unregisterSessionFolderSources(sessionId);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("browser-fs-access 在线时通过浏览器桥 readdir 递归统计", async () => {
    process.env.QINGAGENT_ENABLE_BROWSER_FOLDER_SOURCES = "1";
    const sessionId = "count_browser";
    const source: FolderSourceRecord = {
      id: "fld_browser_count",
      sessionId,
      provider: "browser-fs-access",
      name: "浏览器资料",
      pathLabel: "浏览器资料",
      mountName: "source_browser_count",
      mountPath: "/sources/source_browser_count",
      readOnly: true,
      fileCount: null,
      fileCountCapped: false,
      status: "connected",
      error: null,
      createdAt: "2026-07-04T00:00:00.000Z",
      updatedAt: "2026-07-04T00:00:00.000Z",
      browserHandleKey: "handle-count",
      browserClientSourceId: "client-count",
    };
    registerSessionFolderSources(sessionId, [source]);
    const entriesByPath = new Map<string, BrowserFolderBridgeEntry[]>([
      ["", [
        { name: "a.md", type: "file", size: 1 },
        { name: "nested", type: "directory" },
        { name: ".hidden.md", type: "file", size: 1 },
      ]],
      ["nested", [
        { name: "b.txt", type: "file", size: 1 },
        { name: "node_modules", type: "directory" },
      ]],
    ]);
    const seenRelPaths: string[] = [];
    const close = openBrowserFolderBridgeConnection({
      sessionId,
      clientId: "client-count",
      send: async (request) => {
        seenRelPaths.push(request.relPath);
        resolveBrowserFolderBridgeResponse(request.requestId, {
          sessionId,
          folderId: source.id,
          clientId: request.clientId,
          response: {
            ok: true,
            op: "readdir",
            entries: entriesByPath.get(request.relPath) ?? [],
          },
        });
      },
    });
    try {
      const workspace = await getQingagentSessionWorkspace(sessionId);
      const result = await countFolderSourceFiles(workspace.filesystem!, source.mountPath);

      expect(result).toEqual({ fileCount: 2, fileCountCapped: false });
      expect(seenRelPaths).toEqual(["", "nested"]);
    } finally {
      close();
      unregisterSessionFolderSources(sessionId);
    }
  });

  it("递归统计超时时失败退出，不返回部分数量", async () => {
    const neverResolvingFilesystem = {
      readdir: () => new Promise<never>(() => undefined),
    };

    await expect(
      countFolderSourceFiles(neverResolvingFilesystem as never, "/sources/source_slow", { timeoutMs: 1 }),
    ).rejects.toThrow("folder source file count timed out");
  });
});
