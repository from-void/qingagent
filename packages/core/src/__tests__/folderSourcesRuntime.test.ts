import { describe, expect, it, vi } from "vitest";
import type { FolderSourceRecord } from "@qingagent/contract-ts";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  __folderSourceRuntimeStatsForTest,
  folderSourcesToWire,
  getSessionFolderSources,
  isFolderSourceCacheActive,
  markFolderSourceDetached,
  normalizeFolderSourceRecord,
  normalizeFolderSourceRecords,
  registerSessionFolderSources,
  __resetFolderSourceRuntimeForTest,
} from "../folderSources/runtime.js";

function makeSource(overrides: Partial<FolderSourceRecord> = {}): FolderSourceRecord {
  const now = "2026-01-01T00:00:00.000Z";
  const mountName = overrides.mountName ?? "source_docs";
  return {
    id: overrides.id ?? "fld_docs",
    sessionId: overrides.sessionId ?? "sess",
    provider: "desktop-local",
    name: overrides.name ?? "Docs",
    pathLabel: overrides.pathLabel ?? "Docs",
    mountName,
    mountPath: overrides.mountPath ?? `/sources/${mountName}`,
    readOnly: true,
    fileCount: null,
    fileCountCapped: false,
    status: "connected",
    error: null,
    createdAt: now,
    updatedAt: now,
    desktopRootPath: overrides.desktopRootPath ?? "/tmp/docs",
    ...overrides,
  };
}

function makeBrowserSource(overrides: Partial<FolderSourceRecord> = {}): FolderSourceRecord {
  const now = "2026-01-01T00:00:00.000Z";
  const mountName = overrides.mountName ?? "source_browser";
  return {
    id: overrides.id ?? "fld_browser",
    sessionId: overrides.sessionId ?? "sess",
    provider: "browser-fs-access",
    name: overrides.name ?? "Browser Docs",
    pathLabel: overrides.pathLabel ?? "Browser Docs",
    mountName,
    mountPath: overrides.mountPath ?? `/sources/${mountName}`,
    readOnly: true,
    fileCount: null,
    fileCountCapped: false,
    status: "connected",
    error: null,
    createdAt: now,
    updatedAt: now,
    browserHandleKey: overrides.browserHandleKey ?? "handle-1",
    browserClientSourceId: overrides.browserClientSourceId ?? "client-1",
    ...overrides,
  };
}

