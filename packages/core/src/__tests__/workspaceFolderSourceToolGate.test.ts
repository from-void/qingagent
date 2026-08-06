import { RequestContext } from "@mastra/core/request-context";
import { WORKSPACE_TOOLS } from "@mastra/core/workspace";
import type { FolderSourceRecord } from "@qingagent/contract-ts";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { qingagentAgent, getQingagentSessionWorkspace } from "../agents/qingagent.js";
import {
  createFolderSourceListFilesTool,
  createProtectedFolderSourceEditFileTool,
  createProtectedFolderSourceGrepTool,
  createProtectedFolderSourceReadFileTool,
  createProtectedFolderSourceSearchTool,
} from "../workspace/protectedFolderSourceTools.js";
import {
  __resetFolderSourceRuntimeForTest,
  getSessionFolderSources,
  registerSessionFolderSources,
} from "../folderSources/runtime.js";
import {
  __resetIsolationCacheForTest,
  __resetSessionWorkspaceCacheForTest,
  invalidateSessionWorkspace,
} from "../workspace/sessionWorkspace.js";
import {
  createReadDocumentTool,
  createSearchDocumentsTool,
  searchDocumentsForSession,
} from "../tools/folderDocuments.js";
import { clearFolderSourceCache } from "../folderSources/cache.js";

const toolInvocationOptions = { toolCallId: "tool-call", messages: [] } as never;

function makeSource(sessionId: string, root: string): FolderSourceRecord {
  const now = "2026-06-18T00:00:00.000Z";
  return {
    id: "fld_gate",
    sessionId,
    provider: "desktop-local",
    name: "Gate Docs",
    pathLabel: "Gate Docs",
    mountName: "source_gate",
    mountPath: "/sources/source_gate",
    readOnly: true,
    fileCount: 2,
    fileCountCapped: false,
    status: "connected",
    error: null,
    createdAt: now,
    updatedAt: now,
    desktopRootPath: root,
  };
}

