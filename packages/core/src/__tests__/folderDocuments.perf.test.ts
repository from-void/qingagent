import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FolderSourceRecord } from "@qingagent/contract-ts";
import { Workspace } from "@mastra/core/workspace";
import JSZip from "jszip";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, statSync, truncateSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  QINGAGENT_DATA_DIR,
  __resetIsolationCacheForTest,
  __resetSessionWorkspaceCacheForTest,
  getSessionWorkspace,
  sessionWorkspaceDirName,
} from "../workspace/sessionWorkspace.js";
import {
  cleanupOldFolderSourceCaches,
  clearFolderSourceCache,
  enforceFolderSourceCacheLimits,
  loadFolderSourceManifestEntries,
  putParsedDocument,
} from "../folderSources/cache.js";
import {
  readDocumentForSession,
  resolveFolderSourcePath,
  searchDocumentsForSession,
} from "../tools/folderDocuments.js";
import { summarizeToolOutputForSpan } from "../agent-run/toolIoSpans.js";
import {
  __resetFolderSourceRuntimeForTest,
  markFolderSourceDetached,
  registerSessionFolderSources,
} from "../folderSources/runtime.js";
import {
  __resetBrowserFolderBridgeForTest,
  openBrowserFolderBridgeConnection,
  resolveBrowserFolderBridgeResponse,
  type BrowserFolderBridgeRequest,
  type BrowserFolderBridgeResponse,
} from "../workspace/browserBridgeFilesystem.js";

function makeSource(sessionId: string, basePath: string): FolderSourceRecord {
  const now = "2026-01-01T00:00:00.000Z";
  return {
    id: "fld_docs",
    sessionId,
    provider: "desktop-local",
    name: "Docs",
    pathLabel: "/redacted",
    mountName: "source_docs",
    mountPath: "/sources/source_docs",
    readOnly: true,
    fileCount: 2,
    fileCountCapped: false,
    status: "connected",
    error: null,
    createdAt: now,
    updatedAt: now,
    desktopRootPath: basePath,
  };
}

async function createHiddenXlsxFixture(): Promise<Buffer> {
  const zip = new JSZip();
  zip.file(
    "xl/workbook.xml",
    `<?xml version="1.0" encoding="UTF-8"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets>
    <sheet name="Visible" sheetId="1" r:id="rId1"/>
    <sheet name="Hidden" sheetId="2" state="hidden" r:id="rId2"/>
  </sheets>
</workbook>`,
  );
  zip.file(
    "xl/_rels/workbook.xml.rels",
    `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/>
</Relationships>`,
  );
  zip.file(
    "xl/worksheets/sheet1.xml",
    `<?xml version="1.0" encoding="UTF-8"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetData>
    <row r="1"><c r="A1" t="inlineStr"><is><t>VISIBLE_XLSX_SEARCH_TOKEN</t></is></c></row>
    <row r="2" hidden="1"><c r="A2" t="inlineStr"><is><t>HIDDEN_ROW_SEARCH_TOKEN</t></is></c></row>
    <row r="3" zeroHeight="1"><c r="A3" t="inlineStr"><is><t>ZERO_HEIGHT_SEARCH_TOKEN</t></is></c></row>
  </sheetData>
</worksheet>`,
  );
  zip.file(
    "xl/worksheets/sheet2.xml",
    `<?xml version="1.0" encoding="UTF-8"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>HIDDEN_SHEET_SEARCH_TOKEN</t></is></c></row></sheetData>
</worksheet>`,
  );
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}

function makeBrowserSource(sessionId: string): FolderSourceRecord {
  const now = "2026-01-01T00:00:00.000Z";
  return {
    id: "fld_browser_docs",
    sessionId,
    provider: "browser-fs-access",
    name: "Browser Docs",
    pathLabel: "Browser Docs",
    mountName: "source_browser_docs",
    mountPath: "/sources/source_browser_docs",
    readOnly: true,
    fileCount: null,
    fileCountCapped: false,
    status: "connected",
    error: null,
    createdAt: now,
    updatedAt: now,
    browserHandleKey: "browser-handle-key",
    browserClientSourceId: "browser-client-id",
  };
}

function installBrowserBridgeFixture(
  source: FolderSourceRecord,
  files: Map<string, string>,
  options: {
    statFailure?: string | ((relPath: string) => string | null | undefined);
    readFailure?: string | ((relPath: string) => string | null | undefined);
    delayMs?: number;
  } = {},
): {
  close: () => void;
  requests: BrowserFolderBridgeRequest[];
  maxInflight: () => number;
} {
  if (!source.browserClientSourceId) throw new Error("missing browser client id");
  const requests: BrowserFolderBridgeRequest[] = [];
  let inflight = 0;
  let maxInflight = 0;
  const dirs = new Set<string>([""]);
  for (const relPath of files.keys()) {
    const parts = relPath.split("/");
    for (let index = 1; index < parts.length; index += 1) {
      dirs.add(parts.slice(0, index).join("/"));
    }
  }
  const entryName = (relPath: string) => relPath.split("/").filter(Boolean).pop() ?? source.name;
  const immediateEntries = (relPath: string) => {
    const prefix = relPath ? `${relPath}/` : "";
    const entries = new Map<string, { name: string; type: "file" | "directory"; size?: number }>();
    for (const dir of dirs) {
      if (dir === relPath || !dir.startsWith(prefix)) continue;
      const remaining = dir.slice(prefix.length);
      const name = remaining.split("/")[0];
      if (name) entries.set(name, { name, type: "directory" });
    }
    for (const [filePath, text] of files) {
      if (!filePath.startsWith(prefix)) continue;
      const remaining = filePath.slice(prefix.length);
      const name = remaining.split("/")[0];
      if (!name || entries.has(name)) continue;
      entries.set(name, { name, type: "file", size: Buffer.byteLength(text, "utf8") });
    }
    return [...entries.values()];
  };
  const responseFor = (request: BrowserFolderBridgeRequest): BrowserFolderBridgeResponse => {
    const modifiedAt = "2026-01-01T00:00:00.000Z";
    if (request.op === "stat") {
      const statFailure = typeof options.statFailure === "function"
        ? options.statFailure(request.relPath)
        : options.statFailure;
      if (statFailure) return { ok: false, error: statFailure };
      if (dirs.has(request.relPath)) {
        return {
          ok: true,
          op: "stat",
          stat: {
            name: entryName(request.relPath),
            type: "directory",
            size: 0,
            createdAt: modifiedAt,
            modifiedAt,
          },
        };
      }
      const text = files.get(request.relPath);
      if (text === undefined) return { ok: false, error: "not found" };
      return {
        ok: true,
        op: "stat",
        stat: {
          name: entryName(request.relPath),
          type: "file",
          size: Buffer.byteLength(text, "utf8"),
          createdAt: modifiedAt,
          modifiedAt,
          mimeType: "text/markdown",
        },
      };
    }
    if (request.op === "readdir") {
      if (!dirs.has(request.relPath)) return { ok: false, error: "not a directory" };
      return { ok: true, op: "readdir", entries: immediateEntries(request.relPath) };
    }
    const text = files.get(request.relPath);
    if (text === undefined) return { ok: false, error: "not found" };
    const readFailure = typeof options.readFailure === "function"
      ? options.readFailure(request.relPath)
      : options.readFailure;
    if (readFailure) return { ok: false, error: readFailure };
    return { ok: true, op: "readFile", bytes: new TextEncoder().encode(text) };
  };
  const close = openBrowserFolderBridgeConnection({
    sessionId: source.sessionId,
    clientId: source.browserClientSourceId,
    send: async (request) => {
      requests.push(request);
      inflight += 1;
      maxInflight = Math.max(maxInflight, inflight);
      const respond = () => {
        try {
          resolveBrowserFolderBridgeResponse(request.requestId, {
            sessionId: request.sessionId,
            folderId: request.folderId,
            clientId: request.clientId,
            response: responseFor(request),
          });
        } finally {
          inflight -= 1;
        }
      };
      if (options.delayMs && options.delayMs > 0) {
        setTimeout(respond, options.delayMs);
      } else {
        queueMicrotask(respond);
      }
    },
  });
  return { close, requests, maxInflight: () => maxInflight };
}

function hasLoneSurrogate(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
      continue;
    }
    if (code >= 0xdc00 && code <= 0xdfff) return true;
  }
  return false;
}