describe("folder source runtime invariants", () => {
  it("normalizeFolderSourceRecord 拒绝非法 mountName 和不一致 mountPath", () => {
    expect(normalizeFolderSourceRecord(makeSource({ mountName: "source/slash", mountPath: "/sources/source/slash" }))).toBeNull();
    expect(normalizeFolderSourceRecord(makeSource({ mountName: "source_\nnewline", mountPath: "/sources/source_\nnewline" }))).toBeNull();
    expect(normalizeFolderSourceRecord(makeSource({ mountName: "docs", mountPath: "/sources/docs" }))).toBeNull();
    expect(normalizeFolderSourceRecord(makeSource({ mountName: "source_docs", mountPath: "/sources/other" }))).toBeNull();
    expect(normalizeFolderSourceRecord(makeSource({ mountName: "source_docs9" }))?.mountPath).toBe("/sources/source_docs9");
  });

  it("normalizeFolderSourceRecords 对重复 mountName 保留首个 source", () => {
    const first = makeSource({ id: "fld_first", mountName: "source_dup", mountPath: "/sources/source_dup" });
    const second = makeSource({ id: "fld_second", mountName: "source_dup", mountPath: "/sources/source_dup" });

    expect(normalizeFolderSourceRecords([first, second]).map((source) => source.id)).toEqual(["fld_first"]);
  });

  it("normalizeFolderSourceRecord 拒绝非非负整数 fileCount", () => {
    expect(normalizeFolderSourceRecord(makeSource({ fileCount: -1 }))).toBeNull();
    expect(normalizeFolderSourceRecord(makeSource({ fileCount: 1.5 }))).toBeNull();
    expect(normalizeFolderSourceRecord(makeSource({ fileCount: Number.NaN }))).toBeNull();
    expect(normalizeFolderSourceRecord(makeSource({ fileCount: Number.POSITIVE_INFINITY }))).toBeNull();
    expect(normalizeFolderSourceRecord(makeSource({ fileCount: 0 }))?.fileCount).toBe(0);
    expect(normalizeFolderSourceRecord(makeSource({ fileCount: null }))?.fileCount).toBeNull();
  });

  it("normalizeFolderSourceRecord 不信任原型链上的必需字段", () => {
    const inherited = {
      __proto__: makeSource({
        id: "fld_proto",
        mountName: "source_proto",
        mountPath: "/sources/source_proto",
      }),
    };

    expect(Object.keys(inherited)).toEqual([]);
    expect(normalizeFolderSourceRecord(inherited)).toBeNull();
  });

  it("normalizeFolderSourceRecord 按 provider 收紧 connected 记录的私有字段", () => {
    const browser = normalizeFolderSourceRecord(makeBrowserSource());
    expect(browser?.provider).toBe("browser-fs-access");
    expect(browser?.browserHandleKey).toBe("handle-1");
    expect(browser?.browserClientSourceId).toBe("client-1");
    expect(browser?.desktopRootPath).toBeUndefined();

    const missingHandle = makeBrowserSource();
    delete missingHandle.browserHandleKey;
    expect(normalizeFolderSourceRecord(missingHandle)).toBeNull();
    expect(normalizeFolderSourceRecord(makeBrowserSource({ browserClientSourceId: "" }))).toBeNull();
    expect(normalizeFolderSourceRecord(makeBrowserSource({ desktopRootPath: "/tmp/leak" }))).toBeNull();

    expect(normalizeFolderSourceRecord(makeSource({
      browserHandleKey: "polluted-handle",
      browserClientSourceId: "polluted-client",
    }))).toBeNull();

    const desktop = normalizeFolderSourceRecord(makeSource());
    expect(desktop?.provider).toBe("desktop-local");
    expect(desktop?.desktopRootPath).toBe("/tmp/docs");
    expect(desktop?.browserHandleKey).toBeUndefined();
    expect(desktop?.browserClientSourceId).toBeUndefined();
  });

  it("folderSourcesToWire 摘要化 pathLabel 且不下发桌面真实绝对路径", () => {
    const root = join(homedir(), "Documents", "客户资料", "项目A");
    const wire = folderSourcesToWire([
      makeSource({
        id: "fld_home",
        pathLabel: root,
        desktopRootPath: root,
      }),
    ]);

    expect(wire[0]?.pathLabel).toBe("~/.../客户资料/项目A");
    expect(JSON.stringify(wire)).not.toContain(root);
    expect(JSON.stringify(wire)).not.toContain("desktopRootPath");
  });

  it("registerSessionFolderSources 拒绝 sessionId 不匹配的 source，防止注册入口绕过恢复校验", () => {
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const sessionId = "sess-a";
    const valid = makeSource({ id: "fld_a", sessionId, mountName: "source_a", mountPath: "/sources/source_a" });
    const foreign = makeSource({
      id: "fld_foreign",
      sessionId: "sess-b",
      mountName: "source_foreign",
      mountPath: "/sources/source_foreign",
    });

    registerSessionFolderSources(sessionId, [valid, foreign]);

    expect(getSessionFolderSources(sessionId).map((source) => source.id)).toEqual(["fld_a"]);
    expect(consoleWarn).toHaveBeenCalledWith(
      "[folderSources/runtime] skip source with mismatched sessionId",
      expect.objectContaining({
        sessionId,
        sourceId: "fld_foreign",
        sourceSessionId: "sess-b",
      }),
    );
    consoleWarn.mockRestore();
    __resetFolderSourceRuntimeForTest();
  });

  it("detached tombstone 有界，register 空 sources 后清理历史 Set 且迟到读仍被拒绝", () => {
    const sessionId = "sess-detached-bounded";
    for (let index = 0; index < 2_000; index += 1) {
      markFolderSourceDetached(sessionId, `fld_detached_${String(index).padStart(4, "0")}`);
    }

    const stats = __folderSourceRuntimeStatsForTest();
    expect(stats.detachedSizes[sessionId]).toBeLessThanOrEqual(256);
    expect(isFolderSourceCacheActive(sessionId, "fld_detached_1999")).toBe(false);

    registerSessionFolderSources(sessionId, []);

    expect(__folderSourceRuntimeStatsForTest().detachedSizes[sessionId]).toBeUndefined();
    expect(isFolderSourceCacheActive(sessionId, "fld_detached_0001")).toBe(false);
    __resetFolderSourceRuntimeForTest();
  });
});
