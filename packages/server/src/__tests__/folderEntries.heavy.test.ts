import { Hono } from "hono";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
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
} from "@qingagent/core";
import type { FolderSourceRecord } from "@qingagent/contract-ts";
import { folderEntriesRoutes } from "../routes/folderEntries";

function makeApp(): Hono {
  const app = new Hono();
  app.route("/api/v1", folderEntriesRoutes);
  return app;
}

function makeSource(sessionId: string, root: string): FolderSourceRecord {
  return {
    id: `fld_${sessionId}`,
    sessionId,
    provider: "desktop-local",
    name: "测试资料",
    pathLabel: "~/测试资料",
    mountName: `source_${sessionId.replace(/[^a-z0-9_]/gi, "_").toLowerCase()}`,
    mountPath: `/sources/source_${sessionId.replace(/[^a-z0-9_]/gi, "_").toLowerCase()}`,
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

function makeBrowserSource(sessionId: string): FolderSourceRecord {
  const mountName = `source_${sessionId.replace(/[^a-z0-9_]/gi, "_").toLowerCase()}`;
  return {
    id: `fld_${sessionId}`,
    sessionId,
    provider: "browser-fs-access",
    name: "浏览器资料",
    pathLabel: "浏览器资料",
    mountName,
    mountPath: `/sources/${mountName}`,
    readOnly: true,
    fileCount: null,
    fileCountCapped: false,
    status: "connected",
    error: null,
    createdAt: "2026-07-04T00:00:00.000Z",
    updatedAt: "2026-07-04T00:00:00.000Z",
    browserHandleKey: `handle_${sessionId}`,
    browserClientSourceId: `client_${sessionId}`,
  };
}

function registerFixture(sessionId: string): { root: string; source: FolderSourceRecord } {
  process.env.QINGAGENT_RUNTIME = "desktop";
  process.env.QINGAGENT_ENABLE_LOCAL_FOLDER_SOURCES = "1";
  const root = mkdtempSync(join(tmpdir(), "qingagent-folder-entries-"));
  const source = makeSource(sessionId, root);
  registerSessionFolderSources(sessionId, [source]);
  return { root, source };
}

afterEach(() => {
  delete process.env.QINGAGENT_RUNTIME;
  delete process.env.QINGAGENT_ENABLE_LOCAL_FOLDER_SOURCES;
  delete process.env.QINGAGENT_ENABLE_BROWSER_FOLDER_SOURCES;
  delete process.env.QINGAGENT_FOLDER_CHILD_COUNT_TIMEOUT_MS;
  delete process.env.QINGAGENT_FOLDER_ENTRY_STAT_TIMEOUT_MS;
  __resetBrowserFolderBridgeForTest();
});

describe("folderEntriesRoutes", () => {
  it("拒绝 path 穿越和绝对路径", async () => {
    const sessionId = "entries_traversal";
    const { root, source } = registerFixture(sessionId);
    const app = makeApp();
    try {
      const traversal = await app.request(
        `/api/v1/sessions/${sessionId}/folder-sources/${source.id}/entries?path=..%2Fsecret`,
      );
      expect(traversal.status).toBe(400);

      const absolute = await app.request(
        `/api/v1/sessions/${sessionId}/folder-sources/${source.id}/entries?path=%2Ftmp`,
      );
      expect(absolute.status).toBe(400);
    } finally {
      unregisterSessionFolderSources(sessionId);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("过滤隐藏文件、node_modules 和 .git，并给目录返回可见 childCount", async () => {
    const sessionId = "entries_filter";
    const { root, source } = registerFixture(sessionId);
    const app = makeApp();
    try {
      mkdirSync(join(root, "docs"));
      mkdirSync(join(root, "node_modules"));
      mkdirSync(join(root, ".git"));
      writeFileSync(join(root, "docs", "visible.md"), "ok");
      writeFileSync(join(root, "docs", ".hidden.md"), "hidden");
      writeFileSync(join(root, "visible.txt"), "hello");
      writeFileSync(join(root, ".secret"), "secret");

      const res = await app.request(`/api/v1/sessions/${sessionId}/folder-sources/${source.id}/entries`);
      expect(res.status).toBe(200);
      const body = await res.json() as {
        entries: Array<{ name: string; kind: "dir" | "file"; childCount: number | null; byteLen: number | null }>;
        truncated: boolean;
      };

      expect(body.truncated).toBe(false);
      expect(body.entries.map((entry) => entry.name)).toEqual(["docs", "visible.txt"]);
      expect(body.entries[0]).toMatchObject({ name: "docs", kind: "dir", childCount: 1, byteLen: null });
      expect(body.entries[1]).toMatchObject({ name: "visible.txt", kind: "file", byteLen: 5 });
    } finally {
      unregisterSessionFolderSources(sessionId);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("按 limit 截断并标记 truncated", async () => {
    const sessionId = "entries_truncated";
    const { root, source } = registerFixture(sessionId);
    const app = makeApp();
    try {
      for (const name of ["a.md", "b.md", "c.md", "d.md", "e.md"]) {
        writeFileSync(join(root, name), name);
      }

      const res = await app.request(
        `/api/v1/sessions/${sessionId}/folder-sources/${source.id}/entries?limit=3`,
      );
      expect(res.status).toBe(200);
      const body = await res.json() as { entries: Array<{ name: string }>; truncated: boolean };
      expect(body.entries.map((entry) => entry.name)).toEqual(["a.md", "b.md", "c.md"]);
      expect(body.truncated).toBe(true);
    } finally {
      unregisterSessionFolderSources(sessionId);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("找不到 session 或 folder 时返回 404", async () => {
    const app = makeApp();
    const missingSession = await app.request("/api/v1/sessions/missing/folder-sources/fld/entries");
    expect(missingSession.status).toBe(404);

    const sessionId = "entries_missing_folder";
    const { root } = registerFixture(sessionId);
    try {
      const missingFolder = await app.request(
        `/api/v1/sessions/${sessionId}/folder-sources/fld_missing/entries`,
      );
      expect(missingFolder.status).toBe(404);
    } finally {
      unregisterSessionFolderSources(sessionId);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("并发处理子项，childCount 慢/挂时返回 null 且不拖垮整层", async () => {
    const sessionId = "entries_child_count_timeout";
    const { root, source } = registerFixture(sessionId);
    const app = makeApp();
    process.env.QINGAGENT_FOLDER_CHILD_COUNT_TIMEOUT_MS = "30";
    const workspace = await getQingagentSessionWorkspace(sessionId);
    const filesystem = workspace.filesystem!;
    const originalReaddir = filesystem.readdir.bind(filesystem);
    const originalStat = filesystem.stat.bind(filesystem);
    let activeStats = 0;
    let maxActiveStats = 0;
    const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

    filesystem.readdir = async (path) => {
      if (path === source.mountPath) {
        return [
          { name: "ok", type: "directory" },
          { name: "slow", type: "directory" },
          { name: "throwing", type: "directory" },
          { name: "file.txt", type: "file", size: 5 },
        ];
      }
      if (path === `${source.mountPath}/ok`) {
        await delay(10);
        return [
          { name: "visible.md", type: "file", size: 2 },
          { name: ".hidden.md", type: "file", size: 6 },
        ];
      }
      if (path === `${source.mountPath}/slow`) {
        return await new Promise<Awaited<ReturnType<typeof filesystem.readdir>>>(() => {});
      }
      if (path === `${source.mountPath}/throwing`) {
        throw new Error("child count failed");
      }
      return await originalReaddir(path);
    };

    filesystem.stat = async (path) => {
      activeStats += 1;
      maxActiveStats = Math.max(maxActiveStats, activeStats);
      try {
        await delay(20);
        const name = path.split("/").pop() ?? "";
        const now = new Date("2026-07-04T00:00:00.000Z");
        if (path === `${source.mountPath}/file.txt`) {
          return { name, path, type: "file", size: 5, createdAt: now, modifiedAt: now };
        }
        return { name, path, type: "directory", size: 0, createdAt: now, modifiedAt: now };
      } finally {
        activeStats -= 1;
      }
    };

    try {
      const startedAt = Date.now();
      const res = await app.request(`/api/v1/sessions/${sessionId}/folder-sources/${source.id}/entries`);
      const elapsedMs = Date.now() - startedAt;

      expect(res.status).toBe(200);
      expect(elapsedMs).toBeLessThan(300);
      expect(maxActiveStats).toBeGreaterThan(1);
      const body = await res.json() as {
        entries: Array<{ name: string; kind: "dir" | "file"; childCount: number | null; byteLen: number | null }>;
        truncated: boolean;
      };
      expect(body.truncated).toBe(false);
      expect(body.entries).toEqual([
        { name: "ok", kind: "dir", childCount: 1, byteLen: null },
        { name: "slow", kind: "dir", childCount: null, byteLen: null },
        { name: "throwing", kind: "dir", childCount: null, byteLen: null },
        { name: "file.txt", kind: "file", childCount: null, byteLen: 5 },
      ]);
    } finally {
      filesystem.readdir = originalReaddir;
      filesystem.stat = originalStat;
      unregisterSessionFolderSources(sessionId);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("逐项 stat 慢/挂时走 readdir 信息兜底，不拖死整层", async () => {
    const sessionId = "entries_stat_timeout";
    const { root, source } = registerFixture(sessionId);
    const app = makeApp();
    process.env.QINGAGENT_FOLDER_ENTRY_STAT_TIMEOUT_MS = "30";
    const workspace = await getQingagentSessionWorkspace(sessionId);
    const filesystem = workspace.filesystem!;
    const originalReaddir = filesystem.readdir.bind(filesystem);
    const originalStat = filesystem.stat.bind(filesystem);

    filesystem.readdir = async (path) => {
      if (path === source.mountPath) {
        return [{ name: "from-readdir.txt", type: "file", size: 12 }];
      }
      return await originalReaddir(path);
    };
    filesystem.stat = async (path) => {
      if (path === `${source.mountPath}/from-readdir.txt`) {
        return await new Promise<Awaited<ReturnType<typeof filesystem.stat>>>(() => {});
      }
      return await originalStat(path);
    };

    try {
      const startedAt = Date.now();
      const res = await app.request(`/api/v1/sessions/${sessionId}/folder-sources/${source.id}/entries`);
      const elapsedMs = Date.now() - startedAt;
      expect(res.status).toBe(200);
      expect(elapsedMs).toBeLessThan(300);
      const body = await res.json() as {
        entries: Array<{ name: string; kind: "dir" | "file"; childCount: number | null; byteLen: number | null }>;
      };
      expect(body.entries).toEqual([
        { name: "from-readdir.txt", kind: "file", childCount: null, byteLen: 12 },
      ]);
    } finally {
      filesystem.readdir = originalReaddir;
      filesystem.stat = originalStat;
      unregisterSessionFolderSources(sessionId);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("browser-fs-access 嵌套 path 能经 SSE 桥 readdir 返回子目录条目", async () => {
    const sessionId = "entries_browser_nested";
    process.env.QINGAGENT_ENABLE_BROWSER_FOLDER_SOURCES = "1";
    const source = makeBrowserSource(sessionId);
    registerSessionFolderSources(sessionId, [source]);
    const app = makeApp();
    const requests: Array<{ op: string; relPath: string }> = [];
    const now = "2026-07-04T00:00:00.000Z";
    const close = openBrowserFolderBridgeConnection({
      sessionId,
      clientId: source.browserClientSourceId!,
      send: async (request) => {
        requests.push({ op: request.op, relPath: request.relPath });
        if (request.op === "readdir") {
          const entries =
            request.relPath === "images"
              ? [
                  { name: "cat.png", type: "file" as const, size: 4 },
                  { name: "nested", type: "directory" as const },
                ]
              : request.relPath === "images/nested"
                ? [{ name: "deep.txt", type: "file" as const, size: 5 }]
                : [];
          resolveBrowserFolderBridgeResponse(request.requestId, {
            sessionId,
            folderId: source.id,
            clientId: source.browserClientSourceId!,
            response: { ok: true, op: "readdir", entries },
          });
          return;
        }
        const type = request.relPath.endsWith(".png") || request.relPath.endsWith(".txt") ? "file" : "directory";
        resolveBrowserFolderBridgeResponse(request.requestId, {
          sessionId,
          folderId: source.id,
          clientId: source.browserClientSourceId!,
          response: {
            ok: true,
            op: "stat",
            stat: {
              name: request.relPath.split("/").pop() ?? source.name,
              type,
              size: type === "file" ? (request.relPath.endsWith(".png") ? 4 : 5) : 0,
              createdAt: now,
              modifiedAt: now,
            },
          },
        });
      },
    });

    try {
      const res = await app.request(
        `/api/v1/sessions/${sessionId}/folder-sources/${source.id}/entries?path=images`,
      );
      expect(res.status).toBe(200);
      const body = await res.json() as {
        entries: Array<{ name: string; kind: "dir" | "file"; childCount: number | null; byteLen: number | null }>;
        truncated: boolean;
      };
      expect(requests).toContainEqual({ op: "readdir", relPath: "images" });
      expect(body).toEqual({
        entries: [
          { name: "nested", kind: "dir", childCount: 1, byteLen: null },
          { name: "cat.png", kind: "file", childCount: null, byteLen: 4 },
        ],
        truncated: false,
      });
    } finally {
      close();
      unregisterSessionFolderSources(sessionId);
    }
  });

  it("browser bridge 从未连接时 /entries 在默认首连宽限后返回可辨识中文错误", async () => {
    const sessionId = "entries_browser_offline";
    process.env.QINGAGENT_ENABLE_BROWSER_FOLDER_SOURCES = "1";
    const source = makeBrowserSource(sessionId);
    registerSessionFolderSources(sessionId, [source]);
    const app = makeApp();

    try {
      const startedAt = Date.now();
      const res = await app.request(`/api/v1/sessions/${sessionId}/folder-sources/${source.id}/entries`);
      const elapsedMs = Date.now() - startedAt;
      expect(elapsedMs).toBeGreaterThanOrEqual(2_900);
      expect(elapsedMs).toBeLessThan(3_500);
      expect(res.status).toBe(502);
      const body = await res.json() as { error: string; message: string };
      expect(body.message).toContain("浏览器会话未连接到该文件夹");
    } finally {
      unregisterSessionFolderSources(sessionId);
    }
  });

  it.each([
    ["not_found", "entries", 404],
    ["permission_denied", "file?path=private.md", 403],
    ["too_large", "file?path=large.bin", 413],
  ] as const)(
    "browser bridge 客户端 %s 在 %s 映射为 HTTP %s",
    async (reasonCode, endpoint, expectedStatus) => {
      const sessionId = `entries_browser_${reasonCode}`;
      process.env.QINGAGENT_ENABLE_BROWSER_FOLDER_SOURCES = "1";
      const source = makeBrowserSource(sessionId);
      registerSessionFolderSources(sessionId, [source]);
      const leak = "/Users/alice/Private/leak.md CLIENT_ERROR_BODY";
      const close = openBrowserFolderBridgeConnection({
        sessionId,
        clientId: source.browserClientSourceId!,
        send: async (request) => {
          resolveBrowserFolderBridgeResponse(request.requestId, {
            sessionId,
            folderId: source.id,
            clientId: source.browserClientSourceId!,
            response: { ok: false, reasonCode, error: leak },
          });
        },
      });
      const app = makeApp();

      try {
        const res = await app.request(
          `/api/v1/sessions/${sessionId}/folder-sources/${source.id}/${endpoint}`,
        );
        expect(res.status).toBe(expectedStatus);
        const body = await res.json() as { message: string };
        expect(body.message).not.toContain(leak);
        expect(body.message).not.toContain("断开后重新连接");
      } finally {
        close();
        unregisterSessionFolderSources(sessionId);
      }
    },
  );

  it("读取文件预览端点返回文本内容和 Content-Type", async () => {
    const sessionId = "entries_file_text";
    const { root, source } = registerFixture(sessionId);
    const app = makeApp();
    try {
      mkdirSync(join(root, "docs"));
      writeFileSync(join(root, "docs", "readme.md"), "hello preview");

      const res = await app.request(
        `/api/v1/sessions/${sessionId}/folder-sources/${source.id}/file?path=docs/readme.md`,
      );
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/plain");
      expect(await res.text()).toBe("hello preview");
    } finally {
      unregisterSessionFolderSources(sessionId);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("读取文件预览端点拒绝 path 穿越", async () => {
    const sessionId = "entries_file_traversal";
    const { root, source } = registerFixture(sessionId);
    const app = makeApp();
    try {
      const res = await app.request(
        `/api/v1/sessions/${sessionId}/folder-sources/${source.id}/file?path=..%2Fsecret.txt`,
      );
      expect(res.status).toBe(400);
    } finally {
      unregisterSessionFolderSources(sessionId);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("读取文件预览端点对不存在文件返回 404", async () => {
    const sessionId = "entries_file_missing";
    const { root, source } = registerFixture(sessionId);
    const app = makeApp();
    try {
      const res = await app.request(
        `/api/v1/sessions/${sessionId}/folder-sources/${source.id}/file?path=missing.txt`,
      );
      expect(res.status).toBe(404);
    } finally {
      unregisterSessionFolderSources(sessionId);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("browser bridge 从未连接时 /file 在默认首连宽限后返回可辨识中文错误", async () => {
    const sessionId = "entries_file_browser_offline";
    process.env.QINGAGENT_ENABLE_BROWSER_FOLDER_SOURCES = "1";
    const source = makeBrowserSource(sessionId);
    registerSessionFolderSources(sessionId, [source]);
    const app = makeApp();

    try {
      const startedAt = Date.now();
      const res = await app.request(
        `/api/v1/sessions/${sessionId}/folder-sources/${source.id}/file?path=docs/readme.md`,
      );
      const elapsedMs = Date.now() - startedAt;
      expect(elapsedMs).toBeGreaterThanOrEqual(2_900);
      expect(elapsedMs).toBeLessThan(3_500);
      expect(res.status).toBe(502);
      const body = await res.json() as { error: string; message: string };
      expect(body.message).toContain("浏览器会话未连接到该文件夹");
    } finally {
      unregisterSessionFolderSources(sessionId);
    }
  });

  it("读取文件预览端点按 maxBytes 返回 413", async () => {
    const sessionId = "entries_file_too_large";
    const { root, source } = registerFixture(sessionId);
    const app = makeApp();
    try {
      writeFileSync(join(root, "big.txt"), "abcdef");
      const res = await app.request(
        `/api/v1/sessions/${sessionId}/folder-sources/${source.id}/file?path=big.txt&maxBytes=3`,
      );
      expect(res.status).toBe(413);
    } finally {
      unregisterSessionFolderSources(sessionId);
      rmSync(root, { recursive: true, force: true });
    }
  });
});