describe("folder source generic workspace tool gate", () => {
  const sessionId = "sess-workspace-folder-tool-gate";
  let root = "";
  let outsideRoot = "";

  beforeEach(() => {
    process.env.QINGAGENT_FORCE_SESSION_SANDBOX = "1";
    process.env.QINGAGENT_SANDBOX_ISOLATION = "none";
    process.env.QINGAGENT_ALLOW_UNISOLATED_COMMANDS = "1";
    process.env.QINGAGENT_RUNTIME = "desktop";
    process.env.QINGAGENT_ENABLE_LOCAL_FOLDER_SOURCES = "1";
    __resetIsolationCacheForTest();
    __resetSessionWorkspaceCacheForTest();
    __resetFolderSourceRuntimeForTest();
    root = mkdtempSync(join(tmpdir(), "folder-tool-gate-"));
    outsideRoot = "";
  });

  afterEach(async () => {
    await clearFolderSourceCache(sessionId, "fld_gate");
    invalidateSessionWorkspace(sessionId);
    __resetSessionWorkspaceCacheForTest();
    __resetFolderSourceRuntimeForTest();
    rmSync(root, { recursive: true, force: true });
    if (outsideRoot) rmSync(outsideRoot, { recursive: true, force: true });
    delete process.env.QINGAGENT_FORCE_SESSION_SANDBOX;
    delete process.env.QINGAGENT_SANDBOX_ISOLATION;
    delete process.env.QINGAGENT_ALLOW_UNISOLATED_COMMANDS;
    delete process.env.QINGAGENT_RUNTIME;
    delete process.env.QINGAGENT_ENABLE_LOCAL_FOLDER_SOURCES;
  });

  it("HTML 不进入资料库文档索引", async () => {
    writeFileSync(join(root, "可索引.md"), "ROUND_HTML_FILTER_VALID\n", "utf8");
    writeFileSync(
      join(root, "网页.html"),
      "<html><body>ROUND_HTML_FILTER_HIDDEN</body></html>\n",
      "utf8",
    );
    const source = makeSource(sessionId, root);
    registerSessionFolderSources(sessionId, [source]);
    invalidateSessionWorkspace(sessionId);
    const workspace = await getQingagentSessionWorkspace(sessionId);

    const result = await searchDocumentsForSession({
      sessionId,
      sources: [source],
      workspace,
      query: "ROUND_HTML_FILTER_HIDDEN",
      topK: 3,
    });

    expect(result).toMatchObject({
      ok: true,
      scannedCount: 1,
      indexedCount: 1,
      results: [],
    });
    expect(JSON.stringify(result)).not.toContain("网页.html");
    expect(JSON.stringify(result.results)).not.toContain("ROUND_HTML_FILTER_HIDDEN");
  });

  it("通用 read_file/grep 拒绝 /sources，但 list_files、专用工具和 /workspace 仍可用", async () => {
    mkdirSync(join(root, "nested"), { recursive: true });
    writeFileSync(join(root, "secret.md"), "ROUND16_GENERIC_READ_SECRET\n", "utf8");
    writeFileSync(join(root, "nested", "hit.txt"), "ROUND16_GENERIC_GREP_SECRET\n", "utf8");
    const source = makeSource(sessionId, root);
    registerSessionFolderSources(sessionId, [source]);
    invalidateSessionWorkspace(sessionId);

    const getWorkspace = () => getQingagentSessionWorkspace(sessionId);
    const getSources = () => getSessionFolderSources(sessionId);
    const workspace = await getWorkspace();
    await workspace.filesystem!.writeFile("/workspace/work.txt", "WORKSPACE_TOKEN\n", { recursive: true });
    await workspace.filesystem!.writeFile(
      "/workspace/project/sources/lib/hit.txt",
      "ORDINARY_SOURCES_TOKEN\n",
      { recursive: true },
    );
    await workspace.index("/workspace/work.txt", "WORKSPACE_TOKEN\n", { metadata: { path: "/workspace/work.txt" } });
    await workspace.index(`${source.mountPath}/nested/hit.txt`, "ROUND16_GENERIC_GREP_SECRET stale index", {
      metadata: { path: `${source.mountPath}/nested/hit.txt` },
    });

    const readDocument = createReadDocumentTool({ sessionId, getWorkspace, getSources });
    const searchDocuments = createSearchDocumentsTool({ sessionId, getWorkspace, getSources });
    const workspaceReadFile = createProtectedFolderSourceReadFileTool({ getWorkspace });
    const workspaceListFiles = createFolderSourceListFilesTool({ getWorkspace });
    const workspaceEditFile = createProtectedFolderSourceEditFileTool({ getWorkspace });
    const workspaceGrep = createProtectedFolderSourceGrepTool({ getWorkspace });
    const workspaceSearchTool = createProtectedFolderSourceSearchTool({ getWorkspace });

    expect(workspaceEditFile.toModelOutput).toBeUndefined();
    expect(workspaceSearchTool.toModelOutput).toBeUndefined();
    await expect(workspaceReadFile.toModelOutput?.({
      __workspaceMedia: true,
      text: "preview.png (3 bytes, image/png)",
      mediaType: "image/png",
      data: "YWJj",
    } as never)).resolves.toEqual({
      type: "content",
      value: [
        { type: "text", text: "preview.png (3 bytes, image/png)" },
        { type: "media", data: "YWJj", mediaType: "image/png" },
      ],
    });

    const tools = await qingagentAgent.getToolsForExecution({
      requestContext: new RequestContext([["sessionId", sessionId]]),
      toolsets: {
        sessionScoped: {
          readDocument,
          searchDocuments,
          [WORKSPACE_TOOLS.FILESYSTEM.READ_FILE]: workspaceReadFile,
          [WORKSPACE_TOOLS.FILESYSTEM.LIST_FILES]: workspaceListFiles,
          [WORKSPACE_TOOLS.FILESYSTEM.EDIT_FILE]: workspaceEditFile,
          [WORKSPACE_TOOLS.FILESYSTEM.GREP]: workspaceGrep,
          [WORKSPACE_TOOLS.SEARCH.SEARCH]: workspaceSearchTool,
        },
      },
    });

    const listOutput = await tools[WORKSPACE_TOOLS.FILESYSTEM.LIST_FILES]?.execute?.(
      { path: source.mountPath, maxDepth: 4, respectGitignore: false },
      { workspace } as never,
    );
    const dedicatedRead = await tools.readDocument?.execute?.(
      { path: `${source.mountPath}/secret.md`, maxChars: 1000 },
      { workspace } as never,
    );
    const dedicatedSearch = await tools.searchDocuments?.execute?.(
      { query: "ROUND16_GENERIC_GREP_SECRET", topK: 3 },
      { workspace } as never,
    );
    const deniedRead = await tools[WORKSPACE_TOOLS.FILESYSTEM.READ_FILE]?.execute?.(
      { path: `${source.mountPath}/secret.md` },
      { workspace } as never,
    );
    const deniedEditHit = await tools[WORKSPACE_TOOLS.FILESYSTEM.EDIT_FILE]?.execute?.(
      {
        path: `${source.mountPath}/secret.md`,
        old_string: "ROUND16_GENERIC_READ_SECRET",
        new_string: "changed",
      },
      { workspace } as never,
    );
    const deniedEditMiss = await tools[WORKSPACE_TOOLS.FILESYSTEM.EDIT_FILE]?.execute?.(
      {
        path: `${source.mountPath}/secret.md`,
        old_string: "ROUND18_ABSENT_EDIT_ORACLE",
        new_string: "changed",
      },
      { workspace } as never,
    );
    const deniedGrep = await tools[WORKSPACE_TOOLS.FILESYSTEM.GREP]?.execute?.(
      { pattern: "ROUND16_GENERIC_GREP_SECRET", path: source.mountPath },
      { workspace } as never,
    );
    const deniedRootGrep = await tools[WORKSPACE_TOOLS.FILESYSTEM.GREP]?.execute?.(
      { pattern: "ROUND16_GENERIC_GREP_SECRET" },
      { workspace } as never,
    );
    const workspaceRead = await tools[WORKSPACE_TOOLS.FILESYSTEM.READ_FILE]?.execute?.(
      { path: "/workspace/work.txt", showLineNumbers: false },
      { workspace } as never,
    );
    const workspaceEdit = await tools[WORKSPACE_TOOLS.FILESYSTEM.EDIT_FILE]?.execute?.(
      {
        path: "/workspace/work.txt",
        old_string: "WORKSPACE_TOKEN",
        new_string: "WORKSPACE_EDITED_TOKEN",
      },
      { workspace } as never,
    );
    const workspaceReadAfterEdit = await tools[WORKSPACE_TOOLS.FILESYSTEM.READ_FILE]?.execute?.(
      { path: "/workspace/work.txt", showLineNumbers: false },
      { workspace } as never,
    );
    const workspaceGrepSearch = await tools[WORKSPACE_TOOLS.FILESYSTEM.GREP]?.execute?.(
      { pattern: "WORKSPACE_EDITED_TOKEN", path: "/workspace" },
      { workspace } as never,
    );
    const ordinarySourcesGrep = await tools[WORKSPACE_TOOLS.FILESYSTEM.GREP]?.execute?.(
      { pattern: "ORDINARY_SOURCES_TOKEN", path: "/workspace/project/sources/lib" },
      { workspace } as never,
    );
    const deniedTraversalAliasGrep = await tools[WORKSPACE_TOOLS.FILESYSTEM.GREP]?.execute?.(
      { pattern: "ROUND16_GENERIC_GREP_SECRET", path: "/workspace/project/../../sources/source_gate" },
      { workspace } as never,
    );
    const deniedWorkspaceSearch = await tools[WORKSPACE_TOOLS.SEARCH.SEARCH]?.execute?.(
      { query: "ROUND16_GENERIC_GREP_SECRET", topK: 5, mode: "bm25" },
      { workspace } as never,
    );
    const allowedWorkspaceSearch = await tools[WORKSPACE_TOOLS.SEARCH.SEARCH]?.execute?.(
      { query: "WORKSPACE_TOKEN", topK: 5, mode: "bm25" },
      { workspace } as never,
    );

    expect(String(listOutput)).toContain("secret.md");
    expect(dedicatedRead).toMatchObject({ ok: true });
    expect(JSON.stringify(dedicatedRead)).toContain("ROUND16_GENERIC_READ_SECRET");
    expect(dedicatedSearch).toMatchObject({ ok: true });
    expect(JSON.stringify(dedicatedSearch)).toContain("/sources/source_gate/nested/hit.txt");
    expect(deniedRead).toMatchObject({ ok: false });
    expect(JSON.stringify(deniedRead)).not.toContain("ROUND16_GENERIC_READ_SECRET");
    expect(deniedEditHit).toMatchObject({ ok: false });
    expect(deniedEditMiss).toMatchObject({ ok: false });
    expect(JSON.stringify(deniedEditHit)).toBe(JSON.stringify(deniedEditMiss));
    expect(JSON.stringify(deniedEditHit)).not.toContain("ROUND16_GENERIC_READ_SECRET");
    expect(JSON.stringify(deniedEditHit)).not.toContain("ROUND18_ABSENT_EDIT_ORACLE");
    expect(deniedGrep).toMatchObject({ ok: false });
    expect(JSON.stringify(deniedGrep)).not.toContain("ROUND16_GENERIC_GREP_SECRET");
    expect(deniedRootGrep).toMatchObject({ ok: false });
    expect(String(workspaceRead)).toContain("WORKSPACE_TOKEN");
    expect(JSON.stringify(workspaceEdit)).not.toContain("read-only");
    expect(String(workspaceReadAfterEdit)).toContain("WORKSPACE_EDITED_TOKEN");
    expect(String(workspaceGrepSearch)).toContain("WORKSPACE_EDITED_TOKEN");
    expect(String(ordinarySourcesGrep)).toContain("ORDINARY_SOURCES_TOKEN");
    expect(deniedTraversalAliasGrep).toMatchObject({ ok: false });
    expect(JSON.stringify(deniedTraversalAliasGrep)).not.toContain("ROUND16_GENERIC_GREP_SECRET");
    expect(String(deniedWorkspaceSearch)).not.toContain("ROUND16_GENERIC_GREP_SECRET");
    expect(String(deniedWorkspaceSearch)).not.toContain(source.mountPath);
    expect(String(allowedWorkspaceSearch)).toContain("WORKSPACE_TOKEN");
    expect(String(allowedWorkspaceSearch)).toContain("/workspace/work.txt");
  }, 30_000);

  it("list_files 列出的桌面路径在 Windows 上能原样交给 readDocument/searchDocuments", async () => {
    mkdirSync(join(root, "nested"), { recursive: true });
    writeFileSync(join(root, "nested", "contract.md"), "FOLDER_PATH_CONTRACT_TOKEN\n", "utf8");
    outsideRoot = mkdtempSync(join(tmpdir(), "folder-tool-gate-outside-"));
    writeFileSync(join(outsideRoot, "secret.md"), "OUTSIDE_FOLDER_SECRET\n", "utf8");
    symlinkSync(join(outsideRoot, "secret.md"), join(root, "nested", "link-out.md"));
    const source = makeSource(sessionId, root);
    registerSessionFolderSources(sessionId, [source]);
    invalidateSessionWorkspace(sessionId);

    const getWorkspace = () => getQingagentSessionWorkspace(sessionId);
    const getSources = () => getSessionFolderSources(sessionId);
    const workspace = await getWorkspace();
    const tools = await qingagentAgent.getToolsForExecution({
      requestContext: new RequestContext([["sessionId", sessionId]]),
      toolsets: {
        sessionScoped: {
          readDocument: createReadDocumentTool({ sessionId, getWorkspace, getSources }),
          searchDocuments: createSearchDocumentsTool({ sessionId, getWorkspace, getSources }),
          [WORKSPACE_TOOLS.FILESYSTEM.LIST_FILES]: createFolderSourceListFilesTool({ getWorkspace }),
        },
      },
    });

    const listOutput = await tools[WORKSPACE_TOOLS.FILESYSTEM.LIST_FILES]?.execute?.(
      { path: source.mountPath, maxDepth: 2, respectGitignore: false },
      { workspace } as never,
    );
    const listedPath = String(listOutput)
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line === `${source.mountPath}/nested/contract.md`);
    expect(listedPath, `list_files 输出:\n${String(listOutput)}`).toBe(
      `${source.mountPath}/nested/contract.md`,
    );
    if (!listedPath) throw new Error("list_files 未输出可直接读取的完整虚拟路径");

    const nativePlatform = process.platform;
    Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
    let read: unknown;
    let search: unknown;
    let searchResultRead: unknown;
    let deniedTraversal: unknown;
    let deniedExternalSymlink: unknown;
    try {
      read = await tools.readDocument?.execute?.(
        { path: listedPath, maxChars: 1_000 },
        { workspace } as never,
      );
      search = await tools.searchDocuments?.execute?.(
        { query: "FOLDER_PATH_CONTRACT_TOKEN", topK: 3 },
        { workspace } as never,
      );
      const searchResultPath = (
        search as { results?: Array<{ path?: unknown }> } | undefined
      )?.results?.[0]?.path;
      if (typeof searchResultPath === "string") {
        searchResultRead = await tools.readDocument?.execute?.(
          { path: searchResultPath, maxChars: 1_000 },
          { workspace } as never,
        );
      }
      deniedTraversal = await tools.readDocument?.execute?.(
        { path: `${source.mountPath}/nested/../contract.md`, maxChars: 1_000 },
        { workspace } as never,
      );
      deniedExternalSymlink = await tools.readDocument?.execute?.(
        { path: `${source.mountPath}/nested/link-out.md`, maxChars: 1_000 },
        { workspace } as never,
      );
    } finally {
      Object.defineProperty(process, "platform", { configurable: true, value: nativePlatform });
    }

    expect(read).toMatchObject({ ok: true, path: listedPath });
    expect(JSON.stringify(read)).toContain("FOLDER_PATH_CONTRACT_TOKEN");
    expect(search).toMatchObject({ ok: true });
    expect(JSON.stringify(search)).toContain(listedPath);
    expect(searchResultRead).toMatchObject({ ok: true, path: listedPath });
    expect(JSON.stringify(searchResultRead)).toContain("FOLDER_PATH_CONTRACT_TOKEN");
    expect(deniedTraversal).toMatchObject({ ok: false });
    expect(deniedExternalSymlink).toMatchObject({ ok: false });
    expect(JSON.stringify(deniedExternalSymlink)).not.toContain("OUTSIDE_FOLDER_SECRET");
  }, 30_000);
});