describe("folder document tools", () => {
  beforeEach(() => {
    process.env.QINGAGENT_RUNTIME = "desktop";
    process.env.QINGAGENT_ENABLE_LOCAL_FOLDER_SOURCES = "1";
  });

  afterEach(() => {
    delete process.env.QINGAGENT_SANDBOX_ISOLATION;
    delete process.env.QINGAGENT_RUNTIME;
    delete process.env.QINGAGENT_ENABLE_LOCAL_FOLDER_SOURCES;
    delete process.env.QINGAGENT_ENABLE_BROWSER_FOLDER_SOURCES;
    __resetBrowserFolderBridgeForTest();
    __resetFolderSourceRuntimeForTest();
    __resetSessionWorkspaceCacheForTest();
    __resetIsolationCacheForTest();
  });

  it("拒绝脏路径和越界路径", () => {
    const source = makeSource("sess-dirty", "/tmp/unused");
    const dirtyPaths = [
      "",
      "/etc/passwd",
      "/sources/source_docs/../secret.md",
      "/sources/source_docs\\secret.md",
      "/sources//source_docs/a.md",
      "/sources/source_docs/a\u0000.md",
      "/sources/source_docs",
    ];
    for (const path of dirtyPaths) {
      expect(() => resolveFolderSourcePath([source], path)).toThrow();
    }
    expect(resolveFolderSourcePath([source], "/sources/source_docs/a.md")).toMatchObject({
      relPath: "a.md",
      path: "/sources/source_docs/a.md",
    });
  });

  it("readDocument 使用 stat 快筛缓存并只返回虚拟路径", async () => {
    process.env.QINGAGENT_SANDBOX_ISOLATION = "none";
    const sessionId = "sess-folder-docs";
    const root = mkdtempSync(join(tmpdir(), "folder-docs-"));
    const sourceDir = join(root, "docs");
    mkdirSync(sourceDir, { recursive: true });
    writeFileSync(join(sourceDir, "a.md"), "Alpha 正文\n第二行");
    const source = makeSource(sessionId, sourceDir);
    const workspace = await getSessionWorkspace(sessionId, {
      resolveSkillDirs: () => [],
      resolveFolderSources: () => [source],
    });

    const first = await readDocumentForSession({
      sessionId,
      sources: [source],
      workspace,
      path: "/sources/source_docs/a.md",
    });
    const second = await readDocumentForSession({
      sessionId,
      sources: [source],
      workspace,
      path: "/sources/source_docs/a.md",
    });

    expect(first.ok).toBe(true);
    expect(first.cacheHit).toBe(false);
    expect(first.text).toContain("Alpha 正文");
    expect(first.path).toBe("/sources/source_docs/a.md");
    expect(second.ok).toBe(true);
    expect(second.cacheHit).toBe(true);
    expect(JSON.stringify(second)).not.toContain(sourceDir);

    await clearFolderSourceCache(sessionId, source.id);
  });

  it("readDocument 截断和 range 不返回孤立 surrogate", async () => {
    process.env.QINGAGENT_SANDBOX_ISOLATION = "none";
    const sessionId = "sess-folder-surrogate-boundary";
    const root = mkdtempSync(join(tmpdir(), "folder-surrogate-boundary-"));
    const sourceDir = join(root, "docs");
    mkdirSync(sourceDir, { recursive: true });
    writeFileSync(join(sourceDir, "emoji-default.txt"), `${"a".repeat(39_999)}😀TAIL`);
    writeFileSync(join(sourceDir, "emoji-range.txt"), "HEAD😀TAIL");
    const source = makeSource(sessionId, sourceDir);
    const workspace = await getSessionWorkspace(sessionId, {
      resolveSkillDirs: () => [],
      resolveFolderSources: () => [source],
    });

    const defaultRead = await readDocumentForSession({
      sessionId,
      sources: [source],
      workspace,
      path: "/sources/source_docs/emoji-default.txt",
    });
    const highRange = await readDocumentForSession({
      sessionId,
      sources: [source],
      workspace,
      path: "/sources/source_docs/emoji-range.txt",
      range: { start: 4, length: 1 },
    });
    const lowRange = await readDocumentForSession({
      sessionId,
      sources: [source],
      workspace,
      path: "/sources/source_docs/emoji-range.txt",
      range: { start: 5, length: 1 },
    });

    expect(defaultRead.ok).toBe(true);
    expect(defaultRead.truncated).toBe(true);
    expect(hasLoneSurrogate(defaultRead.text)).toBe(false);
    expect(highRange.ok).toBe(true);
    expect(hasLoneSurrogate(highRange.text)).toBe(false);
    expect(lowRange.ok).toBe(true);
    expect(hasLoneSurrogate(lowRange.text)).toBe(false);

    await clearFolderSourceCache(sessionId, source.id);
  });

  it("searchDocuments 可扫描资料库并返回新鲜 BM25 结果", async () => {
    process.env.QINGAGENT_SANDBOX_ISOLATION = "none";
    const sessionId = "sess-folder-search";
    const root = mkdtempSync(join(tmpdir(), "folder-search-"));
    const sourceDir = join(root, "docs");
    mkdirSync(sourceDir, { recursive: true });
    writeFileSync(join(sourceDir, "apple.md"), "apple unique library note");
    writeFileSync(join(sourceDir, "orange.md"), "orange library note");
    const source = makeSource(sessionId, sourceDir);
    const workspace = await getSessionWorkspace(sessionId, {
      resolveSkillDirs: () => [],
      resolveFolderSources: () => [source],
    });

    const result = await searchDocumentsForSession({
      sessionId,
      sources: [source],
      workspace,
      query: "apple",
      topK: 3,
    });

    expect(result.ok).toBe(true);
    expect(result.results[0]?.path).toBe("/sources/source_docs/apple.md");
    expect(result.indexedCount).toBe(2);
    expect(JSON.stringify(result)).not.toContain(sourceDir);

    const second = await searchDocumentsForSession({
      sessionId,
      sources: [source],
      workspace,
      query: "apple",
      topK: 3,
    });
    expect(second.ok).toBe(true);
    expect(second.indexedCount).toBe(2);

    rmSync(join(sourceDir, "apple.md"));
    const afterDelete = await searchDocumentsForSession({
      sessionId,
      sources: [source],
      workspace,
      query: "apple",
      topK: 3,
    });
    expect(afterDelete.ok).toBe(true);
    expect(afterDelete.results.map((item) => item.path)).not.toContain("/sources/source_docs/apple.md");
    expect((await loadFolderSourceManifestEntries(sessionId, source.id)).map((entry) => entry.relPath)).not.toContain("apple.md");

    await clearFolderSourceCache(sessionId, source.id);
  });

  it("searchDocuments warm path 复用 manifest cached text，不再每轮全量 readFile", async () => {
    process.env.QINGAGENT_SANDBOX_ISOLATION = "none";
    const sessionId = "sess-folder-search-warm-no-preread";
    const root = mkdtempSync(join(tmpdir(), "folder-search-warm-no-preread-"));
    const sourceDir = join(root, "docs");
    mkdirSync(sourceDir, { recursive: true });
    writeFileSync(join(sourceDir, "apple.md"), "ROUND12_WARM_APPLE_TOKEN");
    writeFileSync(join(sourceDir, "orange.md"), "ROUND12_WARM_ORANGE_TOKEN");
    writeFileSync(join(sourceDir, "pear.md"), "ROUND12_WARM_PEAR_TOKEN");
    const source = makeSource(sessionId, sourceDir);
    await clearFolderSourceCache(sessionId, source.id);
    const workspace = await getSessionWorkspace(sessionId, {
      resolveSkillDirs: () => [],
      resolveFolderSources: () => [source],
    });

    const first = await searchDocumentsForSession({
      sessionId,
      sources: [source],
      workspace,
      query: "ROUND12_WARM_APPLE_TOKEN",
      topK: 1,
    });
    expect(first.ok).toBe(true);
    expect(first.indexedCount).toBe(3);

    const filesystem = workspace.filesystem!;
    const originalResolveAbsolutePath = filesystem.resolveAbsolutePath?.bind(filesystem);
    if (!originalResolveAbsolutePath) throw new Error("expected local resolveAbsolutePath");
    const readPaths: string[] = [];
    filesystem.resolveAbsolutePath = (path) => {
      readPaths.push(path);
      return originalResolveAbsolutePath(path);
    };
    try {
      const second = await searchDocumentsForSession({
        sessionId,
        sources: [source],
        workspace,
        query: "ROUND12_WARM_APPLE_TOKEN",
        topK: 1,
      });

      expect(second.ok).toBe(true);
      expect(second.results.map((item) => item.relPath)).toEqual(["apple.md"]);
      expect(readPaths).toEqual(["/sources/source_docs/apple.md"]);
    } finally {
      filesystem.resolveAbsolutePath = originalResolveAbsolutePath;
      await clearFolderSourceCache(sessionId, source.id);
    }
  });

  it("searchDocuments manifest 命中只读取 dirty 文件并用本轮 sha 跳过重复 freshness read", async () => {
    process.env.QINGAGENT_SANDBOX_ISOLATION = "none";
    const sessionId = "sess-folder-search-dirty-only";
    const root = mkdtempSync(join(tmpdir(), "folder-search-dirty-only-"));
    const sourceDir = join(root, "docs");
    mkdirSync(sourceDir, { recursive: true });
    writeFileSync(join(sourceDir, "cached-a.md"), "ROUND12_CACHED_A_TOKEN");
    writeFileSync(join(sourceDir, "cached-b.md"), "ROUND12_CACHED_B_TOKEN");
    const source = makeSource(sessionId, sourceDir);
    await clearFolderSourceCache(sessionId, source.id);
    const workspace = await getSessionWorkspace(sessionId, {
      resolveSkillDirs: () => [],
      resolveFolderSources: () => [source],
    });

    const warmup = await searchDocumentsForSession({
      sessionId,
      sources: [source],
      workspace,
      query: "ROUND12_CACHED",
      topK: 5,
    });
    expect(warmup.ok).toBe(true);
    expect(warmup.indexedCount).toBe(2);

    writeFileSync(join(sourceDir, "dirty.md"), "ROUND12_DIRTY_ONLY_TOKEN");
    const filesystem = workspace.filesystem!;
    const originalResolveAbsolutePath = filesystem.resolveAbsolutePath?.bind(filesystem);
    if (!originalResolveAbsolutePath) throw new Error("expected local resolveAbsolutePath");
    const readPaths: string[] = [];
    filesystem.resolveAbsolutePath = (path) => {
      readPaths.push(path);
      return originalResolveAbsolutePath(path);
    };
    try {
      const result = await searchDocumentsForSession({
        sessionId,
        sources: [source],
        workspace,
        query: "ROUND12_DIRTY_ONLY_TOKEN",
        topK: 3,
      });

      expect(result.ok).toBe(true);
      expect(result.results.map((item) => item.relPath)).toEqual(["dirty.md"]);
      expect(readPaths).toEqual(["/sources/source_docs/dirty.md"]);
    } finally {
      filesystem.resolveAbsolutePath = originalResolveAbsolutePath;
      await clearFolderSourceCache(sessionId, source.id);
    }
  });

  it("browser-fs-access 经真实 SessionWorkspace 读文档和检索，与 desktop source 结果一致", async () => {
    process.env.QINGAGENT_SANDBOX_ISOLATION = "none";
    process.env.QINGAGENT_ENABLE_BROWSER_FOLDER_SOURCES = "1";
    const body = "Alpha 管理流程\n第二行 CJK_BROWSER_PARITY_TOKEN";
    const desktopSessionId = "sess-folder-desktop-parity";
    const browserSessionId = "sess-folder-browser-parity";
    const root = mkdtempSync(join(tmpdir(), "folder-browser-parity-"));
    const sourceDir = join(root, "docs");
    mkdirSync(join(sourceDir, "docs"), { recursive: true });
    writeFileSync(join(sourceDir, "docs", "ok.md"), body);
    writeFileSync(join(sourceDir, "docs", "empty.md"), "");
    const desktopSource = makeSource(desktopSessionId, sourceDir);
    const browserSource = makeBrowserSource(browserSessionId);
    const fixture = installBrowserBridgeFixture(browserSource, new Map([
      ["docs/ok.md", body],
      ["docs/empty.md", ""],
    ]));

    try {
      const desktopWorkspace = await getSessionWorkspace(desktopSessionId, {
        resolveSkillDirs: () => [],
        resolveFolderSources: () => [desktopSource],
      });
      const browserWorkspace = await getSessionWorkspace(browserSessionId, {
        resolveSkillDirs: () => [],
        resolveFolderSources: () => [browserSource],
      });

      const desktopRead = await readDocumentForSession({
        sessionId: desktopSessionId,
        sources: [desktopSource],
        workspace: desktopWorkspace,
        path: "/sources/source_docs/docs/ok.md",
      });
      const browserRead = await readDocumentForSession({
        sessionId: browserSessionId,
        sources: [browserSource],
        workspace: browserWorkspace,
        path: "/sources/source_browser_docs/docs/ok.md",
      });
      expect(browserRead.ok).toBe(true);
      expect(desktopRead.ok).toBe(true);
      expect(browserRead.text).toBe(desktopRead.text);
      expect(browserRead.text).toContain("CJK_BROWSER_PARITY_TOKEN");

      const browserEmpty = await readDocumentForSession({
        sessionId: browserSessionId,
        sources: [browserSource],
        workspace: browserWorkspace,
        path: "/sources/source_browser_docs/docs/empty.md",
      });
      expect(browserEmpty.ok).toBe(true);
      expect(browserEmpty.text).toBe("");

      const desktopSearch = await searchDocumentsForSession({
        sessionId: desktopSessionId,
        sources: [desktopSource],
        workspace: desktopWorkspace,
        query: "管理",
        topK: 3,
      });
      const browserSearch = await searchDocumentsForSession({
        sessionId: browserSessionId,
        sources: [browserSource],
        workspace: browserWorkspace,
        query: "管理",
        topK: 3,
      });
      expect(browserSearch.ok).toBe(true);
      expect(desktopSearch.ok).toBe(true);
      expect(browserSearch.results[0]?.relPath).toBe(desktopSearch.results[0]?.relPath);
      expect(browserSearch.results[0]?.text).toContain("管理流程");
      expect(fixture.requests.map((request) => request.relPath)).toEqual(
        expect.arrayContaining(["docs/ok.md", "docs/empty.md", ""]),
      );
      expect(fixture.requests.some((request) => request.relPath.startsWith("/"))).toBe(false);
    } finally {
      fixture.close();
      await clearFolderSourceCache(desktopSessionId, desktopSource.id);
      await clearFolderSourceCache(browserSessionId, browserSource.id);
    }
  });

  it("searchDocuments 在浏览器目录可列但全候选读取失败时返回 ok=false", async () => {
    process.env.QINGAGENT_SANDBOX_ISOLATION = "none";
    process.env.QINGAGENT_ENABLE_BROWSER_FOLDER_SOURCES = "1";
    const sessionId = "sess-folder-browser-all-denied";
    const source = makeBrowserSource(sessionId);
    const fixture = installBrowserBridgeFixture(source, new Map([
      ["alpha.md", "alpha keyword in denied document"],
      ["beta.md", "alpha keyword in another denied document"],
    ]), {
      readFailure: "NotAllowedError: permission denied by browser",
    });

    try {
      const workspace = await getSessionWorkspace(sessionId, {
        resolveSkillDirs: () => [],
        resolveFolderSources: () => [source],
      });
      const result = await searchDocumentsForSession({
        sessionId,
        sources: [source],
        workspace,
        query: "alpha",
        topK: 5,
      });

      expect(result.ok).toBe(false);
      expect(result.results).toEqual([]);
      expect(result.error).toBeTruthy();
      expect(result.error).toContain("folder documents");
      expect(JSON.stringify(result)).not.toContain("alpha.md");
      expect(result.scannedCount).toBe(2);
      expect(result.fileCountCapped).toBe(false);
      expect(fixture.requests.filter((request) => request.op === "readFile")).toHaveLength(2);
    } finally {
      fixture.close();
      await clearFolderSourceCache(sessionId, source.id);
    }
  });

  it("web bridge readFile ok:false 不把客户端错误透传到 readDocument 或 span summary", async () => {
    process.env.QINGAGENT_SANDBOX_ISOLATION = "none";
    process.env.QINGAGENT_ENABLE_BROWSER_FOLDER_SOURCES = "1";
    const sessionId = "sess-folder-browser-error-redaction";
    const source = makeBrowserSource(sessionId);
    const forbiddenPath = "/Users/alice/PrivateRound14/leak.md";
    const forbiddenMarker = "ROUND14_BROWSER_FILE_BODY_SHOULD_NOT_LEAK";
    const fixture = installBrowserBridgeFixture(source, new Map([
      ["leak.md", `${forbiddenMarker}\nvisible document body`],
    ]), {
      readFailure: `NotAllowedError: denied reading ${forbiddenPath}; preview=${forbiddenMarker}`,
    });

    try {
      const workspace = await getSessionWorkspace(sessionId, {
        resolveSkillDirs: () => [],
        resolveFolderSources: () => [source],
      });
      const result = await readDocumentForSession({
        sessionId,
        sources: [source],
        workspace,
        path: "/sources/source_browser_docs/leak.md",
      });
      const serializedResult = JSON.stringify(result);
      const spanSummary = summarizeToolOutputForSpan("readDocument", result);
      const serializedSpan = JSON.stringify(spanSummary);

      expect(result.ok).toBe(false);
      expect(result.error).toBe("browser folder request failed");
      expect(serializedResult).not.toContain(forbiddenPath);
      expect(serializedResult).not.toContain(forbiddenMarker);
      expect(serializedSpan).not.toContain(forbiddenPath);
      expect(serializedSpan).not.toContain(forbiddenMarker);
    } finally {
      fixture.close();
      await clearFolderSourceCache(sessionId, source.id);
    }
  });

  it("web bridge stat ok:false 同样不透传客户端错误", async () => {
    process.env.QINGAGENT_SANDBOX_ISOLATION = "none";
    process.env.QINGAGENT_ENABLE_BROWSER_FOLDER_SOURCES = "1";
    const sessionId = "sess-folder-browser-stat-error-redaction";
    const source = makeBrowserSource(sessionId);
    const forbiddenPath = "/Users/alice/PrivateRound14/stat-leak.md";
    const forbiddenMarker = "ROUND14_BROWSER_STAT_ERROR_SHOULD_NOT_LEAK";
    const fixture = installBrowserBridgeFixture(source, new Map([
      ["stat-leak.md", "visible body"],
    ]), {
      statFailure: `NotFoundError: ${forbiddenPath}; marker=${forbiddenMarker}`,
    });

    try {
      const workspace = await getSessionWorkspace(sessionId, {
        resolveSkillDirs: () => [],
        resolveFolderSources: () => [source],
      });
      const result = await readDocumentForSession({
        sessionId,
        sources: [source],
        workspace,
        path: "/sources/source_browser_docs/stat-leak.md",
      });
      const spanSummary = summarizeToolOutputForSpan("readDocument", result);
      const serialized = JSON.stringify({ result, spanSummary });

      expect(result.ok).toBe(false);
      expect(result.error).toBe("browser folder request failed");
      expect(serialized).not.toContain(forbiddenPath);
      expect(serialized).not.toContain(forbiddenMarker);
    } finally {
      fixture.close();
      await clearFolderSourceCache(sessionId, source.id);
    }
  });

  it("readDocument 不把浏览器 stat mimeType 原文写进 unsupported 错误", async () => {
    const sessionId = "sess-folder-browser-mime-redaction";
    const source = makeBrowserSource(sessionId);
    const forbiddenMime = "application/x-private; path=/Users/alice/PrivateRound14/leak";
    let readCalls = 0;
    const workspace = {
      filesystem: {
        stat: async () => ({
          name: "leak",
          path: "/sources/source_browser_docs/leak",
          type: "file" as const,
          size: 12,
          createdAt: new Date("2026-06-18T00:00:00.000Z"),
          modifiedAt: new Date("2026-06-18T00:00:00.000Z"),
          mimeType: forbiddenMime,
        }),
        readFile: async () => {
          readCalls += 1;
          return Buffer.from("ROUND14_MIME_BODY_SHOULD_NOT_BE_READ", "utf8");
        },
      },
    } as unknown as Workspace;

    const result = await readDocumentForSession({
      sessionId,
      sources: [source],
      workspace,
      path: "/sources/source_browser_docs/leak",
    });
    const serialized = JSON.stringify(result);

    expect(result.ok).toBe(false);
    expect(result.error).toBe("unsupported: file type is not supported in P0");
    expect(serialized).not.toContain(forbiddenMime);
    expect(serialized).not.toContain("PrivateRound14");
    expect(readCalls).toBe(0);
  });

  it("searchDocuments 在浏览器部分候选读取失败时仍返回可读命中", async () => {
    process.env.QINGAGENT_SANDBOX_ISOLATION = "none";
    process.env.QINGAGENT_ENABLE_BROWSER_FOLDER_SOURCES = "1";
    const sessionId = "sess-folder-browser-partial-denied";
    const source = makeBrowserSource(sessionId);
    const fixture = installBrowserBridgeFixture(source, new Map([
      ["bad.md", "needle denied text should not be indexed"],
      ["good.md", "needle retained searchable text"],
    ]), {
      readFailure: (relPath) => relPath === "bad.md" ? "NotAllowedError: denied bad.md" : null,
    });

    try {
      const workspace = await getSessionWorkspace(sessionId, {
        resolveSkillDirs: () => [],
        resolveFolderSources: () => [source],
      });
      const result = await searchDocumentsForSession({
        sessionId,
        sources: [source],
        workspace,
        query: "needle",
        topK: 5,
      });

      expect(result.ok).toBe(true);
      expect(result.results.map((item) => item.relPath)).toEqual(["good.md"]);
      expect(result.indexedCount).toBe(1);
      expect(result.scannedCount).toBe(2);
    } finally {
      fixture.close();
      await clearFolderSourceCache(sessionId, source.id);
    }
  });

  it("searchDocuments 在浏览器空目录无候选时仍返回合法空结果", async () => {
    process.env.QINGAGENT_SANDBOX_ISOLATION = "none";
    process.env.QINGAGENT_ENABLE_BROWSER_FOLDER_SOURCES = "1";
    const sessionId = "sess-folder-browser-empty-candidates";
    const source = makeBrowserSource(sessionId);
    const fixture = installBrowserBridgeFixture(source, new Map());

    try {
      const workspace = await getSessionWorkspace(sessionId, {
        resolveSkillDirs: () => [],
        resolveFolderSources: () => [source],
      });
      const result = await searchDocumentsForSession({
        sessionId,
        sources: [source],
        workspace,
        query: "nothing",
        topK: 5,
      });

      expect(result.ok).toBe(true);
      expect(result.results).toEqual([]);
      expect(result.indexedCount).toBe(0);
      expect(result.scannedCount).toBe(0);
      expect(fixture.requests.some((request) => request.op === "readFile")).toBe(false);
    } finally {
      fixture.close();
      await clearFolderSourceCache(sessionId, source.id);
    }
  });

  it("searchDocuments 对浏览器桥检索 I/O 使用有界并发且结果与串行一致", async () => {
    process.env.QINGAGENT_SANDBOX_ISOLATION = "none";
    process.env.QINGAGENT_ENABLE_BROWSER_FOLDER_SOURCES = "1";
    const files = new Map<string, string>();
    const rankingTerms = ["alpha", "bravo", "charlie", "delta", "echo"];
    for (let index = 0; index < 40; index += 1) {
      files.set(
        `docs/doc-${String(index).padStart(2, "0")}.md`,
        [
          `ROUND13_CONCURRENCY_TOKEN doc ${index}`,
          ...rankingTerms.slice(Math.min(index, rankingTerms.length)),
        ].join(" "),
      );
    }

    async function runSearch(sessionId: string, ioConcurrency: number) {
      const source = {
        ...makeBrowserSource(sessionId),
        id: "fld_browser_concurrency",
        mountName: "source_browser_concurrency",
        mountPath: "/sources/source_browser_concurrency",
        browserClientSourceId: `client_${sessionId}`,
      } satisfies FolderSourceRecord;
      const fixture = installBrowserBridgeFixture(source, files, { delayMs: 4 });
      try {
        const workspace = await getSessionWorkspace(sessionId, {
          resolveSkillDirs: () => [],
          resolveFolderSources: () => [source],
        });
        const startedAt = Date.now();
        const result = await searchDocumentsForSession({
          sessionId,
          sources: [source],
          workspace,
          query: "ROUND13_CONCURRENCY_TOKEN alpha bravo charlie delta echo",
          topK: 5,
          ioConcurrency,
        });
        return {
          elapsedMs: Date.now() - startedAt,
          result,
          maxInflight: fixture.maxInflight(),
        };
      } finally {
        fixture.close();
        await clearFolderSourceCache(sessionId, source.id);
      }
    }

    const serial = await runSearch("sess-folder-browser-serial-search", 1);
    const concurrent = await runSearch("sess-folder-browser-concurrent-search", 8);
    const compact = (result: Awaited<ReturnType<typeof searchDocumentsForSession>>) =>
      result.results.map((item) => ({
        path: item.path,
        folderId: item.folderId,
        relPath: item.relPath,
        text: item.text,
      }));

    expect(serial.result.ok).toBe(true);
    expect(concurrent.result.ok).toBe(true);
    expect(compact(concurrent.result)).toEqual(compact(serial.result));
    expect(concurrent.result.indexedCount).toBe(serial.result.indexedCount);
    expect(concurrent.maxInflight).toBeGreaterThan(1);
    expect(concurrent.elapsedMs).toBeLessThan(serial.elapsedMs * 0.65);
  });

  it("searchDocuments 返回有界命中片段而不是整篇大文档", async () => {
    process.env.QINGAGENT_SANDBOX_ISOLATION = "none";
    const sessionId = "sess-folder-search-snippet-cap";
    const root = mkdtempSync(join(tmpdir(), "folder-search-snippet-cap-"));
    const sourceDir = join(root, "docs");
    mkdirSync(sourceDir, { recursive: true });
    const needle = "ROUND10_SEARCHCAP_TARGET";
    const before = "alpha filler ".repeat(6_000);
    const after = "omega filler ".repeat(9_000);
    for (let index = 0; index < 8; index += 1) {
      writeFileSync(
        join(sourceDir, `large-${index}.md`),
        `${before}${needle} doc-${index}\n${after}ROUND10_SEARCHCAP_TAIL_${index}`,
      );
    }
    const source = makeSource(sessionId, sourceDir);
    const workspace = await getSessionWorkspace(sessionId, {
      resolveSkillDirs: () => [],
      resolveFolderSources: () => [source],
    });

    const result = await searchDocumentsForSession({
      sessionId,
      sources: [source],
      workspace,
      query: needle,
      topK: 8,
    });

    expect(result.ok).toBe(true);
    expect(result.results).toHaveLength(8);
    const totalTextLength = result.results.reduce((sum, item) => sum + item.text.length, 0);
    expect(totalTextLength).toBeLessThanOrEqual(8 * 800);
    for (const item of result.results) {
      expect(item.text.length).toBeLessThanOrEqual(800);
      expect(item.text).toContain(needle);
      expect(item.text).not.toContain("ROUND10_SEARCHCAP_TAIL");
    }

    await clearFolderSourceCache(sessionId, source.id);
  });

  it("searchDocuments 在极低缓存限额下仍能检索本轮预读成功的文档", async () => {
    process.env.QINGAGENT_SANDBOX_ISOLATION = "none";
    const savedSessionLimit = process.env.QINGAGENT_FOLDER_CACHE_SESSION_MAX_BYTES;
    const savedTotalLimit = process.env.QINGAGENT_FOLDER_CACHE_MAX_BYTES;
    process.env.QINGAGENT_FOLDER_CACHE_SESSION_MAX_BYTES = "128";
    process.env.QINGAGENT_FOLDER_CACHE_MAX_BYTES = "1048576";
    const sessionId = "sess-folder-search-low-cache-limit";
    const root = mkdtempSync(join(tmpdir(), "folder-search-low-cache-"));
    const sourceDir = join(root, "docs");
    mkdirSync(sourceDir, { recursive: true });
    const needle = "ROUND14_LOW_CACHE_LIMIT_NEEDLE";
    writeFileSync(join(sourceDir, "needle.md"), `${needle}\n${"x".repeat(2048)}\n`);
    const source = makeSource(sessionId, sourceDir);

    try {
      const workspace = await getSessionWorkspace(sessionId, {
        resolveSkillDirs: () => [],
        resolveFolderSources: () => [source],
      });
      const result = await searchDocumentsForSession({
        sessionId,
        sources: [source],
        workspace,
        query: needle,
        topK: 3,
      });

      expect(result.ok).toBe(true);
      expect(result.indexedCount).toBe(1);
      expect(result.results.some((item) => item.relPath === "needle.md" && item.text.includes(needle))).toBe(true);
    } finally {
      if (savedSessionLimit === undefined) delete process.env.QINGAGENT_FOLDER_CACHE_SESSION_MAX_BYTES;
      else process.env.QINGAGENT_FOLDER_CACHE_SESSION_MAX_BYTES = savedSessionLimit;
      if (savedTotalLimit === undefined) delete process.env.QINGAGENT_FOLDER_CACHE_MAX_BYTES;
      else process.env.QINGAGENT_FOLDER_CACHE_MAX_BYTES = savedTotalLimit;
      await clearFolderSourceCache(sessionId, source.id);
    }
  });

  it("searchDocuments 删除大量旧命中后不会让 stale BM25 挤掉 fresh 结果", async () => {
    process.env.QINGAGENT_SANDBOX_ISOLATION = "none";
    const sessionId = "sess-folder-search-stale-window";
    const root = mkdtempSync(join(tmpdir(), "folder-search-stale-window-"));
    const sourceDir = join(root, "docs");
    mkdirSync(sourceDir, { recursive: true });
    for (let index = 0; index < 36; index += 1) {
      writeFileSync(join(sourceDir, `stale-${index}.md`), `ROUND4_STALE_WINDOW_TOKEN old ${index}`);
    }
    const source = makeSource(sessionId, sourceDir);
    const workspace = await getSessionWorkspace(sessionId, {
      resolveSkillDirs: () => [],
      resolveFolderSources: () => [source],
    });

    const initial = await searchDocumentsForSession({
      sessionId,
      sources: [source],
      workspace,
      query: "ROUND4_STALE_WINDOW_TOKEN",
      topK: 4,
    });
    expect(initial.ok).toBe(true);
    expect(initial.results.length).toBeGreaterThan(0);

    for (let index = 0; index < 36; index += 1) {
      rmSync(join(sourceDir, `stale-${index}.md`));
    }
    writeFileSync(join(sourceDir, "fresh.md"), "ROUND4_STALE_WINDOW_TOKEN fresh");

    const afterChurn = await searchDocumentsForSession({
      sessionId,
      sources: [source],
      workspace,
      query: "ROUND4_STALE_WINDOW_TOKEN",
      topK: 4,
    });

    expect(afterChurn.ok).toBe(true);
    expect(afterChurn.results.map((item) => item.path)).toEqual(["/sources/source_docs/fresh.md"]);
    expect((await loadFolderSourceManifestEntries(sessionId, source.id)).map((entry) => entry.relPath)).toEqual(["fresh.md"]);

    await clearFolderSourceCache(sessionId, source.id);
  });

  it("readDocument 对解析失败不缓存不索引，但 0 字节 txt 仍可读", async () => {
    process.env.QINGAGENT_SANDBOX_ISOLATION = "none";
    const sessionId = "sess-folder-parse-failure";
    const root = mkdtempSync(join(tmpdir(), "folder-parse-failure-"));
    const sourceDir = join(root, "docs");
    mkdirSync(sourceDir, { recursive: true });
    writeFileSync(join(sourceDir, "zero.txt"), Buffer.alloc(0));
    writeFileSync(join(sourceDir, "fake.xlsx"), "not a zip xlsx");
    writeFileSync(join(sourceDir, "binary.txt"), Buffer.from("BINARY_ASCII_TOKEN\u0000after", "utf8"));
    const source = makeSource(sessionId, sourceDir);
    const workspace = await getSessionWorkspace(sessionId, {
      resolveSkillDirs: () => [],
      resolveFolderSources: () => [source],
    });

    const zero = await readDocumentForSession({
      sessionId,
      sources: [source],
      workspace,
      path: "/sources/source_docs/zero.txt",
    });
    const fakeXlsx = await readDocumentForSession({
      sessionId,
      sources: [source],
      workspace,
      path: "/sources/source_docs/fake.xlsx",
    });
    const binary = await readDocumentForSession({
      sessionId,
      sources: [source],
      workspace,
      path: "/sources/source_docs/binary.txt",
    });

    expect(zero).toMatchObject({ ok: true, text: "", wordCount: 0 });
    expect(fakeXlsx.ok).toBe(false);
    expect(fakeXlsx.error).toContain("Failed to parse Excel file");
    expect(binary.ok).toBe(false);
    expect(binary.error).toContain("Failed to parse text file");
    const entries = await loadFolderSourceManifestEntries(sessionId, source.id);
    expect(entries.map((entry) => entry.relPath)).toEqual(["zero.txt"]);

    const parseErrorSearch = await searchDocumentsForSession({
      sessionId,
      sources: [source],
      workspace,
      query: "Failed parse Excel",
      topK: 5,
    });
    const binarySearch = await searchDocumentsForSession({
      sessionId,
      sources: [source],
      workspace,
      query: "BINARY_ASCII_TOKEN",
      topK: 5,
    });
    expect(parseErrorSearch.ok).toBe(true);
    expect(parseErrorSearch.results).toEqual([]);
    expect(binarySearch.ok).toBe(true);
    expect(binarySearch.results).toEqual([]);

    await clearFolderSourceCache(sessionId, source.id);
  });

  it("readDocument 对 >50MB 文件在 readFile 前拒绝，并同样限制图片路径", async () => {
    const sessionId = "sess-folder-too-large-early";
    const source = makeSource(sessionId, "/virtual/too-large-root");
    let readCalls = 0;
    const hugeStat = {
      name: "too-large.txt",
      path: "/sources/source_docs/too-large.txt",
      type: "file" as const,
      size: 50 * 1024 * 1024 + 1,
      createdAt: new Date("2026-06-18T00:00:00.000Z"),
      modifiedAt: new Date("2026-06-18T00:00:00.000Z"),
      mimeType: "text/plain",
    };
    const fakeWorkspace = {
      filesystem: {
        stat: async (path: string) => ({
          ...hugeStat,
          name: path.endsWith(".png") ? "too-large.png" : "too-large.txt",
          path,
          mimeType: path.endsWith(".png") ? "image/png" : "text/plain",
        }),
        readFile: async () => {
          readCalls += 1;
          return Buffer.from("TOO_LARGE_BODY_SHOULD_NOT_BE_READ", "utf8");
        },
      },
    } as unknown as Workspace;

    const textResult = await readDocumentForSession({
      sessionId,
      sources: [source],
      workspace: fakeWorkspace,
      path: "/sources/source_docs/too-large.txt",
    });
    const imageResult = await readDocumentForSession({
      sessionId,
      sources: [source],
      workspace: fakeWorkspace,
      path: "/sources/source_docs/too-large.png",
    });

    expect(textResult.ok).toBe(false);
    expect(textResult.error).toContain("too large");
    expect(imageResult.ok).toBe(false);
    expect(imageResult.error).toContain("too large");
    expect(readCalls).toBe(0);
  });

  it("readDocument 在 stat 后文件被替换为超大文件时有界拒绝，不整体读入", async () => {
    process.env.QINGAGENT_SANDBOX_ISOLATION = "none";
    const sessionId = "sess-folder-bounded-toctou";
    const root = mkdtempSync(join(tmpdir(), "folder-bounded-toctou-"));
    const sourceDir = join(root, "docs");
    mkdirSync(sourceDir, { recursive: true });
    const file = join(sourceDir, "race.md");
    writeFileSync(file, "SMALL_BEFORE_STAT_READ_RACE", "utf8");
    const source = makeSource(sessionId, sourceDir);
    await clearFolderSourceCache(sessionId, source.id);
    const workspace = await getSessionWorkspace(sessionId, {
      resolveSkillDirs: () => [],
      resolveFolderSources: () => [source],
    });
    const filesystem = workspace.filesystem!;
    const originalStat = filesystem.stat.bind(filesystem);
    let replaced = false;
    filesystem.stat = async (path) => {
      const before = await originalStat(path);
      if (path === "/sources/source_docs/race.md" && !replaced) {
        truncateSync(file, 50 * 1024 * 1024 + 1);
        replaced = true;
      }
      return before;
    };

    try {
      const result = await readDocumentForSession({
        sessionId,
        sources: [source],
        workspace,
        path: "/sources/source_docs/race.md",
      });
      expect(replaced).toBe(true);
      expect(result.ok).toBe(false);
      expect(result.error).toContain("too large");
      expect(statSync(file).size).toBe(50 * 1024 * 1024 + 1);
    } finally {
      filesystem.stat = originalStat;
      await clearFolderSourceCache(sessionId, source.id);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("readDocument 对资料库图片返回诚实 P0 文案且不承诺 readImage", async () => {
    const sessionId = "sess-folder-image-p0";
    const source = makeSource(sessionId, "/private/folder-image-root");
    const fakeWorkspace = {
      filesystem: {
        stat: async (path: string) => ({
          name: "pixel.png",
          path,
          type: "file" as const,
          size: 70,
          createdAt: new Date("2026-06-18T00:00:00.000Z"),
          modifiedAt: new Date("2026-06-18T00:00:00.000Z"),
          mimeType: "image/png",
        }),
        readFile: async () => Buffer.from("IMAGE_BODY_SHOULD_NOT_BE_READ", "utf8"),
      },
    } as unknown as Workspace;

    const result = await readDocumentForSession({
      sessionId,
      sources: [source],
      workspace: fakeWorkspace,
      path: "/sources/source_docs/pixel.png",
    });

    expect(result).toMatchObject({ ok: true, cacheHit: false });
    expect(result.text).toContain("P0 暂不支持资料库内图片识别");
    expect(result.text).not.toContain("readImage");
    expect(JSON.stringify(result)).not.toContain("/private/folder-image-root");
    await clearFolderSourceCache(sessionId, source.id);
  });

  it("readDocument 遇到解析缓存写入失败仍返回正文", async () => {
    process.env.QINGAGENT_SANDBOX_ISOLATION = "none";
    const sessionId = "sess-folder-cache-write-failure";
    const root = mkdtempSync(join(tmpdir(), "folder-cache-write-failure-"));
    const sourceDir = join(root, "docs");
    mkdirSync(sourceDir, { recursive: true });
    writeFileSync(join(sourceDir, "note.md"), "ROUND7_CACHE_WRITE_BODY should still be returned");
    const source = makeSource(sessionId, sourceDir);
    const workspace = await getSessionWorkspace(sessionId, {
      resolveSkillDirs: () => [],
      resolveFolderSources: () => [source],
    });
    const blocker = join(
      QINGAGENT_DATA_DIR,
      "folder-source-cache",
      sessionWorkspaceDirName(sessionId),
      source.id,
    );
    mkdirSync(dirname(blocker), { recursive: true });
    writeFileSync(blocker, "file where cache directory should be");

    const result = await readDocumentForSession({
      sessionId,
      sources: [source],
      workspace,
      path: "/sources/source_docs/note.md",
    });

    expect(result.ok).toBe(true);
    expect(result.cacheHit).toBe(false);
    expect(result.text).toContain("ROUND7_CACHE_WRITE_BODY");
    expect(result.error).toBeUndefined();

    await clearFolderSourceCache(sessionId, source.id);
  });

  it("readDocument 缓存命中后 manifest 触摸失败仍返回缓存正文", async () => {
    process.env.QINGAGENT_SANDBOX_ISOLATION = "none";
    const sessionId = "sess-folder-cache-hit-touch-failure";
    const root = mkdtempSync(join(tmpdir(), "folder-cache-hit-touch-failure-"));
    const sourceDir = join(root, "docs");
    mkdirSync(sourceDir, { recursive: true });
    writeFileSync(join(sourceDir, "hit.md"), "ROUND7_CACHE_HIT_BODY should survive manifest touch failure");
    const source = makeSource(sessionId, sourceDir);
    const workspace = await getSessionWorkspace(sessionId, {
      resolveSkillDirs: () => [],
      resolveFolderSources: () => [source],
    });

    const first = await readDocumentForSession({
      sessionId,
      sources: [source],
      workspace,
      path: "/sources/source_docs/hit.md",
    });
    expect(first.ok).toBe(true);
    const manifest = join(
      QINGAGENT_DATA_DIR,
      "folder-source-cache",
      sessionWorkspaceDirName(sessionId),
      source.id,
      "manifest.json",
    );
    if (existsSync(manifest)) chmodSync(manifest, 0o444);
    let second: Awaited<ReturnType<typeof readDocumentForSession>>;
    try {
      second = await readDocumentForSession({
        sessionId,
        sources: [source],
        workspace,
        path: "/sources/source_docs/hit.md",
      });
    } finally {
      if (existsSync(manifest)) chmodSync(manifest, 0o644);
    }

    expect(second.ok).toBe(true);
    expect(second.cacheHit).toBe(true);
    expect(second.text).toContain("ROUND7_CACHE_HIT_BODY");

    await clearFolderSourceCache(sessionId, source.id);
  });

  it("readDocument 不把资料库正文写入会话 BM25，searchDocuments 仍可独立检索", async () => {
    process.env.QINGAGENT_SANDBOX_ISOLATION = "none";
    const sessionId = "sess-folder-read-no-session-index";
    const root = mkdtempSync(join(tmpdir(), "folder-read-no-session-index-"));
    const sourceDir = join(root, "docs");
    mkdirSync(sourceDir, { recursive: true });
    writeFileSync(join(sourceDir, "index.md"), "ROUND17_READ_NO_SESSION_INDEX body should be visible");
    const source = makeSource(sessionId, sourceDir);
    const workspace = await getSessionWorkspace(sessionId, {
      resolveSkillDirs: () => [],
      resolveFolderSources: () => [source],
    });

    const result = await readDocumentForSession({
      sessionId,
      sources: [source],
      workspace,
      path: "/sources/source_docs/index.md",
    });

    expect(result.ok).toBe(true);
    expect(result.text).toContain("ROUND17_READ_NO_SESSION_INDEX");
    expect((await loadFolderSourceManifestEntries(sessionId, source.id)).map((entry) => entry.relPath)).toContain("index.md");

    const genericSearch = await workspace.search("ROUND17_READ_NO_SESSION_INDEX", {
      mode: "bm25",
      topK: 3,
    });
    expect(JSON.stringify(genericSearch)).not.toContain("ROUND17_READ_NO_SESSION_INDEX");
    expect(JSON.stringify(genericSearch)).not.toContain("/sources/source_docs/index.md");

    const dedicatedSearch = await searchDocumentsForSession({
      sessionId,
      sources: [source],
      workspace,
      query: "ROUND17_READ_NO_SESSION_INDEX",
      topK: 3,
    });
    expect(dedicatedSearch.ok).toBe(true);
    expect(dedicatedSearch.results[0]?.path).toBe("/sources/source_docs/index.md");
    expect(JSON.stringify(dedicatedSearch)).toContain("ROUND17_READ_NO_SESSION_INDEX");

    await clearFolderSourceCache(sessionId, source.id);
  });

  it("searchDocuments 跳过内部 symlink 目录环，避免重复索引幽灵路径", async () => {
    process.env.QINGAGENT_SANDBOX_ISOLATION = "none";
    const sessionId = "sess-folder-symlink-loop-scan";
    const root = mkdtempSync(join(tmpdir(), "folder-symlink-loop-scan-"));
    const sourceDir = join(root, "docs");
    mkdirSync(sourceDir, { recursive: true });
    writeFileSync(join(sourceDir, "normal.md"), "ROUND17_LOOP_NORMAL_TOKEN");
    symlinkSync(".", join(sourceDir, "loop"), "dir");
    const source = makeSource(sessionId, sourceDir);
    const workspace = await getSessionWorkspace(sessionId, {
      resolveSkillDirs: () => [],
      resolveFolderSources: () => [source],
    });

    const result = await searchDocumentsForSession({
      sessionId,
      sources: [source],
      workspace,
      query: "ROUND17_LOOP_NORMAL_TOKEN",
      topK: 5,
    });

    expect(result.ok).toBe(true);
    expect(result.scannedCount).toBe(1);
    expect(result.indexedCount).toBe(1);
    expect(result.results.map((item) => item.path)).toEqual(["/sources/source_docs/normal.md"]);
    expect(JSON.stringify(result)).not.toContain("/loop/");

    await clearFolderSourceCache(sessionId, source.id);
  });

  it("searchDocuments 拒绝超长 query 且不原样回显，正常 query 不受影响", async () => {
    process.env.QINGAGENT_SANDBOX_ISOLATION = "none";
    const sessionId = "sess-folder-search-query-cap";
    const root = mkdtempSync(join(tmpdir(), "folder-search-query-cap-"));
    const sourceDir = join(root, "docs");
    mkdirSync(sourceDir, { recursive: true });
    writeFileSync(join(sourceDir, "normal.md"), "ROUND17_QUERY_CAP_NORMAL");
    const source = makeSource(sessionId, sourceDir);
    const workspace = await getSessionWorkspace(sessionId, {
      resolveSkillDirs: () => [],
      resolveFolderSources: () => [source],
    });
    const tooLongQuery = `ROUND17_TOO_LONG_${"x".repeat(60_000)}`;

    const rejected = await searchDocumentsForSession({
      sessionId,
      sources: [source],
      workspace,
      query: tooLongQuery,
      topK: 3,
    });

    expect(rejected.ok).toBe(false);
    expect(rejected.query).toBe("");
    expect(rejected.error).toContain("max 1000");
    expect(JSON.stringify(rejected).length).toBeLessThan(500);
    expect(JSON.stringify(rejected)).not.toContain("ROUND17_TOO_LONG");

    const accepted = await searchDocumentsForSession({
      sessionId,
      sources: [source],
      workspace,
      query: "ROUND17_QUERY_CAP_NORMAL",
      topK: 3,
    });
    expect(accepted.ok).toBe(true);
    expect(accepted.results[0]?.path).toBe("/sources/source_docs/normal.md");

    await clearFolderSourceCache(sessionId, source.id);
  });

  it("searchDocuments 扫描上限只统计受支持文件", async () => {
    process.env.QINGAGENT_SANDBOX_ISOLATION = "none";
    const sessionId = "sess-folder-scan-cap-supported";
    const root = mkdtempSync(join(tmpdir(), "folder-scan-cap-supported-"));
    const sourceDir = join(root, "docs");
    mkdirSync(sourceDir, { recursive: true });
    for (let index = 0; index < 5_010; index += 1) {
      writeFileSync(join(sourceDir, `unsupported-${index}.bin`), "ROUND4_UNSUPPORTED_NOISE");
    }
    writeFileSync(join(sourceDir, "target.md"), "ROUND4_SCAN_CAP_TARGET");
    const source = makeSource(sessionId, sourceDir);
    const workspace = await getSessionWorkspace(sessionId, {
      resolveSkillDirs: () => [],
      resolveFolderSources: () => [source],
    });

    const result = await searchDocumentsForSession({
      sessionId,
      sources: [source],
      workspace,
      query: "ROUND4_SCAN_CAP_TARGET",
      topK: 3,
    });

    expect(result.ok).toBe(true);
    expect(result.scannedCount).toBe(1);
    expect(result.fileCountCapped).toBe(false);
    expect(result.indexedCount).toBe(1);
    expect(result.results[0]?.path).toBe("/sources/source_docs/target.md");

    await clearFolderSourceCache(sessionId, source.id);
  });

  it("searchDocuments indexedCount 只统计真正写入索引的文档", async () => {
    process.env.QINGAGENT_SANDBOX_ISOLATION = "none";
    const sessionId = "sess-folder-indexed-count";
    const root = mkdtempSync(join(tmpdir(), "folder-indexed-count-"));
    const sourceDir = join(root, "docs");
    mkdirSync(sourceDir, { recursive: true });
    writeFileSync(join(sourceDir, "only-valid.md"), "ROUND4_INDEXED_COUNT_VALID");
    writeFileSync(join(sourceDir, "legacy.xls"), Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0x00, 0x01]));
    writeFileSync(join(sourceDir, "legacy.ppt"), Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0x00, 0x01]));
    const source = makeSource(sessionId, sourceDir);
    const workspace = await getSessionWorkspace(sessionId, {
      resolveSkillDirs: () => [],
      resolveFolderSources: () => [source],
    });

    const result = await searchDocumentsForSession({
      sessionId,
      sources: [source],
      workspace,
      query: "ROUND4_INDEXED_COUNT_VALID",
      topK: 5,
    });

    expect(result.ok).toBe(true);
    expect(result.indexedCount).toBe(1);
    expect(result.results.map((item) => item.path)).toEqual(["/sources/source_docs/only-valid.md"]);

    await clearFolderSourceCache(sessionId, source.id);
  });

  it("readDocument/searchDocuments 不抽取 XLSX hidden sheet 与 hidden/zeroHeight 行", async () => {
    process.env.QINGAGENT_SANDBOX_ISOLATION = "none";
    const sessionId = "sess-folder-xlsx-hidden";
    const root = mkdtempSync(join(tmpdir(), "folder-xlsx-hidden-"));
    const sourceDir = join(root, "docs");
    mkdirSync(sourceDir, { recursive: true });
    writeFileSync(join(sourceDir, "visibility.xlsx"), await createHiddenXlsxFixture());
    const source = makeSource(sessionId, sourceDir);
    const workspace = await getSessionWorkspace(sessionId, {
      resolveSkillDirs: () => [],
      resolveFolderSources: () => [source],
    });

    const read = await readDocumentForSession({
      sessionId,
      sources: [source],
      workspace,
      path: "/sources/source_docs/visibility.xlsx",
    });
    const hiddenSearch = await searchDocumentsForSession({
      sessionId,
      sources: [source],
      workspace,
      query: "HIDDEN_ROW_SEARCH_TOKEN HIDDEN_SHEET_SEARCH_TOKEN ZERO_HEIGHT_SEARCH_TOKEN",
      topK: 5,
    });
    const visibleSearch = await searchDocumentsForSession({
      sessionId,
      sources: [source],
      workspace,
      query: "VISIBLE_XLSX_SEARCH_TOKEN",
      topK: 5,
    });

    expect(read.ok).toBe(true);
    expect(read.text).toContain("VISIBLE_XLSX_SEARCH_TOKEN");
    expect(read.text).not.toContain("HIDDEN_ROW_SEARCH_TOKEN");
    expect(read.text).not.toContain("ZERO_HEIGHT_SEARCH_TOKEN");
    expect(read.text).not.toContain("HIDDEN_SHEET_SEARCH_TOKEN");
    expect(hiddenSearch.ok).toBe(true);
    expect(hiddenSearch.results).toEqual([]);
    expect(visibleSearch.ok).toBe(true);
    expect(visibleSearch.results[0]?.path).toBe("/sources/source_docs/visibility.xlsx");

    await clearFolderSourceCache(sessionId, source.id);
  });

  it("searchDocuments 可检索中文 CJK 关键词", async () => {
    process.env.QINGAGENT_SANDBOX_ISOLATION = "none";
    const sessionId = "sess-folder-search-cjk";
    const root = mkdtempSync(join(tmpdir(), "folder-search-cjk-"));
    const sourceDir = join(root, "docs");
    mkdirSync(sourceDir, { recursive: true });
    writeFileSync(join(sourceDir, "cn.md"), "机器学习和深度学习是资料库里的中文关键词。");
    writeFileSync(join(sourceDir, "en.md"), "plain english note");
    const source = makeSource(sessionId, sourceDir);
    const workspace = await getSessionWorkspace(sessionId, {
      resolveSkillDirs: () => [],
      resolveFolderSources: () => [source],
    });

    const result = await searchDocumentsForSession({
      sessionId,
      sources: [source],
      workspace,
      query: "机器学习",
      topK: 3,
    });

    expect(result.ok).toBe(true);
    expect(result.results[0]?.path).toBe("/sources/source_docs/cn.md");
    expect(result.results[0]?.text).toContain("机器学习");
    expect(result.results[0]?.text).not.toContain("__qingagent_cjk_search_tokens__");

    const absent = await searchDocumentsForSession({
      sessionId,
      sources: [source],
      workspace,
      query: "鹤归999",
      topK: 3,
    });
    expect(absent.ok).toBe(true);
    expect(absent.results).toEqual([]);

    await clearFolderSourceCache(sessionId, source.id);
  });

  it("searchDocuments 多字 CJK 查询不召回只共享单字的干扰文档", async () => {
    process.env.QINGAGENT_SANDBOX_ISOLATION = "none";
    const sessionId = "sess-folder-search-cjk-false-positive";
    const root = mkdtempSync(join(tmpdir(), "folder-search-cjk-fp-"));
    const sourceDir = join(root, "docs");
    mkdirSync(sourceDir, { recursive: true });
    writeFileSync(join(sourceDir, "exact.md"), "# 项目管理\n项目管理规范与风险管理。\n");
    writeFileSync(join(sourceDir, "machine.md"), "# 机器学习\n机器学习案例库。\n");
    writeFileSync(
      join(sourceDir, "single-char-only.md"),
      "管道巡检、管线维护、物理理论、定理推导。本文不包含连续的目标二字词。\n",
    );
    const source = makeSource(sessionId, sourceDir);
    const workspace = await getSessionWorkspace(sessionId, {
      resolveSkillDirs: () => [],
      resolveFolderSources: () => [source],
    });

    const result = await searchDocumentsForSession({
      sessionId,
      sources: [source],
      workspace,
      query: "管理",
      topK: 5,
    });
    expect(result.ok).toBe(true);
    expect(result.results[0]?.relPath).toBe("exact.md");
    expect(result.results.map((item) => item.relPath)).not.toContain("single-char-only.md");

    rmSync(join(sourceDir, "exact.md"));
    const noExact = await searchDocumentsForSession({
      sessionId,
      sources: [source],
      workspace,
      query: "管理",
      topK: 5,
    });
    expect(noExact.ok).toBe(true);
    expect(noExact.results).toEqual([]);

    const partial = await searchDocumentsForSession({
      sessionId,
      sources: [source],
      workspace,
      query: "器学",
      topK: 5,
    });
    expect(partial.ok).toBe(true);
    expect(partial.results.map((item) => item.relPath)).toContain("machine.md");

    await clearFolderSourceCache(sessionId, source.id);
  });

  it("searchDocuments 挂载根消失时返回清晰失败，不静默成空结果", async () => {
    process.env.QINGAGENT_SANDBOX_ISOLATION = "none";
    const sessionId = "sess-folder-search-missing-root";
    const root = mkdtempSync(join(tmpdir(), "folder-search-missing-root-"));
    const sourceDir = join(root, "docs");
    mkdirSync(sourceDir, { recursive: true });
    writeFileSync(join(sourceDir, "before.md"), "ROUND7_SEARCH_MISSING_ROOT");
    const source = makeSource(sessionId, sourceDir);
    const workspace = await getSessionWorkspace(sessionId, {
      resolveSkillDirs: () => [],
      resolveFolderSources: () => [source],
    });
    rmSync(sourceDir, { recursive: true, force: true });

    const result = await searchDocumentsForSession({
      sessionId,
      sources: [source],
      workspace,
      query: "ROUND7_SEARCH_MISSING_ROOT",
      topK: 5,
    });

    expect(result.ok).toBe(false);
    expect(result.results).toEqual([]);
    expect(result.error).toContain("folder_source_unavailable");
    expect(JSON.stringify(result)).not.toContain(sourceDir);

    await clearFolderSourceCache(sessionId, source.id);
  });

  it("searchDocuments 的 BM25 search 抛错时返回 ok=false 而不是向上抛", async () => {
    process.env.QINGAGENT_SANDBOX_ISOLATION = "none";
    const sessionId = "sess-folder-search-bm25-throw";
    const root = mkdtempSync(join(tmpdir(), "folder-search-bm25-throw-"));
    const sourceDir = join(root, "docs");
    mkdirSync(sourceDir, { recursive: true });
    writeFileSync(join(sourceDir, "needle.md"), "ROUND7_BM25_THROW_NEEDLE");
    const source = makeSource(sessionId, sourceDir);
    const workspace = await getSessionWorkspace(sessionId, {
      resolveSkillDirs: () => [],
      resolveFolderSources: () => [source],
    });
    const originalSearch = Workspace.prototype.search;
    Workspace.prototype.search = (async () => {
      throw new Error("ROUND7_FORCED_BM25_ABORT");
    }) as typeof Workspace.prototype.search;

    let result: Awaited<ReturnType<typeof searchDocumentsForSession>>;
    try {
      result = await searchDocumentsForSession({
        sessionId,
        sources: [source],
        workspace,
        query: "ROUND7_BM25_THROW_NEEDLE",
        topK: 5,
      });
    } finally {
      Workspace.prototype.search = originalSearch;
    }

    expect(result.ok).toBe(false);
    expect(result.error).toContain("ROUND7_FORCED_BM25_ABORT");
    expect(result.results).toEqual([]);

    await clearFolderSourceCache(sessionId, source.id);
  });

  it("readDocument 对同 size 与同 mtime 的内容变化按 hash 重新解析", async () => {
    process.env.QINGAGENT_SANDBOX_ISOLATION = "none";
    const sessionId = "sess-folder-cache-hash";
    const root = mkdtempSync(join(tmpdir(), "folder-cache-hash-"));
    const sourceDir = join(root, "docs");
    mkdirSync(sourceDir, { recursive: true });
    const file = join(sourceDir, "same.md");
    writeFileSync(file, "CACHE_STALE_AAA_000");
    const source = makeSource(sessionId, sourceDir);
    await clearFolderSourceCache(sessionId, source.id);
    const workspace = await getSessionWorkspace(sessionId, {
      resolveSkillDirs: () => [],
      resolveFolderSources: () => [source],
    });

    const first = await readDocumentForSession({
      sessionId,
      sources: [source],
      workspace,
      path: "/sources/source_docs/same.md",
    });
    expect(first.ok).toBe(true);
    expect(first.text).toContain("CACHE_STALE_AAA_000");

    const st = statSync(file);
    writeFileSync(file, "CACHE_FRESH_BBB_111");
    utimesSync(file, st.atime, st.mtime);
    const second = await readDocumentForSession({
      sessionId,
      sources: [source],
      workspace,
      path: "/sources/source_docs/same.md",
    });

    expect(second.ok).toBe(true);
    expect(second.cacheHit).toBe(false);
    expect(second.text).toContain("CACHE_FRESH_BBB_111");
    expect(second.text).not.toContain("CACHE_STALE_AAA_000");

    await clearFolderSourceCache(sessionId, source.id);
  });

  it("searchDocuments 对同 size 与同 mtime 的内容变化用 sha freshness 失效旧缓存", async () => {
    process.env.QINGAGENT_SANDBOX_ISOLATION = "none";
    const sessionId = "sess-folder-search-cache-hash";
    const root = mkdtempSync(join(tmpdir(), "folder-search-cache-hash-"));
    const sourceDir = join(root, "docs");
    mkdirSync(sourceDir, { recursive: true });
    const file = join(sourceDir, "same.md");
    const oldText = "ROUND12_ALPHA_TOKEN";
    const newText = "ROUND12_BETA__TOKEN";
    expect(Buffer.byteLength(newText, "utf8")).toBe(Buffer.byteLength(oldText, "utf8"));
    writeFileSync(file, oldText);
    const source = makeSource(sessionId, sourceDir);
    await clearFolderSourceCache(sessionId, source.id);
    const workspace = await getSessionWorkspace(sessionId, {
      resolveSkillDirs: () => [],
      resolveFolderSources: () => [source],
    });

    const initial = await searchDocumentsForSession({
      sessionId,
      sources: [source],
      workspace,
      query: "ROUND12_ALPHA_TOKEN",
      topK: 3,
    });
    expect(initial.ok).toBe(true);
    expect(initial.results.map((item) => item.relPath)).toContain("same.md");

    const st = statSync(file);
    writeFileSync(file, newText);
    utimesSync(file, st.atime, st.mtime);
    const oldQuery = await searchDocumentsForSession({
      sessionId,
      sources: [source],
      workspace,
      query: "ROUND12_ALPHA_TOKEN",
      topK: 3,
    });
    expect(oldQuery.ok).toBe(true);
    expect(oldQuery.results.map((item) => item.relPath)).not.toContain("same.md");

    const newQuery = await searchDocumentsForSession({
      sessionId,
      sources: [source],
      workspace,
      query: "ROUND12_BETA__TOKEN",
      topK: 3,
    });
    expect(newQuery.ok).toBe(true);
    expect(newQuery.results.map((item) => item.relPath)).toContain("same.md");
    expect(newQuery.results[0]?.text).toContain("ROUND12_BETA__TOKEN");

    await clearFolderSourceCache(sessionId, source.id);
  });

  it("searchDocuments 在 cached text 损坏且 dirty 重读失败时返回可区分失败", async () => {
    process.env.QINGAGENT_SANDBOX_ISOLATION = "none";
    const sessionId = "sess-folder-search-damaged-cache";
    const root = mkdtempSync(join(tmpdir(), "folder-search-damaged-cache-"));
    const sourceDir = join(root, "docs");
    mkdirSync(sourceDir, { recursive: true });
    writeFileSync(join(sourceDir, "damaged.md"), "ROUND12_DAMAGED_CACHE_TOKEN");
    const source = makeSource(sessionId, sourceDir);
    await clearFolderSourceCache(sessionId, source.id);
    const workspace = await getSessionWorkspace(sessionId, {
      resolveSkillDirs: () => [],
      resolveFolderSources: () => [source],
    });

    const warmup = await searchDocumentsForSession({
      sessionId,
      sources: [source],
      workspace,
      query: "ROUND12_DAMAGED_CACHE_TOKEN",
      topK: 3,
    });
    expect(warmup.ok).toBe(true);
    const [entry] = await loadFolderSourceManifestEntries(sessionId, source.id);
    expect(entry).toBeDefined();
    if (!entry) throw new Error("expected manifest entry");
    rmSync(join(
      QINGAGENT_DATA_DIR,
      "folder-source-cache",
      sessionWorkspaceDirName(sessionId),
      source.id,
      "parsed",
      entry.parsedFile,
    ), { force: true });

    const filesystem = workspace.filesystem!;
    const originalResolveAbsolutePath = filesystem.resolveAbsolutePath?.bind(filesystem);
    if (!originalResolveAbsolutePath) throw new Error("expected local resolveAbsolutePath");
    filesystem.resolveAbsolutePath = (path) => {
      if (path === "/sources/source_docs/damaged.md") {
        throw new Error("simulated source read failure");
      }
      return originalResolveAbsolutePath(path);
    };
    try {
      const result = await searchDocumentsForSession({
        sessionId,
        sources: [source],
        workspace,
        query: "ROUND12_DAMAGED_CACHE_TOKEN",
        topK: 3,
      });

      expect(result.ok).toBe(false);
      expect(result.error).toContain("cache is damaged");
      expect(result.scannedCount).toBe(1);
      expect(JSON.stringify(result)).not.toContain(sourceDir);
    } finally {
      filesystem.resolveAbsolutePath = originalResolveAbsolutePath;
      await clearFolderSourceCache(sessionId, source.id);
    }
  });

  it("readDocument 在 stat/read 竞态后用读后 stat 写缓存", async () => {
    process.env.QINGAGENT_SANDBOX_ISOLATION = "none";
    const sessionId = "sess-folder-stat-read-race";
    const root = mkdtempSync(join(tmpdir(), "folder-stat-read-race-"));
    const sourceDir = join(root, "docs");
    mkdirSync(sourceDir, { recursive: true });
    const file = join(sourceDir, "race.md");
    writeFileSync(file, "RACE_OLD_TOKEN 版本一。\n");
    const source = makeSource(sessionId, sourceDir);
    await clearFolderSourceCache(sessionId, source.id);
    const workspace = await getSessionWorkspace(sessionId, {
      resolveSkillDirs: () => [],
      resolveFolderSources: () => [source],
    });

    const first = await readDocumentForSession({
      sessionId,
      sources: [source],
      workspace,
      path: "/sources/source_docs/race.md",
    });
    expect(first).toMatchObject({ ok: true, cacheHit: false });
    expect(first.text).toContain("RACE_OLD_TOKEN");

    const filesystem = workspace.filesystem!;
    const originalStat = filesystem.stat.bind(filesystem);
    const oldStat = statSync(file);
    let wroteDuringRead = false;
    filesystem.stat = async (path) => {
      const before = await originalStat(path);
      if (path === "/sources/source_docs/race.md" && !wroteDuringRead) {
        writeFileSync(file, "RACE_NEW_TOKEN 版本二，保存发生在 stat 后 readFile 前。\n");
        utimesSync(file, oldStat.atime, new Date(oldStat.mtimeMs + 2_000));
        wroteDuringRead = true;
      }
      return before;
    };

    let raceSearch: Awaited<ReturnType<typeof searchDocumentsForSession>>;
    try {
      raceSearch = await searchDocumentsForSession({
        sessionId,
        sources: [source],
        workspace,
        query: "RACE_NEW_TOKEN",
        topK: 3,
      });
    } finally {
      filesystem.stat = originalStat;
    }

    expect(raceSearch.ok).toBe(true);
    expect(raceSearch.results.map((item) => item.path)).toContain("/sources/source_docs/race.md");
    const [entry] = await loadFolderSourceManifestEntries(sessionId, source.id);
    const currentStat = statSync(file);
    expect(entry).toBeDefined();
    expect(entry?.relPath).toBe("race.md");
    expect(entry?.size).toBe(currentStat.size);
    expect(entry?.modifiedAtMs).toBe(currentStat.mtime.getTime());

    await clearFolderSourceCache(sessionId, source.id);
  });

  it("cleanupOldFolderSourceCaches 使用 manifest lastAccessAt 保留刚命中的缓存", async () => {
    process.env.QINGAGENT_SANDBOX_ISOLATION = "none";
    const sessionId = "sess-folder-cleanup-last-access";
    const root = mkdtempSync(join(tmpdir(), "folder-cleanup-"));
    const sourceDir = join(root, "docs");
    mkdirSync(sourceDir, { recursive: true });
    writeFileSync(join(sourceDir, "active.md"), "CLEANUP_ACTIVE_TOKEN");
    const source = makeSource(sessionId, sourceDir);
    const workspace = await getSessionWorkspace(sessionId, {
      resolveSkillDirs: () => [],
      resolveFolderSources: () => [source],
    });

    const first = await readDocumentForSession({
      sessionId,
      sources: [source],
      workspace,
      path: "/sources/source_docs/active.md",
    });
    expect(first.ok).toBe(true);

    const sessionCacheRoot = join(
      QINGAGENT_DATA_DIR,
      "folder-source-cache",
      sessionWorkspaceDirName(sessionId),
    );
    const old = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000);
    utimesSync(sessionCacheRoot, old, old);
    const hit = await readDocumentForSession({
      sessionId,
      sources: [source],
      workspace,
      path: "/sources/source_docs/active.md",
    });
    expect(hit).toMatchObject({ ok: true, cacheHit: true });

    await cleanupOldFolderSourceCaches(Date.now());
    expect(existsSync(sessionCacheRoot)).toBe(true);

    await clearFolderSourceCache(sessionId, source.id);
  });

  it("enforceFolderSourceCacheLimits 使用 manifest lastAccessAt 淘汰且不留下悬挂 entry", async () => {
    process.env.QINGAGENT_SANDBOX_ISOLATION = "none";
    const sessionId = "sess-folder-cache-lru-manifest";
    const root = mkdtempSync(join(tmpdir(), "folder-cache-lru-"));
    const sourceDir = join(root, "docs");
    mkdirSync(sourceDir, { recursive: true });
    writeFileSync(join(sourceDir, "inactive.txt"), `INACTIVE_TOKEN\n${"b".repeat(180 * 1024)}`, "utf8");
    writeFileSync(join(sourceDir, "active.txt"), `ACTIVE_TOKEN\n${"a".repeat(180 * 1024)}`, "utf8");
    const source = makeSource(sessionId, sourceDir);
    const workspace = await getSessionWorkspace(sessionId, {
      resolveSkillDirs: () => [],
      resolveFolderSources: () => [source],
    });

    const inactiveRead = await readDocumentForSession({
      sessionId,
      sources: [source],
      workspace,
      path: "/sources/source_docs/inactive.txt",
      maxChars: 64,
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const activeRead = await readDocumentForSession({
      sessionId,
      sources: [source],
      workspace,
      path: "/sources/source_docs/active.txt",
      maxChars: 64,
    });
    const activeHit = await readDocumentForSession({
      sessionId,
      sources: [source],
      workspace,
      path: "/sources/source_docs/active.txt",
      maxChars: 64,
    });

    expect(inactiveRead.ok).toBe(true);
    expect(activeRead.ok).toBe(true);
    expect(activeHit).toMatchObject({ ok: true, cacheHit: true });

    const cacheDir = join(
      QINGAGENT_DATA_DIR,
      "folder-source-cache",
      sessionWorkspaceDirName(sessionId),
      source.id,
    );
    const manifestPath = join(cacheDir, "manifest.json");
    const manifestBefore = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      entries: Record<string, { parsedFile: string; lastAccessAt: string }>;
    };
    const activeParsed = join(cacheDir, "parsed", manifestBefore.entries["active.txt"]!.parsedFile);
    const inactiveParsed = join(cacheDir, "parsed", manifestBefore.entries["inactive.txt"]!.parsedFile);
    const veryOld = new Date(Date.now() - 45 * 24 * 60 * 60 * 1000);
    const veryNew = new Date();
    utimesSync(activeParsed, veryOld, veryOld);
    utimesSync(inactiveParsed, veryNew, veryNew);

    const manifestBytes = statSync(manifestPath).size;
    const inactiveBytes = statSync(inactiveParsed).size;
    const savedLimit = process.env.QINGAGENT_FOLDER_CACHE_SESSION_MAX_BYTES;
    process.env.QINGAGENT_FOLDER_CACHE_SESSION_MAX_BYTES = String(manifestBytes + inactiveBytes + 1024);
    try {
      await enforceFolderSourceCacheLimits(sessionId);
    } finally {
      if (savedLimit === undefined) delete process.env.QINGAGENT_FOLDER_CACHE_SESSION_MAX_BYTES;
      else process.env.QINGAGENT_FOLDER_CACHE_SESSION_MAX_BYTES = savedLimit;
    }

    const manifestAfter = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      entries: Record<string, { parsedFile: string }>;
    };
    const dangling = Object.entries(manifestAfter.entries)
      .filter(([, entry]) => !existsSync(join(cacheDir, "parsed", entry.parsedFile)))
      .map(([relPath]) => relPath);

    expect(existsSync(activeParsed)).toBe(true);
    expect(existsSync(inactiveParsed)).toBe(false);
    expect(manifestAfter.entries["active.txt"]).toBeDefined();
    expect(manifestAfter.entries["inactive.txt"]).toBeUndefined();
    expect(dangling).toEqual([]);

    await clearFolderSourceCache(sessionId, source.id);
  });

  it("并发写入 parsed manifest 不丢 entry", async () => {
    const sessionId = "sess-folder-manifest-race";
    const folderId = "fld_manifest_race";
    await clearFolderSourceCache(sessionId, folderId);
    await Promise.all(
      Array.from({ length: 40 }, async (_, index) => {
        const relPath = `doc-${index}.md`;
        await putParsedDocument({
          sessionId,
          folderId,
          relPath,
          path: `/sources/source_docs/${relPath}`,
          size: index + 1,
          modifiedAtMs: 1_800_000_000_000 + index,
          contentSha256: `sha-${index}`,
          text: `正文 ${index}`,
          metadata: { pages: null, wordCount: 2, title: null },
        });
      }),
    );

    const entries = await loadFolderSourceManifestEntries(sessionId, folderId);
    expect(entries).toHaveLength(40);
    expect(new Set(entries.map((entry) => entry.relPath)).size).toBe(40);

    await clearFolderSourceCache(sessionId, folderId);
  });

  it("磁盘 manifest 损坏后 readDocument 不被进程内 clean cache 掩盖", async () => {
    process.env.QINGAGENT_SANDBOX_ISOLATION = "none";
    const sessionId = "sess-folder-manifest-corrupt-disk";
    const root = mkdtempSync(join(tmpdir(), "folder-manifest-corrupt-disk-"));
    const sourceDir = join(root, "docs");
    mkdirSync(sourceDir, { recursive: true });
    writeFileSync(join(sourceDir, "note.md"), "ROUND13_CORRUPT_MANIFEST_BODY should be rebuilt");
    const source = makeSource(sessionId, sourceDir);
    const workspace = await getSessionWorkspace(sessionId, {
      resolveSkillDirs: () => [],
      resolveFolderSources: () => [source],
    });

    const first = await readDocumentForSession({
      sessionId,
      sources: [source],
      workspace,
      path: "/sources/source_docs/note.md",
    });
    expect(first.ok).toBe(true);

    const manifest = join(
      QINGAGENT_DATA_DIR,
      "folder-source-cache",
      sessionWorkspaceDirName(sessionId),
      source.id,
      "manifest.json",
    );
    writeFileSync(manifest, "{\"entries\":", "utf8");

    const second = await readDocumentForSession({
      sessionId,
      sources: [source],
      workspace,
      path: "/sources/source_docs/note.md",
    });
    expect(second.ok).toBe(true);
    expect(second.cacheHit).toBe(false);
    expect(second.text).toContain("ROUND13_CORRUPT_MANIFEST_BODY");

    const repairedManifest = JSON.parse(readFileSync(manifest, "utf8")) as {
      entries?: Record<string, unknown>;
    };
    expect(Object.keys(repairedManifest.entries ?? {})).toEqual(["note.md"]);

    await clearFolderSourceCache(sessionId, source.id);
  });

  it("Round9 回归:负数 folder cache limit 降级默认值，不删光缓存", async () => {
    const sessionId = "sess-folder-cache-negative-limit";
    const folderId = "fld_cache_negative_limit";
    const savedSessionLimit = process.env.QINGAGENT_FOLDER_CACHE_SESSION_MAX_BYTES;
    const savedTotalLimit = process.env.QINGAGENT_FOLDER_CACHE_MAX_BYTES;
    process.env.QINGAGENT_FOLDER_CACHE_SESSION_MAX_BYTES = "-1";
    process.env.QINGAGENT_FOLDER_CACHE_MAX_BYTES = "268435456";
    try {
      await clearFolderSourceCache(sessionId, folderId);
      await putParsedDocument({
        sessionId,
        folderId,
        relPath: "note.md",
        path: "/sources/source_docs/note.md",
        size: 12,
        modifiedAtMs: 1_800_000_000_000,
        contentSha256: "sha-negative-limit",
        text: "ROUND9_CACHE_NEGATIVE_LIMIT_BODY",
        metadata: { pages: null, wordCount: 32, title: null },
      });
      await enforceFolderSourceCacheLimits(sessionId);

      const entries = await loadFolderSourceManifestEntries(sessionId, folderId);
      expect(entries.map((entry) => entry.relPath)).toEqual(["note.md"]);
    } finally {
      if (savedSessionLimit === undefined) delete process.env.QINGAGENT_FOLDER_CACHE_SESSION_MAX_BYTES;
      else process.env.QINGAGENT_FOLDER_CACHE_SESSION_MAX_BYTES = savedSessionLimit;
      if (savedTotalLimit === undefined) delete process.env.QINGAGENT_FOLDER_CACHE_MAX_BYTES;
      else process.env.QINGAGENT_FOLDER_CACHE_MAX_BYTES = savedTotalLimit;
      await clearFolderSourceCache(sessionId, folderId);
    }
  });

  it("detach tombstone 后 in-flight readDocument 不重建 folder cache", async () => {
    process.env.QINGAGENT_SANDBOX_ISOLATION = "none";
    const sessionId = "sess-folder-detach-cache-race";
    const root = mkdtempSync(join(tmpdir(), "folder-detach-cache-race-"));
    const sourceDir = join(root, "docs");
    mkdirSync(sourceDir, { recursive: true });
    writeFileSync(join(sourceDir, "slow.md"), "R8_DETACH_RACE_BODY\n");
    const source = makeSource(sessionId, sourceDir);
    registerSessionFolderSources(sessionId, [source]);
    const workspace = await getSessionWorkspace(sessionId, {
      resolveSkillDirs: () => [],
      resolveFolderSources: () => [source],
    });

    let releaseRead!: () => void;
    const readStarted = new Promise<void>((resolve) => {
      const filesystem = workspace.filesystem!;
      const originalStat = filesystem.stat.bind(filesystem);
      filesystem.stat = async (path) => {
        const current = await originalStat(path);
        if (path === "/sources/source_docs/slow.md") {
          resolve();
          await new Promise<void>((release) => {
            releaseRead = release;
          });
        }
        try {
          return current;
        } finally {
          filesystem.stat = originalStat;
        }
      };
    });
    const readPromise = readDocumentForSession({
      sessionId,
      sources: [source],
      workspace,
      path: "/sources/source_docs/slow.md",
    });

    await readStarted;
    markFolderSourceDetached(sessionId, source.id);
    registerSessionFolderSources(sessionId, []);
    await clearFolderSourceCache(sessionId, source.id);
    releaseRead();
    const result = await readPromise;

    expect(result.ok).toBe(true);
    expect(result.text).toContain("R8_DETACH_RACE_BODY");
    expect(await loadFolderSourceManifestEntries(sessionId, source.id)).toEqual([]);
    expect(existsSync(join(
      QINGAGENT_DATA_DIR,
      "folder-source-cache",
      sessionWorkspaceDirName(sessionId),
      source.id,
    ))).toBe(false);

    await clearFolderSourceCache(sessionId, source.id);
  });

  it("detach tombstone 后 stale manifest 不写入临时搜索索引", async () => {
    process.env.QINGAGENT_SANDBOX_ISOLATION = "none";
    const sessionId = "sess-folder-detach-index-race";
    const root = mkdtempSync(join(tmpdir(), "folder-detach-index-race-"));
    const sourceDir = join(root, "docs");
    mkdirSync(sourceDir, { recursive: true });
    writeFileSync(join(sourceDir, "stale.md"), "R8_INDEX_TOMBSTONE_BODY\n");
    const source = makeSource(sessionId, sourceDir);
    registerSessionFolderSources(sessionId, [source]);
    const workspace = await getSessionWorkspace(sessionId, {
      resolveSkillDirs: () => [],
      resolveFolderSources: () => [source],
    });

    const cached = await readDocumentForSession({
      sessionId,
      sources: [source],
      workspace,
      path: "/sources/source_docs/stale.md",
    });
    expect(cached.ok).toBe(true);

    const filesystem = workspace.filesystem!;
    const originalStat = filesystem.stat.bind(filesystem);
    let detachedDuringIndexBuild = false;
    filesystem.stat = async (path) => {
      const stat = await originalStat(path);
      if (path === "/sources/source_docs/stale.md" && !detachedDuringIndexBuild) {
        detachedDuringIndexBuild = true;
        markFolderSourceDetached(sessionId, source.id);
        registerSessionFolderSources(sessionId, []);
      }
      return stat;
    };
    try {
      const result = await searchDocumentsForSession({
        sessionId,
        sources: [source],
        workspace,
        query: "R8_INDEX_TOMBSTONE_BODY",
        topK: 3,
      });

      expect(result.ok).toBe(true);
      expect(detachedDuringIndexBuild).toBe(true);
      expect(result.results).toEqual([]);
    } finally {
      filesystem.stat = originalStat;
      await clearFolderSourceCache(sessionId, source.id);
    }
  });

  it("readDocument 在 parsed 缓存半残且内容 hash 相同时降级重建", async () => {
    process.env.QINGAGENT_SANDBOX_ISOLATION = "none";
    const sessionId = "sess-folder-cache-missing";
    const root = mkdtempSync(join(tmpdir(), "folder-cache-missing-"));
    const sourceDir = join(root, "docs");
    mkdirSync(sourceDir, { recursive: true });
    const file = join(sourceDir, "a.md");
    writeFileSync(file, "Alpha 正文");
    const source = makeSource(sessionId, sourceDir);
    const workspace = await getSessionWorkspace(sessionId, {
      resolveSkillDirs: () => [],
      resolveFolderSources: () => [source],
    });

    const first = await readDocumentForSession({
      sessionId,
      sources: [source],
      workspace,
      path: "/sources/source_docs/a.md",
    });
    expect(first.ok).toBe(true);
    const [entry] = await loadFolderSourceManifestEntries(sessionId, source.id);
    expect(entry).toBeDefined();
    if (!entry) throw new Error("expected parsed cache manifest entry");
    rmSync(join(
      QINGAGENT_DATA_DIR,
      "folder-source-cache",
      sessionWorkspaceDirName(sessionId),
      source.id,
      "parsed",
      entry.parsedFile,
    ));
    const st = statSync(file);
    const nextTime = new Date(st.mtimeMs + 2_000);
    utimesSync(file, st.atime, nextTime);

    const second = await readDocumentForSession({
      sessionId,
      sources: [source],
      workspace,
      path: "/sources/source_docs/a.md",
    });

    expect(second.ok).toBe(true);
    expect(second.cacheHit).toBe(false);
    expect(second.text).toContain("Alpha 正文");

    await clearFolderSourceCache(sessionId, source.id);
  });

  it("readDocument 拒绝外部 symlink 时不泄露桌面真实路径", async () => {
    process.env.QINGAGENT_SANDBOX_ISOLATION = "none";
    const sessionId = "sess-folder-symlink-redact";
    const root = mkdtempSync(join(tmpdir(), "folder-symlink-redact-"));
    const sourceDir = join(root, "docs");
    const outsideDir = join(root, "outside");
    mkdirSync(sourceDir, { recursive: true });
    mkdirSync(outsideDir, { recursive: true });
    writeFileSync(join(outsideDir, "secret.md"), "secret");
    symlinkSync(join(outsideDir, "secret.md"), join(sourceDir, "link-out.md"));
    const source = makeSource(sessionId, sourceDir);
    const workspace = await getSessionWorkspace(sessionId, {
      resolveSkillDirs: () => [],
      resolveFolderSources: () => [source],
    });

    const result = await readDocumentForSession({
      sessionId,
      sources: [source],
      workspace,
      path: "/sources/source_docs/link-out.md",
    });

    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
    expect(result.error).not.toContain(sourceDir);
    expect(result.error).not.toContain(outsideDir);
    expect(result.error).toContain(source.mountPath);

    await clearFolderSourceCache(sessionId, source.id);
  });

  it("readdir 过滤链式外部 symlink 且重复 mountName 稳定保留首个 source", async () => {
    process.env.QINGAGENT_SANDBOX_ISOLATION = "none";
    const sessionId = "sess-folder-symlink-chain";
    const root = mkdtempSync(join(tmpdir(), "folder-symlink-chain-"));
    const sourceDir = join(root, "docs");
    const outsideDir = join(root, "outside");
    mkdirSync(sourceDir, { recursive: true });
    mkdirSync(outsideDir, { recursive: true });
    writeFileSync(join(sourceDir, "inside.md"), "inside");
    writeFileSync(join(outsideDir, "secret.md"), "outside");
    symlinkSync(join(sourceDir, "inside.md"), join(sourceDir, "link-inside.md"));
    symlinkSync(join(outsideDir, "secret.md"), join(sourceDir, "direct-out.md"));
    symlinkSync(join(outsideDir, "secret.md"), join(sourceDir, "chain-mid.md"));
    symlinkSync("chain-mid.md", join(sourceDir, "chain-top.md"));
    const source = makeSource(sessionId, sourceDir);
    const workspace = await getSessionWorkspace(sessionId, {
      resolveSkillDirs: () => [],
      resolveFolderSources: () => [source],
    });
    const names = (await workspace.filesystem!.readdir("/sources/source_docs")).map((entry) => entry.name);
    expect(names).toContain("link-inside.md");
    expect(names).not.toContain("direct-out.md");
    expect(names).not.toContain("chain-top.md");

    const dupRootA = join(root, "dup-a");
    const dupRootB = join(root, "dup-b");
    mkdirSync(dupRootA, { recursive: true });
    mkdirSync(dupRootB, { recursive: true });
    writeFileSync(join(dupRootA, "shared.md"), "DUPLICATE_ROOT_A_TOKEN");
    writeFileSync(join(dupRootB, "shared.md"), "DUPLICATE_ROOT_B_TOKEN");
    const dupSessionId = "sess-folder-duplicate-mount";
    const dupA = {
      ...makeSource(dupSessionId, dupRootA),
      id: "fld_dup_a",
      name: "dup-a",
      mountName: "source_dup",
      mountPath: "/sources/source_dup",
      desktopRootPath: dupRootA,
    };
    const dupB = {
      ...makeSource(dupSessionId, dupRootB),
      id: "fld_dup_b",
      name: "dup-b",
      mountName: "source_dup",
      mountPath: "/sources/source_dup",
      desktopRootPath: dupRootB,
    };
    const dupWorkspace = await getSessionWorkspace(dupSessionId, {
      resolveSkillDirs: () => [],
      resolveFolderSources: () => [dupA, dupB],
    });
    const dupRead = await readDocumentForSession({
      sessionId: dupSessionId,
      sources: [dupA, dupB],
      workspace: dupWorkspace,
      path: "/sources/source_dup/shared.md",
    });
    expect(dupRead.ok).toBe(true);
    expect(dupRead.text).toContain("DUPLICATE_ROOT_A_TOKEN");
    expect(dupRead.text).not.toContain("DUPLICATE_ROOT_B_TOKEN");

    await clearFolderSourceCache(sessionId, source.id);
    await clearFolderSourceCache(dupSessionId, dupA.id);
  });
});
