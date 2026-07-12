import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CoreMessage } from "ai";
import type {
  ChatMessage,
  LegacySection,
  DocState,
  IncomingDocState,
  FolderSourceRecord,
  ToolCallSpec,
} from "@qingagent/contract-ts";
import type { SessionState } from "../bridge/sessionState.js";
import type { QingagentThreadMetadata } from "../bridge/threadPersistence.js";
import { documentDraftRepo } from "@qingagent/db";
import { documentRepo } from "@qingagent/db";
import { insertVersion, listVersions } from "@qingagent/db";
import {
  prepareTempDocumentsDb,
  type TempDocumentsDb,
} from "@qingagent/db/testing";
import { getPmContentHash, legacySectionsToPm } from "@qingagent/pm-schema";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { memory, threads, spans, observability, logger } = vi.hoisted(() => {
  const threads = new Map<string, Record<string, unknown>>();
  const spans: Array<{ input: unknown; output: unknown }> = [];
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  const observability = {
    getDefaultInstance: () => ({
      startSpan: vi.fn((input: unknown) => {
        const recorded = { input, output: undefined as unknown };
        return {
          end: vi.fn((output: unknown) => {
            recorded.output = output;
            spans.push(recorded);
          }),
        };
      }),
    }),
  };
  const memory = {
    saveThread: vi.fn(async ({ thread }: { thread: Record<string, unknown> }) => {
      threads.set(thread.id as string, thread);
    }),
    listThreads: vi.fn(
      async ({
        filter,
        page,
        perPage,
      }: {
        filter: { resourceId: string };
        page: number;
        perPage: number | false;
      }) => {
        const all = Array.from(threads.values())
          .filter((thread) => thread.resourceId === filter.resourceId)
          .sort(
            (a, b) =>
              (b.updatedAt as Date).getTime() - (a.updatedAt as Date).getTime(),
          );
        if (perPage === false) {
          return {
            threads: all,
            total: all.length,
            hasMore: false,
          };
        }
        const start = page * perPage;
        return {
          threads: all.slice(start, start + perPage),
          total: all.length,
          hasMore: start + perPage < all.length,
        };
      },
    ),
    updateThread: vi.fn(
      async ({
        id,
        title,
        metadata,
      }: {
        id: string;
        title: string;
        metadata: Record<string, unknown>;
      }) => {
        const existing = threads.get(id) ?? {
          id,
          resourceId: "qingagent-user",
          createdAt: new Date("2026-01-01T00:00:00.000Z"),
        };
        threads.set(id, {
          ...existing,
          id,
          title,
          metadata,
          updatedAt: new Date("2026-01-01T00:00:00.000Z"),
        });
      },
    ),
    getThreadById: vi.fn(async ({ threadId }: { threadId: string }) => {
      return threads.get(threadId) ?? null;
    }),
    deleteThread: vi.fn(async (threadId: string) => {
      threads.delete(threadId);
    }),
    recall: vi.fn(async () => ({ messages: [] })),
  };
  return { memory, threads, spans, observability, logger };
});

vi.mock("../mastra.js", () => ({
  mastra: {
    getLogger: () => logger,
    getMemory: () => memory,
  },
  getObservability: () => observability,
}));

vi.mock("../bridge/agentSpans.js", () => ({
  sessionIdToTraceId: (sessionId: string) => `trace-${sessionId}`,
}));

function textSection(text: string): LegacySection {
  return { kind: "p", data: { text } };
}

function chatMessage(id: string): ChatMessage {
  return {
    id,
    role: { kind: "agent" },
    ts: "2026-01-01T00:00:00.000Z",
    parts: [{ kind: "text", data: { body: "done" } }],
    chips: null,
  };
}

function toolCall(
  name: string,
  status: ToolCallSpec["status"],
  id = `${name}-1`,
): ToolCallSpec {
  return {
    id,
    name,
    render: { kind: ["askUser", "planDraft", "askUserQuestion"].includes(name) ? "rightForm" : "chatInline" },
    status,
    body: ["askUser", "planDraft", "askUserQuestion"].includes(name)
      ? {
          kind: "askUser",
          data: {
            id,
            mode: { kind: "fullpage" },
            purpose: { kind: "initialBrief" },
            source: null,
            rationale: null,
            questions: [
              {
                id: "q-one",
                label: "需要确认什么？",
                kind: { kind: "text" },
                options: [],
                placeholder: null,
              },
            ],
          },
        }
      : { kind: "generic", data: { argsJson: "{}" } },
    result: null,
  };
}

function toolMessage(spec: ToolCallSpec, id = `msg-${spec.id}`): ChatMessage {
  return {
    id,
    role: { kind: "agent" },
    ts: "2026-01-01T00:00:00.000Z",
    parts: [{ kind: "toolCall", data: spec }],
    chips: null,
  };
}

function suggestionRecord(id = "patch-1"): NonNullable<QingagentThreadMetadata["suggestions"]>[number] {
  return {
    id,
    messageId: "msg-patch",
    toolCallId: id,
    before: "正文",
    after: "正文修改",
    blockIndex: 0,
    suggestion: {
      id,
      docId: "doc-1",
      baseVersion: 1,
      baseSchemaVersion: 1,
      status: "reviewing",
      anchor: {
        blockId: "block-review",
        pmFrom: 1,
        pmTo: 3,
        quote: "正文",
        textHash: "test",
      },
      patch: { kind: "prosemirror_steps", steps: [] },
      preview: { deleteText: "正文", insertText: "正文修改" },
      summary: "修改正文",
    },
  };
}

function addSuggestion(state: SessionState, id = "patch-1"): void {
  state.doc ??= legacySectionsToPm(state.legacySections as never);
  const record = suggestionRecord(id);
  state.suggestions.set(id, {
    messageId: record.messageId,
    toolCallId: record.toolCallId,
    before: record.before,
    after: record.after,
    blockIndex: record.blockIndex,
    suggestion: {
      ...record.suggestion,
      docId: state.docId,
      baseVersion: state.docVersion,
      baseSchemaVersion: state.doc.attrs.schemaVersion,
      anchor: {
        ...record.suggestion.anchor,
        blockId: state.doc.content[0]?.attrs.blockId ?? record.suggestion.anchor.blockId,
      },
    },
  });
}

function storedThread(sessionId: string, metadata: QingagentThreadMetadata): Record<string, unknown> {
  return {
    id: sessionId,
    title: metadata.title,
    resourceId: "qingagent-user",
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    metadata,
  };
}

function metadata(overrides: Partial<QingagentThreadMetadata> = {}): QingagentThreadMetadata {
  return {
    docId: "doc-1",
    docState: { kind: "editing" },
    docVersion: 1,
    lastContentEditedAt: "2026-01-01T00:00:00.000Z",
    lastSyncedDocumentSnapshot: 1,
    legacySections: [textSection("正文")],
    materials: [],
    title: "标题",
    runId: null,
    toolCallId: null,
    askUserCompleted: false,
    lastPersistedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function pmDoc(text: string) {
  return legacySectionsToPm([textSection(text)] as never);
}

async function saveDocumentRow(input: {
  docId: string;
  sessionId: string;
  text: string;
  docVersion: number;
}): Promise<void> {
  const doc = pmDoc(input.text);
  await documentRepo.save({
    id: input.docId,
    threadId: input.sessionId,
    resourceId: "qingagent-user",
    title: `doc-${input.docId}`,
    docState: "editing",
    docVersion: input.docVersion,
    lastSyncedVersion: input.docVersion,
    pmDoc: doc,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  });
}

function expectRestoredText(restored: SessionState | null, expected: string): void {
  expect(restored?.doc).toEqual(pmDoc(expected));
  expect(restored?.legacySections).toEqual([textSection(expected)]);
}

function folderSourceRecord(sessionId: string, root: string): FolderSourceRecord {
  const now = "2026-01-01T00:00:00.000Z";
  return {
    id: "fld_restore_missing",
    sessionId,
    provider: "desktop-local",
    name: "Restore Missing",
    pathLabel: root,
    mountName: "source_restore_missing",
    mountPath: "/sources/source_restore_missing",
    readOnly: true,
    fileCount: 1,
    fileCountCapped: false,
    status: "connected",
    error: null,
    createdAt: now,
    updatedAt: now,
    desktopRootPath: root,
  };
}

function browserFolderSourceRecord(sessionId: string): FolderSourceRecord {
  const now = "2026-01-01T00:00:00.000Z";
  return {
    id: "fld_browser_restore",
    sessionId,
    provider: "browser-fs-access",
    name: "Browser Restore",
    pathLabel: "Browser Restore",
    mountName: "source_browser_restore",
    mountPath: "/sources/source_browser_restore",
    readOnly: true,
    fileCount: null,
    fileCountCapped: false,
    status: "connected",
    error: null,
    createdAt: now,
    updatedAt: now,
    browserHandleKey: "handle-browser-restore",
    browserClientSourceId: "client-browser-restore",
  };
}

function legacyDocState(kind: IncomingDocState["kind"]): QingagentThreadMetadata["docState"] {
  return { kind } as QingagentThreadMetadata["docState"];
}

function expectRestoredStableFields(restored: SessionState | null, original: SessionState): void {
  expect(restored).not.toBeNull();
  expect(restored?.sessionId).toBe(original.sessionId);
  expect(restored?.docId).toBe(original.docId);
  expect(restored?.threadId).toBe(original.sessionId);
  expect(restored?.resourceId).toBe("qingagent-user");
  expect(restored?.turnCounter).toBe(original.turnCounter);
  expect(restored?.omSidecarCursor).toEqual(original.omSidecarCursor);
  expect(restored?.omObservedMessageIds).toEqual(original.omObservedMessageIds);
  expect(restored?.omCompressionActive).toBe(original.omCompressionActive);
  expect(restored?.omCompressionEpoch).toBe(original.omCompressionEpoch);
  expect(restored?.omCompressionSnapshot).toEqual(original.omCompressionSnapshot);
  expect(restored?.branchTitleGenerated).toBe(original.branchTitleGenerated);
  expect(restored?.title).toBe(original.title);
  expect(restored?.docState).toEqual(original.docState);
  expect(restored?.messages).toEqual(original.messages);
  expect(restored?.legacySections).toEqual(original.legacySections);
  expect(restored?.docVersion).toBe(original.docVersion);
  expect(restored?.lastContentEditedAt).toBe(original.lastContentEditedAt);
  expect(restored?.suggestions).toEqual(original.suggestions);
  expect(restored?.patchVerdicts).toEqual(original.patchVerdicts);
  expect(restored?.materials).toEqual(original.materials);
  expect(restored?.lastSyncedDocumentSnapshot).toBe(original.lastSyncedDocumentSnapshot);
  expect(restored?.selectedSkills).toEqual(original.selectedSkills);
  expect(restored?.selectedSkillsHadSelection).toBe(original.selectedSkillsHadSelection);
  expect(restored?._askUserCompleted).toBe(original._askUserCompleted);
  expect(restored?._directionChangeAskedSinceLastWrite).toBe(original._directionChangeAskedSinceLastWrite);
  expect(restored?.chatHistory).toEqual(original.chatHistory);
  expect(restored?.streamId).toBeNull();
  expect(restored?.runId).toBeNull();
  expect(restored?.toolCallId).toBeNull();
}

describe("thread persistence", () => {
  let tempDb: TempDocumentsDb;

  beforeEach(() => {
    // 影子双写已恒开:用临时 libsql 库做真隔离,双写落在临时库而不是工作目录的 qingagent.db。
    tempDb = prepareTempDocumentsDb("qingagent-thread-persistence-");
    threads.clear();
    spans.length = 0;
    vi.restoreAllMocks();
    vi.clearAllMocks();
    delete process.env.QINGAGENT_RUNTIME;
    delete process.env.QINGAGENT_ENABLE_LOCAL_FOLDER_SOURCES;
    delete process.env.QINGAGENT_ENABLE_BROWSER_FOLDER_SOURCES;
  });

  afterEach(() => {
    delete process.env.QINGAGENT_RUNTIME;
    delete process.env.QINGAGENT_ENABLE_LOCAL_FOLDER_SOURCES;
    delete process.env.QINGAGENT_ENABLE_BROWSER_FOLDER_SOURCES;
    tempDb.cleanup();
  });

  it("persists and restores docId", async () => {
    const { createSession } = await import("../bridge/sessionState.js");
    const { loadSessionFromThread, persistSessionMetadata } = await import(
      "../bridge/threadPersistence.js"
    );
    const state = createSession("session-docid");
    state.docId = "doc-explicit";
    state.title = "含 docId";
    state.legacySections = [textSection("正文")];
    state.docState = { kind: "editing" };

    await persistSessionMetadata(state);
    const restored = await loadSessionFromThread(state.sessionId);

    expect(restored?.docId).toBe("doc-explicit");
  });

  it("falls back to sessionId when restoring old metadata without docId", async () => {
    const { loadSessionFromThread } = await import("../bridge/threadPersistence.js");
    const sessionId = "legacy-session";
    const oldMeta = metadata({ docId: undefined });
    delete oldMeta.docId;
    threads.set(sessionId, storedThread(sessionId, oldMeta));

    const restored = await loadSessionFromThread(sessionId);

    expect(restored?.docId).toBe(sessionId);
  });

  it("旧 metadata 懒回填冻结的 thread.updatedAt，await 返回即落盘且二次冷开幂等", async () => {
    const { loadSessionFromThread } = await import("../bridge/threadPersistence.js");
    const sessionId = "legacy-content-time-backfill";
    const oldMeta = metadata({ docId: sessionId });
    delete oldMeta.lastContentEditedAt;
    const thread = storedThread(sessionId, oldMeta);
    thread.updatedAt = new Date("2025-05-06T07:08:09.000Z");
    threads.set(sessionId, thread);
    vi.spyOn(documentRepo, "load").mockResolvedValue(null);

    const first = await loadSessionFromThread(sessionId);

    expect(first?.lastContentEditedAt).toBe("2025-05-06T07:08:09.000Z");
    const persistedAfterAwait = threads.get(sessionId)?.metadata as QingagentThreadMetadata;
    expect(persistedAfterAwait.lastContentEditedAt).toBe("2025-05-06T07:08:09.000Z");
    expect((threads.get(sessionId)?.updatedAt as Date).toISOString())
      .toBe("2026-01-01T00:00:00.000Z");

    memory.updateThread.mockClear();
    const second = await loadSessionFromThread(sessionId);
    expect(second?.lastContentEditedAt).toBe("2025-05-06T07:08:09.000Z");
    expect(memory.updateThread).not.toHaveBeenCalled();
  });

  it("metadata 内容时间有效且版本未前进时，恢复不再读取被打开推进的 thread.updatedAt", async () => {
    const { loadSessionFromThread } = await import("../bridge/threadPersistence.js");
    const sessionId = "valid-content-time-no-backfill";
    const thread = storedThread(sessionId, metadata({
      docId: sessionId,
      lastContentEditedAt: "2024-01-02T03:04:05.000Z",
    }));
    Object.defineProperty(thread, "updatedAt", {
      get: () => {
        throw new Error("有效 metadata 不应读取 thread.updatedAt");
      },
    });
    threads.set(sessionId, thread);
    vi.spyOn(documentRepo, "load").mockResolvedValue(null);

    const restored = await loadSessionFromThread(sessionId);

    expect(restored?.lastContentEditedAt).toBe("2024-01-02T03:04:05.000Z");
    expect(memory.updateThread).not.toHaveBeenCalled();
  });

  it("崩溃窗口按 doc_id + to_version 恢复真实 op 时间，并在返回前覆盖陈旧合法 metadata", async () => {
    const { commitDocumentOp } = await import("../bridge/commitDocumentOp.js");
    const { loadSessionFromThread } = await import("../bridge/threadPersistence.js");
    const sessionId = "content-time-crash-window";
    await saveDocumentRow({
      docId: sessionId,
      sessionId,
      text: "version one",
      docVersion: 1,
    });
    const committed = await commitDocumentOp({
      docId: sessionId,
      threadId: sessionId,
      resourceId: "qingagent-user",
      expectedDocumentSnapshot: 1,
      opId: "crash-window-v2",
      opKind: "replace_doc",
      actorType: "user",
      apply: () => ({ nextDoc: pmDoc("version two") }),
    }, { now: () => "2026-04-05T06:07:08.901Z" });
    expect(committed).toMatchObject({
      status: "committed",
      docVersion: 2,
      committedAt: "2026-04-05T06:07:08.901Z",
    });
    threads.set(sessionId, storedThread(sessionId, metadata({
      docId: sessionId,
      docVersion: 1,
      doc: pmDoc("version one"),
      legacySections: [textSection("version one")],
      lastContentEditedAt: "2020-01-01T00:00:00.000Z",
    })));

    const first = await loadSessionFromThread(sessionId);

    expect(first?.docVersion).toBe(2);
    expect(first?.lastContentEditedAt).toBe("2026-04-05T06:07:08.901Z");
    const persisted = threads.get(sessionId)?.metadata as QingagentThreadMetadata;
    expect(persisted.docVersion).toBe(2);
    expect(persisted.lastContentEditedAt).toBe("2026-04-05T06:07:08.901Z");

    memory.updateThread.mockClear();
    const second = await loadSessionFromThread(sessionId);
    expect(second?.lastContentEditedAt).toBe("2026-04-05T06:07:08.901Z");
    expect(memory.updateThread).not.toHaveBeenCalled();
  });

  it("崩溃窗口精确 op 时间缺失时仍持久化 documents DB-win", async () => {
    const { loadSessionFromThread } = await import("../bridge/threadPersistence.js");
    const sessionId = "content-time-crash-window-missing-op";
    await saveDocumentRow({
      docId: sessionId,
      sessionId,
      text: "documents v2 without op",
      docVersion: 2,
    });
    threads.set(sessionId, storedThread(sessionId, metadata({
      docId: sessionId,
      docVersion: 1,
      lastContentEditedAt: "2020-01-01T00:00:00.000Z",
    })));

    const restored = await loadSessionFromThread(sessionId);

    expect(restored?.docVersion).toBe(2);
    expect(restored?.lastContentEditedAt).toBe("2020-01-01T00:00:00.000Z");
    expect(memory.updateThread).toHaveBeenCalled();
    expect((threads.get(sessionId)?.metadata as QingagentThreadMetadata).docVersion).toBe(2);
  });

  it("恢复时丢弃损坏的 folderSources metadata", async () => {
    const { loadSessionFromThread } = await import("../bridge/threadPersistence.js");
    const { folderSourcesToWire } = await import("../folderSources/runtime.js");

    const nonArraySession = "folder-sources-non-array";
    threads.set(
      nonArraySession,
      storedThread(nonArraySession, metadata({ folderSources: "not-an-array" as never })),
    );
    const nonArrayRestored = await loadSessionFromThread(nonArraySession);
    expect(nonArrayRestored?.folderSources.size).toBe(0);

    const partialSession = "folder-sources-partial";
    threads.set(
      partialSession,
      storedThread(
        partialSession,
        metadata({
          folderSources: [
            { id: "fld_partial_only" },
            {
              id: "fld_missing_root",
              sessionId: partialSession,
              provider: "desktop-local",
              name: "坏资料库",
              pathLabel: "/redacted",
              mountName: "source_bad",
              mountPath: "/sources/source_bad",
              readOnly: true,
              fileCount: null,
              fileCountCapped: false,
              status: "connected",
              error: null,
              createdAt: "2026-01-01T00:00:00.000Z",
              updatedAt: "2026-01-01T00:00:00.000Z",
            },
          ] as never,
        }),
      ),
    );
    const partialRestored = await loadSessionFromThread(partialSession);
    expect(partialRestored?.folderSources.size).toBe(0);
    expect(folderSourcesToWire(partialRestored?.folderSources.values() ?? [])).toEqual([]);
  });

  it("冷恢复时把已删除的 desktop-local 目录标为 missing", async () => {
    process.env.QINGAGENT_RUNTIME = "desktop";
    process.env.QINGAGENT_ENABLE_LOCAL_FOLDER_SOURCES = "1";
    const { loadSessionFromThread } = await import("../bridge/threadPersistence.js");
    const {
      getSessionFolderSources,
      __resetFolderSourceRuntimeForTest,
    } = await import("../folderSources/runtime.js");
    const sessionId = "folder-source-missing-root";
    const root = mkdtempSync(join(tmpdir(), "qingagent-missing-root-"));
    writeFileSync(join(root, "alive.md"), "before delete");
    const source = folderSourceRecord(sessionId, root);
    threads.set(sessionId, storedThread(sessionId, metadata({
      folderSources: [source],
    })));

    rmSync(root, { recursive: true, force: true });
    const restored = await loadSessionFromThread(sessionId);
    const restoredSource = restored?.folderSources.get(source.id);
    const registrySources = getSessionFolderSources(sessionId);

    expect(restoredSource?.status).toBe("missing");
    expect(restoredSource?.error).toContain("不存在或无法访问");
    expect(registrySources).toHaveLength(1);
    expect(registrySources[0]?.status).toBe("missing");
    expect(registrySources.every((item) => item.status !== "connected")).toBe(true);

    __resetFolderSourceRuntimeForTest();
  });

  it("Round9 回归:无 desktop-local flag 冷恢复时不注册为可读 connected", async () => {
    const { loadSessionFromThread } = await import("../bridge/threadPersistence.js");
    const {
      getSessionFolderSources,
      __resetFolderSourceRuntimeForTest,
    } = await import("../folderSources/runtime.js");
    const sessionId = "folder-source-restore-no-flag";
    const root = mkdtempSync(join(tmpdir(), "qingagent-restore-no-flag-"));
    writeFileSync(join(root, "secret.md"), "ROUND9_VPS_SECRET");
    const source = folderSourceRecord(sessionId, root);
    threads.set(sessionId, storedThread(sessionId, metadata({
      folderSources: [source],
    })));

    const restored = await loadSessionFromThread(sessionId);
    const restoredSource = restored?.folderSources.get(source.id);
    const registrySources = getSessionFolderSources(sessionId);

    expect(restoredSource?.status).toBe("error");
    expect(restoredSource?.error).toContain("不支持本地文件夹资料库");
    expect(registrySources).toHaveLength(1);
    expect(registrySources[0]?.status).toBe("error");
    expect(registrySources.every((item) => item.status !== "connected")).toBe(true);

    rmSync(root, { recursive: true, force: true });
    __resetFolderSourceRuntimeForTest();
  });

  it("恢复时丢弃 sessionId 不匹配的 folderSource，且不注册到当前 session", async () => {
    process.env.QINGAGENT_RUNTIME = "desktop";
    process.env.QINGAGENT_ENABLE_LOCAL_FOLDER_SOURCES = "1";
    const { loadSessionFromThread } = await import("../bridge/threadPersistence.js");
    const {
      getSessionFolderSources,
      __resetFolderSourceRuntimeForTest,
    } = await import("../folderSources/runtime.js");
    const restoredSessionId = "folder-source-restore-current";
    const ownerSessionId = "folder-source-restore-owner";
    const root = mkdtempSync(join(tmpdir(), "qingagent-foreign-source-"));
    writeFileSync(join(root, "secret.md"), "FOREIGN_SESSION_SECRET");
    const foreignSource = folderSourceRecord(ownerSessionId, root);
    threads.set(restoredSessionId, storedThread(restoredSessionId, metadata({
      docId: restoredSessionId,
      folderSources: [foreignSource],
    })));

    const restored = await loadSessionFromThread(restoredSessionId);

    expect(restored?.folderSources.size).toBe(0);
    expect(getSessionFolderSources(restoredSessionId)).toEqual([]);
    rmSync(root, { recursive: true, force: true });
    __resetFolderSourceRuntimeForTest();
  });

  it("materials 非数组时降级为空，但合法 folderSources 仍能恢复", async () => {
    process.env.QINGAGENT_RUNTIME = "desktop";
    process.env.QINGAGENT_ENABLE_LOCAL_FOLDER_SOURCES = "1";
    const { loadSessionFromThread } = await import("../bridge/threadPersistence.js");
    const {
      getSessionFolderSources,
      __resetFolderSourceRuntimeForTest,
    } = await import("../folderSources/runtime.js");
    const sessionId = "restore-bad-materials";
    const root = mkdtempSync(join(tmpdir(), "qingagent-bad-materials-"));
    writeFileSync(join(root, "alive.md"), "folder still restores");
    const source = folderSourceRecord(sessionId, root);
    threads.set(sessionId, storedThread(sessionId, metadata({
      docId: sessionId,
      materials: { corrupt: true } as never,
      folderSources: [source],
    })));

    const restored = await loadSessionFromThread(sessionId);

    expect(restored?.materials.size).toBe(0);
    expect(restored?.folderSources.get(source.id)?.status).toBe("connected");
    expect(getSessionFolderSources(sessionId)).toHaveLength(1);
    rmSync(root, { recursive: true, force: true });
    __resetFolderSourceRuntimeForTest();
  });

  it("chatHistory 非数组或坏元素时降级，不阻断 folderSources 恢复", async () => {
    process.env.QINGAGENT_RUNTIME = "desktop";
    process.env.QINGAGENT_ENABLE_LOCAL_FOLDER_SOURCES = "1";
    const { loadSessionFromThread } = await import("../bridge/threadPersistence.js");
    const { __resetFolderSourceRuntimeForTest } = await import("../folderSources/runtime.js");
    const cases: Array<{ sessionId: string; chatHistory: unknown }> = [
      { sessionId: "restore-chat-history-non-array", chatHistory: "not-an-array" },
      {
        sessionId: "restore-chat-history-bad-elements",
        chatHistory: [
          null,
          { id: "bad-no-parts", role: { kind: "agent" }, ts: "2026-01-01T00:00:00.000Z" },
          {
            id: "bad-tool-status",
            role: { kind: "agent" },
            ts: "2026-01-01T00:00:00.000Z",
            parts: [{ kind: "toolCall", data: { id: "ask-1", name: "askUser" } }],
            chips: null,
          },
          {
            id: "bad-tool-body",
            role: { kind: "agent" },
            ts: "2026-01-01T00:00:00.000Z",
            parts: [{
              kind: "toolCall",
              data: { id: "ask-2", name: "askUser", status: { kind: "running" } },
            }],
            chips: null,
          },
          {
            id: "bad-tool-body-data",
            role: { kind: "agent" },
            ts: "2026-01-01T00:00:00.000Z",
            parts: [{
              kind: "toolCall",
              data: {
                id: "ask-3",
                name: "askUserQuestion",
                status: { kind: "running" },
                body: { kind: "askUser" },
              },
            }],
            chips: null,
          },
        ],
      },
    ];

    for (const testCase of cases) {
      const root = mkdtempSync(join(tmpdir(), `${testCase.sessionId}-`));
      writeFileSync(join(root, "alive.md"), "folder still restores");
      const source = folderSourceRecord(testCase.sessionId, root);
      threads.set(testCase.sessionId, storedThread(testCase.sessionId, metadata({
        docId: testCase.sessionId,
        chatHistory: testCase.chatHistory as never,
        folderSources: [source],
      })));

      const restored = await loadSessionFromThread(testCase.sessionId);

      expect(restored?.chatHistory).toEqual([]);
      expect(restored?.folderSources.get(source.id)?.status).toBe("connected");
      rmSync(root, { recursive: true, force: true });
      __resetFolderSourceRuntimeForTest();
    }
  });

  it("冷恢复保留所有合法 MessagePart 种类（code/citation/image/patchSummary 不被静默丢弃）", async () => {
    process.env.QINGAGENT_RUNTIME = "desktop";
    process.env.QINGAGENT_ENABLE_LOCAL_FOLDER_SOURCES = "1";
    const { loadSessionFromThread } = await import("../bridge/threadPersistence.js");
    const { __resetFolderSourceRuntimeForTest } = await import("../folderSources/runtime.js");
    const sessionId = "restore-chat-history-all-part-kinds";
    const parts = [
      { kind: "text", data: { body: "正文" } },
      { kind: "code", data: { lang: "ts", body: "const x = 1;" } },
      { kind: "citation", data: { id: "cite-1", url: "https://example.com", title: "来源" } },
      { kind: "image", data: { id: "img-1", url: "https://example.com/a.png", alt: "图" } },
      { kind: "patchSummary", data: { count: 2, hunkIds: ["h1", "h2"] } },
    ];
    const chatHistory = [
      { id: "msg-rich", role: { kind: "agent" }, ts: "2026-01-01T00:00:00.000Z", parts, chips: null },
    ];
    threads.set(sessionId, storedThread(sessionId, metadata({
      docId: sessionId,
      chatHistory: chatHistory as never,
    })));

    const restored = await loadSessionFromThread(sessionId);

    expect(restored?.chatHistory).toHaveLength(1);
    expect(restored?.chatHistory[0]?.parts.map((p) => p.kind)).toEqual([
      "text",
      "code",
      "citation",
      "image",
      "patchSummary",
    ]);
    __resetFolderSourceRuntimeForTest();
  });

  it("browser source 在后端能力关闭时冷恢复降级为非 connected，flag 开启时保持 connected", async () => {
    const { loadSessionFromThread } = await import("../bridge/threadPersistence.js");
    const {
      getSessionFolderSources,
      __resetFolderSourceRuntimeForTest,
    } = await import("../folderSources/runtime.js");
    const disabledSessionId = "browser-source-disabled";
    const disabledSource = browserFolderSourceRecord(disabledSessionId);
    threads.set(disabledSessionId, storedThread(disabledSessionId, metadata({
      docId: disabledSessionId,
      folderSources: [disabledSource],
    })));

    const disabledRestored = await loadSessionFromThread(disabledSessionId);

    expect(disabledRestored?.folderSources.get(disabledSource.id)?.status).toBe("error");
    expect(getSessionFolderSources(disabledSessionId)[0]?.status).toBe("error");
    __resetFolderSourceRuntimeForTest();

    process.env.QINGAGENT_ENABLE_BROWSER_FOLDER_SOURCES = "1";
    const enabledSessionId = "browser-source-enabled";
    const enabledSource = browserFolderSourceRecord(enabledSessionId);
    threads.set(enabledSessionId, storedThread(enabledSessionId, metadata({
      docId: enabledSessionId,
      folderSources: [enabledSource],
    })));

    const enabledRestored = await loadSessionFromThread(enabledSessionId);

    expect(enabledRestored?.folderSources.get(enabledSource.id)?.status).toBe("connected");
    expect(getSessionFolderSources(enabledSessionId)[0]?.status).toBe("connected");
    __resetFolderSourceRuntimeForTest();
  });

  it("deleteSessionThread 删除 thread 时同步注销 folder source registry", async () => {
    const {
      getSessionFolderSources,
      registerSessionFolderSources,
      __resetFolderSourceRuntimeForTest,
    } = await import("../folderSources/runtime.js");
    const { deleteSessionThread } = await import("../bridge/threadPersistence.js");
    const sessionId = "delete-folder-source-registry";
    const now = "2026-01-01T00:00:00.000Z";
    threads.set(sessionId, storedThread(sessionId, metadata()));
    registerSessionFolderSources(sessionId, [{
      id: "fld_delete_registry",
      sessionId,
      provider: "desktop-local",
      name: "Docs",
      pathLabel: ".../docs",
      mountName: "source_delete_registry",
      mountPath: "/sources/source_delete_registry",
      readOnly: true,
      fileCount: 1,
      fileCountCapped: false,
      status: "connected",
      error: null,
      createdAt: now,
      updatedAt: now,
      desktopRootPath: "/tmp/qingagent-delete-registry",
    }]);

    expect(getSessionFolderSources(sessionId)).toHaveLength(1);

    await deleteSessionThread(sessionId);

    expect(threads.has(sessionId)).toBe(false);
    expect(getSessionFolderSources(sessionId)).toEqual([]);
    __resetFolderSourceRuntimeForTest();
  });

  it("normalizes every incoming doc state to content 3-state restore facts", async () => {
    const { normalizeRestoredDocStateKind } = await import("../bridge/docStateTransitions.js");
    const kinds: IncomingDocState["kind"][] = [
      "init",
      "plan",
      "drafting",
      "locked",
      "draft",
      "review",
      "committed",
      "history",
      "empty",
      "editing",
      "pendingReview",
    ];

    for (const kind of kinds) {
      expect(normalizeRestoredDocStateKind({
        persistedKind: kind,
        hasDoc: true,
        hasReviewPatch: false,
        hasApplicableReviewPatch: false,
        hasOpenAskUserToolCall: false,
        hasRestorableSuspension: false,
      })).toBe("editing");
      expect(normalizeRestoredDocStateKind({
        persistedKind: kind,
        hasDoc: false,
        hasReviewPatch: false,
        hasApplicableReviewPatch: false,
        hasOpenAskUserToolCall: false,
        hasRestorableSuspension: false,
      })).toBe("empty");
    }
  });

  it("summarizes documents with the legacy word-count semantics", async () => {
    const { createSession } = await import("../bridge/sessionState.js");
    const { summarizeDoc } = await import("../bridge/threadPersistence.js");
    const state = createSession("session-summary");
    state.docState = { kind: "editing" };
    state.legacySections = [
      textSection("abcd"),
      { kind: "code", data: { body: "123456" } },
      {
        kind: "image",
        data: {
          src: "/api/v1/files/22222222-2222-4222-8222-222222222222/a.png",
          alt: "alt text",
          caption: "caption",
          width: null,
          height: null,
        },
      },
    ];
    state.doc = legacySectionsToPm(state.legacySections as never);
    state.materials.set("material-1", {
      id: "material-1",
      filename: "source.txt",
      mimeType: "text/plain",
      text: "素材正文",
      summary: null,
      fileId: null,
      metadata: { pages: null, wordCount: 4, title: null },
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });

    expect(summarizeDoc(state)).toEqual({
      sectionCount: 3,
      wordCount: Math.round((4 + 6 + 7) / 1.5),
      status: "editing",
      materialCount: 1,
    });

    const empty = createSession("session-empty-summary");
    expect(summarizeDoc(empty)).toMatchObject({
      sectionCount: 0,
      wordCount: 0,
      status: "empty",
    });

    const review = createSession("session-review-summary");
    review.docState = { kind: "pendingReview" };
    review.legacySections = [textSection("正文")];
    review.doc = legacySectionsToPm(review.legacySections as never);
    addSuggestion(review);
    expect(summarizeDoc(review).status).toBe("pendingReview");

    const staleReview = createSession("session-stale-review-summary");
    staleReview.docState = { kind: "pendingReview" };
    staleReview.legacySections = [textSection("正文")];
    staleReview.doc = legacySectionsToPm(staleReview.legacySections as never);
    expect(summarizeDoc(staleReview).status).toBe("editing");
  });

  it("round-trips full persisted SessionState fields except runtime-only owners", async () => {
    const { createSession } = await import("../bridge/sessionState.js");
    const { loadSessionFromThread, persistSessionMetadata } = await import(
      "../bridge/threadPersistence.js"
    );
    const state = createSession("session-full");
    const message: CoreMessage = { role: "user", content: "请写一段正文" };
    state.docId = "doc-full";
    state.threadId = "session-full";
    state.title = "完整状态";
    state.docState = { kind: "pendingReview" };
    state.messages = [message];
    state.legacySections = [textSection("第一段"), textSection("第二段")];
    state.doc = legacySectionsToPm(state.legacySections as never);
    state.docVersion = 3;
    addSuggestion(state);
    state.patchVerdicts.set("patch-1", "accepted");
    state.materials.set("material-1", {
      id: "material-1",
      filename: "source.txt",
      mimeType: "text/plain",
      text: "素材正文",
      summary: "素材摘要",
      visionSummary: "图像识别摘要",
      fileId: "file-1",
      metadata: { pages: null, wordCount: 4, title: "素材", parseState: "ready" },
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    state.lastSyncedDocumentSnapshot = 2;
    state.selectedSkills = ["writer"];
    state.selectedSkillsHadSelection = true;
    state.turnCounter = 7;
    state.omSidecarCursor = { turnIndex: 6, seqInTurn: 2 };
    state.omObservedMessageIds = ["session-full-1-1", "session-full-1-2"];
    state.omCompressionActive = true;
    state.omCompressionEpoch = 2;
    state.omCompressionSnapshot = {
      epoch: 2,
      observations: "- 冷恢复稳定观察块",
      removedMessageIds: ["session-full-1-1", "session-full-1-2"],
    };
    state.branchTitleGenerated = true;
    state._askUserCompleted = true;
    state._directionChangeAskedSinceLastWrite = true;
    state.chatHistory = [chatMessage("chat-1")];

    await persistSessionMetadata(state);
    const restored = await loadSessionFromThread(state.sessionId);

    expectRestoredStableFields(restored, state);
  });

  it("恢复仲裁场景1: documents 无行时继续使用 metadata", async () => {
    const { loadSessionFromThread } = await import("../bridge/threadPersistence.js");
    const sessionId = "restore-arb-metadata-only";
    threads.set(sessionId, storedThread(sessionId, metadata({
      docId: sessionId,
      docVersion: 2,
      doc: pmDoc("metadata only"),
      legacySections: [textSection("metadata only")],
    })));

    const restored = await loadSessionFromThread(sessionId);

    expectRestoredText(restored, "metadata only");
    expect(restored?.docVersion).toBe(2);
    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
    expect(spans).toHaveLength(0);
    expect(await listVersions(sessionId)).toHaveLength(0);
  });

  it("恢复仲裁场景2: documents 版本高于 metadata 时使用 documents 并触发 reconcile persist", async () => {
    const { loadSessionFromThread, drainSessionPersistence } = await import("../bridge/threadPersistence.js");
    const sessionId = "restore-arb-documents-newer";
    threads.set(sessionId, storedThread(sessionId, metadata({
      docId: sessionId,
      docVersion: 1,
      doc: pmDoc("metadata old"),
      legacySections: [textSection("metadata old")],
    })));
    await saveDocumentRow({ docId: sessionId, sessionId, text: "documents new", docVersion: 2 });
    vi.clearAllMocks();

    const restored = await loadSessionFromThread(sessionId);
    await drainSessionPersistence();

    expectRestoredText(restored, "documents new");
    expect(restored?.docVersion).toBe(2);
    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
    expect(spans.at(-1)?.output).toMatchObject({ output: { resolution: "documents" } });
    expect(memory.updateThread).toHaveBeenCalled();
    expect(await listVersions(sessionId)).toHaveLength(0);
  });

  it("恢复仲裁场景2: metadata.doc 为空时视为 documents 胜出", async () => {
    const { loadSessionFromThread, drainSessionPersistence } = await import("../bridge/threadPersistence.js");
    const sessionId = "restore-arb-metadata-empty-doc";
    threads.set(sessionId, storedThread(sessionId, metadata({
      docId: sessionId,
      docVersion: 3,
      doc: undefined,
      legacySections: [textSection("metadata legacy")],
    })));
    await saveDocumentRow({ docId: sessionId, sessionId, text: "documents authoritative", docVersion: 3 });
    vi.clearAllMocks();

    const restored = await loadSessionFromThread(sessionId);
    await drainSessionPersistence();

    expectRestoredText(restored, "documents authoritative");
    expect(restored?.docVersion).toBe(3);
    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
    expect(memory.updateThread).not.toHaveBeenCalled();
    expect(await listVersions(sessionId)).toHaveLength(0);
  });

  it("恢复仲裁场景3: metadata 版本高于 documents 时使用 metadata 并触发 reconcile persist", async () => {
    const { loadSessionFromThread, drainSessionPersistence } = await import("../bridge/threadPersistence.js");
    const sessionId = "restore-arb-metadata-newer";
    threads.set(sessionId, storedThread(sessionId, metadata({
      docId: sessionId,
      docVersion: 3,
      doc: pmDoc("metadata new"),
      legacySections: [textSection("metadata new")],
    })));
    await saveDocumentRow({ docId: sessionId, sessionId, text: "documents old", docVersion: 2 });
    vi.clearAllMocks();

    const restored = await loadSessionFromThread(sessionId);
    await drainSessionPersistence();

    expectRestoredText(restored, "metadata new");
    expect(restored?.docVersion).toBe(3);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("metadata doc_version is newer"),
      expect.objectContaining({ sessionId, docId: sessionId, metadataDocVersion: 3, documentsDocVersion: 2 }),
    );
    expect(logger.error).not.toHaveBeenCalled();
    expect(spans.at(-1)?.output).toMatchObject({ output: { resolution: "metadata" } });
    expect(memory.updateThread).toHaveBeenCalled();
    expect(await listVersions(sessionId)).toHaveLength(0);
  });

  it("恢复仲裁场景4: 同版本同 hash 时使用 documents 且不触发 reconcile", async () => {
    const { loadSessionFromThread, drainSessionPersistence } = await import("../bridge/threadPersistence.js");
    const sessionId = "restore-arb-same-hash";
    threads.set(sessionId, storedThread(sessionId, metadata({
      docId: sessionId,
      docVersion: 4,
      doc: pmDoc("same body"),
      legacySections: [textSection("same body")],
    })));
    await saveDocumentRow({ docId: sessionId, sessionId, text: "same body", docVersion: 4 });
    vi.clearAllMocks();

    const restored = await loadSessionFromThread(sessionId);
    await drainSessionPersistence();

    expectRestoredText(restored, "same body");
    expect(restored?.docVersion).toBe(4);
    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
    expect(spans).toHaveLength(0);
    expect(memory.updateThread).not.toHaveBeenCalled();
    expect(await listVersions(sessionId)).toHaveLength(0);
  });

  it("恢复仲裁场景5: 同版本异 hash 时 documents 胜出并救援 metadata 快照", async () => {
    const { loadSessionFromThread, drainSessionPersistence } = await import("../bridge/threadPersistence.js");
    const sessionId = "restore-arb-hash-conflict";
    const metadataDoc = pmDoc("metadata loser");
    threads.set(sessionId, storedThread(sessionId, metadata({
      docId: sessionId,
      docVersion: 5,
      doc: metadataDoc,
      legacySections: [textSection("metadata loser")],
    })));
    await saveDocumentRow({ docId: sessionId, sessionId, text: "documents winner", docVersion: 5 });
    const winnerDoc = pmDoc("documents winner");
    await insertVersion({
      versionId: `winner-${sessionId}-5`,
      docId: sessionId,
      docVersion: 5,
      contentHash: getPmContentHash(winnerDoc),
      schemaVersion: winnerDoc.attrs.schemaVersion,
      actorType: "agent",
      summary: "获胜方正常版本",
      snapshotPm: winnerDoc,
      parentVersion: 4,
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    vi.clearAllMocks();

    const restored = await loadSessionFromThread(sessionId);
    await drainSessionPersistence();
    const versions = await listVersions(sessionId);

    expectRestoredText(restored, "documents winner");
    expect(restored?.docVersion).toBe(5);
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining("same-version content hash conflict"),
      expect.objectContaining({ sessionId, docId: sessionId, docVersion: 5 }),
    );
    expect(logger.warn).not.toHaveBeenCalled();
    expect(spans.at(-1)?.output).toMatchObject({ output: { resolution: "conflict-rescue" } });
    expect(memory.updateThread).toHaveBeenCalled();
    expect(versions).toHaveLength(2);
    expect(versions[0]).toMatchObject({
      versionId: `winner-${sessionId}-5`,
      docId: sessionId,
      docVersion: 5,
      actorType: "agent",
      snapshotPm: winnerDoc,
    });
    expect(versions[1]).toMatchObject({
      versionId: `rescue-${sessionId}-5-${getPmContentHash(metadataDoc).slice(0, 8)}`,
      docId: sessionId,
      docVersion: -1,
      actorType: "restore-rescue",
      summary: "恢复冲突败方快照",
    });
    expect(versions[1]?.snapshotPm).toEqual(metadataDoc);
  });

  it("恢复仲裁场景5救援幂等: 连续恢复两次只保留一条 rescue 版本", async () => {
    const { loadSessionFromThread, drainSessionPersistence } = await import("../bridge/threadPersistence.js");
    const sessionId = "restore-arb-hash-conflict-idempotent";
    const metadataDoc = pmDoc("metadata loser twice");
    threads.set(sessionId, storedThread(sessionId, metadata({
      docId: sessionId,
      docVersion: 6,
      doc: metadataDoc,
      legacySections: [textSection("metadata loser twice")],
    })));
    await saveDocumentRow({ docId: sessionId, sessionId, text: "documents winner twice", docVersion: 6 });
    vi.clearAllMocks();

    const first = await loadSessionFromThread(sessionId);
    await drainSessionPersistence();
    threads.set(sessionId, storedThread(sessionId, metadata({
      docId: sessionId,
      docVersion: 6,
      doc: metadataDoc,
      legacySections: [textSection("metadata loser twice")],
    })));
    const second = await loadSessionFromThread(sessionId);
    await drainSessionPersistence();
    const versions = await listVersions(sessionId);

    expectRestoredText(first, "documents winner twice");
    expectRestoredText(second, "documents winner twice");
    expect(versions).toHaveLength(1);
    expect(versions[0]?.versionId).toBe(`rescue-${sessionId}-6-${getPmContentHash(metadataDoc).slice(0, 8)}`);
    expect(versions[0]?.docVersion).toBe(-1);
  });

  it("documents 读取失败时仍 fallback metadata", async () => {
    const { loadSessionFromThread, drainSessionPersistence } = await import("../bridge/threadPersistence.js");
    const sessionId = "restore-documents-read-error-fallback";
    threads.set(sessionId, storedThread(sessionId, metadata({
      docId: sessionId,
      docVersion: 7,
      doc: pmDoc("metadata fallback"),
      legacySections: [textSection("metadata fallback")],
    })));
    vi.spyOn(documentRepo, "load").mockRejectedValueOnce(new Error("documents unavailable"));

    const restored = await loadSessionFromThread(sessionId);
    await drainSessionPersistence();

    expectRestoredText(restored, "metadata fallback");
    expect(restored?.docVersion).toBe(7);
    expect(logger.warn).toHaveBeenCalledWith(
      "Failed to read documents table during session restore; falling back to metadata",
      expect.objectContaining({ sessionId, docId: sessionId, error: "documents unavailable" }),
    );
    expect(logger.error).not.toHaveBeenCalled();
    expect(memory.updateThread).not.toHaveBeenCalled();
    expect(await listVersions(sessionId)).toHaveLength(0);
  });

  it("does not persist OM metadata defaults when sidecar state is inactive", async () => {
    const { createSession } = await import("../bridge/sessionState.js");
    const { persistSessionMetadata } = await import("../bridge/threadPersistence.js");
    const state = createSession("session-om-defaults");
    state.threadId = state.sessionId;

    await persistSessionMetadata(state);

    const persisted = threads.get(state.sessionId)?.metadata as Record<string, unknown> | undefined;
    expect(persisted).toBeTruthy();
    expect(persisted).not.toHaveProperty("turnCounter");
    expect(persisted).not.toHaveProperty("omSidecarCursor");
    expect(persisted).not.toHaveProperty("omObservedMessageIds");
    expect(persisted).not.toHaveProperty("omCompressionActive");
    expect(persisted).not.toHaveProperty("omCompressionEpoch");
    expect(persisted).not.toHaveProperty("omCompressionSnapshot");
    expect(persisted).not.toHaveProperty("branchTitleGenerated");
  });

  it("restores old material metadata without parseState as ready", async () => {
    const { loadSessionFromThread } = await import("../bridge/threadPersistence.js");
    const sessionId = "material-parse-state-default";
    threads.set(sessionId, storedThread(sessionId, metadata({
      materials: [{
        id: "material-old",
        filename: "old.pdf",
        mimeType: "application/pdf",
        text: "旧素材正文",
        summary: null,
        fileId: "file-old",
        metadata: { pages: 1, wordCount: 5, title: null },
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      }],
    })));

    const restored = await loadSessionFromThread(sessionId);

    expect(restored?.materials.get("material-old")?.metadata.parseState).toBe("ready");
  });

  it("restores material visionSummary and ignores invalid visionSummary", async () => {
    const { loadSessionFromThread } = await import("../bridge/threadPersistence.js");
    const sessionId = "material-vision-summary";
    threads.set(sessionId, storedThread(sessionId, metadata({
      materials: [
        {
          id: "material-image",
          filename: "photo.png",
          mimeType: "image/png",
          text: "图片素材正文",
          summary: null,
          visionSummary: "图中是一张手写便签。",
          fileId: "file-image",
          metadata: { pages: null, wordCount: 6, title: null },
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
        {
          id: "material-invalid-vision",
          filename: "bad.png",
          mimeType: "image/png",
          text: "坏字段素材正文",
          summary: null,
          visionSummary: 123,
          fileId: "file-bad",
          metadata: { pages: null, wordCount: 6, title: null },
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ] as never,
    })));

    const restored = await loadSessionFromThread(sessionId);

    expect(restored?.materials.get("material-image")?.visionSummary).toBe("图中是一张手写便签。");
    expect(restored?.materials.get("material-invalid-vision")).toBeTruthy();
    expect(restored?.materials.get("material-invalid-vision")?.visionSummary).toBeUndefined();
  });

  it("round-trips material parse error metadata", async () => {
    const { createSession } = await import("../bridge/sessionState.js");
    const { loadSessionFromThread, persistSessionMetadata } = await import(
      "../bridge/threadPersistence.js"
    );
    const state = createSession("material-parse-state-error");
    state.title = "解析失败素材";
    state.materials.set("material-error", {
      id: "material-error",
      filename: "broken.pdf",
      mimeType: "application/pdf",
      text: "",
      summary: null,
      fileId: "file-error",
      metadata: {
        pages: null,
        wordCount: 0,
        title: null,
        parseState: "error",
        parseError: "PDF 文件损坏，无法解析",
      },
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });

    await persistSessionMetadata(state);
    const restored = await loadSessionFromThread(state.sessionId);

    expect(restored?.materials.get("material-error")?.metadata).toMatchObject({
      parseState: "error",
      parseError: "PDF 文件损坏，无法解析",
    });
  });

  it("restore 优先 exact meta.messages，recall 脏文本不改模型上下文字节", async () => {
    const { loadSessionFromThread } = await import("../bridge/threadPersistence.js");
    const sessionId = "restore-exact-meta-messages";
    const exactMessages: CoreMessage[] = [
      { role: "user", content: "请写一篇文章" },
      { role: "assistant", content: "我会继续。" },
      { role: "user", content: "[askUserAnswers:ask-1]\n问题：方向\n回答：答案A" },
    ];
    const exactBytes = JSON.stringify(exactMessages);
    memory.recall.mockResolvedValueOnce({
      messages: [
        {
          id: "recall-1",
          role: "user",
          content:
            "──── 当前文档（版本 9）────\n[1] 被清洗后的快照\n\n服务器系统时间：2026-01-01T00:00:00.000Z",
          createdAt: new Date("2026-01-01T00:00:00.000Z"),
        },
      ],
    } as any);
    threads.set(sessionId, storedThread(sessionId, metadata({
      messages: exactMessages,
    })));

    const restored = await loadSessionFromThread(sessionId);

    expect(memory.recall).not.toHaveBeenCalled();
    expect(JSON.stringify(restored?.messages)).toBe(exactBytes);
    expect(restored?.messages).toEqual(exactMessages);
    expect(JSON.stringify(restored?.messages)).not.toContain("当前文档");
    expect(JSON.stringify(restored?.messages)).not.toContain("服务器系统时间");
  });

  it("restore 遇到空 meta.messages 时按旧会话走 recall 兜底", async () => {
    const { loadSessionFromThread } = await import("../bridge/threadPersistence.js");
    const sessionId = "restore-empty-meta-messages";
    memory.recall.mockResolvedValueOnce({
      messages: [
        {
          id: "recall-user-1",
          role: "user",
          content: "旧会话上下文",
          createdAt: new Date("2026-01-01T00:00:00.000Z"),
        },
      ],
    } as any);
    threads.set(sessionId, storedThread(sessionId, metadata({
      messages: [],
    })));

    const restored = await loadSessionFromThread(sessionId);

    expect(memory.recall).toHaveBeenCalledWith({
      threadId: sessionId,
      perPage: false,
    });
    expect(restored?.messages).toEqual([
      {
        role: "user",
        content: "旧会话上下文",
        id: "recall-user-1",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ]);
  });

  it("normalizes legacy cold-restored docState from document presence", async () => {
    const { loadSessionFromThread } = await import("../bridge/threadPersistence.js");
    const cases: Array<{
      id: string;
      kind: IncomingDocState["kind"];
      sections: LegacySection[];
      expected: DocState["kind"];
    }> = [
      { id: "legacy-init-body", kind: "init", sections: [textSection("正文")], expected: "editing" },
      { id: "legacy-draft-empty", kind: "draft", sections: [], expected: "empty" },
      { id: "legacy-plan-body", kind: "plan", sections: [textSection("正文")], expected: "editing" },
      { id: "legacy-drafting-empty", kind: "drafting", sections: [], expected: "empty" },
      { id: "legacy-locked-empty", kind: "locked", sections: [], expected: "empty" },
      { id: "legacy-committed-body", kind: "committed", sections: [textSection("正文")], expected: "editing" },
      { id: "legacy-history-empty", kind: "history", sections: [], expected: "empty" },
    ];

    for (const testCase of cases) {
      threads.set(testCase.id, storedThread(testCase.id, metadata({
        docState: legacyDocState(testCase.kind),
        legacySections: testCase.sections,
      })));

      const restored = await loadSessionFromThread(testCase.id);

      expect(restored?.docState).toEqual({ kind: testCase.expected });
    }
  });

  it("restores review only when persisted review has document and suggestions", async () => {
    const { loadSessionFromThread } = await import("../bridge/threadPersistence.js");
    threads.set("review-good", storedThread("review-good", metadata({
      docState: legacyDocState("review"),
      suggestions: [suggestionRecord()],
      legacySections: [textSection("正文")],
    })));
    threads.set("review-no-patch", storedThread("review-no-patch", metadata({
      docState: legacyDocState("review"),
      suggestions: [],
      legacySections: [textSection("正文")],
    })));
    threads.set("review-no-doc", storedThread("review-no-doc", metadata({
      docState: legacyDocState("review"),
      suggestions: [suggestionRecord()],
      legacySections: [],
    })));

    expect((await loadSessionFromThread("review-good"))?.docState).toEqual({ kind: "pendingReview" });
    expect((await loadSessionFromThread("review-no-patch"))?.docState).toEqual({ kind: "editing" });
    expect((await loadSessionFromThread("review-no-doc"))?.docState).toEqual({ kind: "empty" });
  });

  it.each(["askUser", "planDraft", "askUserQuestion"] as const)(
    "keeps restorable open %s on cold restore with durable suspension owner",
    async (toolName) => {
    const { hasActiveSuspension } = await import("../bridge/sessionState.js");
    const { loadSessionFromThread } = await import("../bridge/threadPersistence.js");
    const askUser = toolCall(
      toolName,
      { kind: "running", data: { progressPct: null, etaSec: null } },
      "ask-1",
    );
    threads.set("askuser-durable", storedThread("askuser-durable", metadata({
      docState: legacyDocState("plan"),
      legacySections: [],
      runId: "run-ask",
      toolCallId: "ask-1",
      chatHistory: [toolMessage(askUser)],
    })));

    const restored = await loadSessionFromThread("askuser-durable");
    const restoredTool = restored?.chatHistory[0]?.parts[0];

    expect(restored?.docState).toEqual({ kind: "empty" });
    expect(restored?.runId).toBe("run-ask");
    expect(restored?.toolCallId).toBe("ask-1");
    expect(restored?._suspensionOwner).toEqual({
      streamId: "restored:run-ask",
      runId: "run-ask",
      toolCallId: "ask-1",
      toolName,
    });
    expect(restored ? hasActiveSuspension(restored) : false).toBe(true);
    expect(restoredTool?.kind).toBe("toolCall");
    if (restoredTool?.kind === "toolCall") {
      expect(restoredTool.data.status).toEqual({
        kind: "running",
        data: { progressPct: null, etaSec: null },
      });
    }
    },
  );

  it("冷恢复把三种问卷工具的缺失/空/非法 mode 统一降级 fullpage", async () => {
    const { loadSessionFromThread } = await import("../bridge/threadPersistence.js");
    const dirtyModes: Array<{ label: string; value: unknown }> = [
      { label: "missing", value: undefined },
      { label: "null", value: null },
      { label: "empty", value: {} },
      { label: "invalid", value: { kind: "invalid" } },
    ];
    for (const toolName of ["askUser", "planDraft", "askUserQuestion"] as const) {
      for (const dirtyMode of dirtyModes) {
        const sessionId = `cold-dirty-mode-${toolName}-${dirtyMode.label}`;
        const spec = toolCall(toolName, { kind: "done" }, `${sessionId}-tool`);
        if (spec.body.kind !== "askUser") throw new Error("expected questionnaire body");
        if (dirtyMode.value === undefined) {
          delete (spec.body.data as unknown as { mode?: unknown }).mode;
        } else {
          (spec.body.data as unknown as { mode?: unknown }).mode = dirtyMode.value;
        }
        threads.set(sessionId, storedThread(sessionId, metadata({
          chatHistory: [toolMessage(spec)],
        })));

        const restored = await loadSessionFromThread(sessionId);
        const part = restored?.chatHistory[0]?.parts[0];
        expect(part?.kind).toBe("toolCall");
        if (part?.kind !== "toolCall") continue;
        expect(part.data.render).toEqual({ kind: "rightForm" });
        expect(part.data.body).toMatchObject({
          kind: "askUser",
          data: { mode: { kind: "fullpage" } },
        });
      }
    }
  });

  it("terminalizes stale open askUser without persisted runId on cold restore", async () => {
    const { loadSessionFromThread } = await import("../bridge/threadPersistence.js");
    const askUser = toolCall(
      "askUser",
      { kind: "running", data: { progressPct: null, etaSec: null } },
      "ask-1",
    );
    threads.set("askuser-stale", storedThread("askuser-stale", metadata({
      docState: legacyDocState("plan"),
      legacySections: [],
      chatHistory: [toolMessage(askUser)],
    })));

    const restored = await loadSessionFromThread("askuser-stale");
    const restoredTool = restored?.chatHistory[0]?.parts[0];

    expect(restored?.docState).toEqual({ kind: "empty" });
    expect(restoredTool?.kind).toBe("toolCall");
    if (restoredTool?.kind === "toolCall") {
      expect(restoredTool.data.status).toEqual({
        kind: "failed",
        data: { retriable: false, reason: "上次的确认已结束，请重新发起。" },
      });
    }
  });

  it("cold restore uses submitted askUser toolCallId to recover stale persisted suspension id", async () => {
    const { loadSessionFromThread } = await import("../bridge/threadPersistence.js");
    const { hasActiveSuspension } = await import("../bridge/sessionState.js");
    const askUser = toolCall(
      "askUser",
      { kind: "running", data: { progressPct: null, etaSec: null } },
      "ask-real",
    );
    threads.set("askuser-preferred", storedThread("askuser-preferred", metadata({
      docState: legacyDocState("plan"),
      legacySections: [],
      runId: "run-ask",
      toolCallId: "ask-stale",
      chatHistory: [toolMessage(askUser)],
    })));

    const restored = await loadSessionFromThread("askuser-preferred", {
      preferredAskUserToolCallId: "ask-real",
    });
    const restoredTool = restored?.chatHistory[0]?.parts[0];

    expect(restored?.runId).toBe("run-ask");
    expect(restored?.toolCallId).toBe("ask-real");
    expect(restored?._suspensionOwner).toEqual({
      streamId: "restored:run-ask",
      runId: "run-ask",
      toolCallId: "ask-real",
      toolName: "askUser",
    });
    expect(restored ? hasActiveSuspension(restored) : false).toBe(true);
    expect(restoredTool?.kind).toBe("toolCall");
    if (restoredTool?.kind === "toolCall") {
      expect(restoredTool.data.status).toEqual({
        kind: "running",
        data: { progressPct: null, etaSec: null },
      });
    }
  });

  it("从旧 chatHistory 的 askUserAnswers 尾部补建答案 user message 且只补一次", async () => {
    const {
      buildAskUserAnswerUserMessage,
      visibleAskUserAnswerMessageId,
    } = await import("../bridge/askUserAnswerMessage.js");
    const {
      drainSessionPersistence,
      loadSessionFromThread,
    } = await import("../bridge/threadPersistence.js");
    const answers = {
      "q-one": { chosen: [], freeText: "答案A" },
    };
    const askUser: ToolCallSpec = {
      ...toolCall("askUser", { kind: "done" }, "ask-legacy-answers"),
      result: { kind: "askUserAnswers", data: answers },
    };
    const prefixMessages: CoreMessage[] = [
      { role: "user", content: "帮我写一篇文章" },
      { role: "assistant", content: "我会先确认写作方向。" },
    ];
    threads.set("askuser-legacy-answers", storedThread("askuser-legacy-answers", metadata({
      messages: prefixMessages,
      chatHistory: [toolMessage(askUser)],
    })));

    const expectedMessage = buildAskUserAnswerUserMessage({
      toolCallId: "ask-legacy-answers",
      spec: askUser,
      answers,
    });
    const restored = await loadSessionFromThread("askuser-legacy-answers");

    expect(restored?.messages.slice(0, prefixMessages.length)).toEqual(prefixMessages);
    expect(restored?.messages.at(-1)).toEqual(expectedMessage);
    // P2 回归(用户走查):fullpage 开场问卷提交后,工具调用置 done 已渲染「已提交答案」
    // 汇总卡,不再额外补建可见答卷卡「已提交写作方向问卷」,避免对话里出现两层等价内容。
    // 面向模型上下文的答案 marker message 仍照常补建(下方 markerCount 断言)。
    const visibleCardId = visibleAskUserAnswerMessageId("ask-legacy-answers");
    const visibleCard = restored?.chatHistory.find((message) => message.id === visibleCardId);
    expect(visibleCard).toBeUndefined();

    await drainSessionPersistence();
    const persistedMeta = threads.get("askuser-legacy-answers")?.metadata as
      | QingagentThreadMetadata
      | undefined;
    expect(persistedMeta?.messages).toEqual(restored?.messages);
    expect(persistedMeta?.chatHistory?.some((message) => message.id === visibleCardId)).toBe(false);

    memory.updateThread.mockClear();
    const restoredAgain = await loadSessionFromThread("askuser-legacy-answers");
    await drainSessionPersistence();
    const marker = "[askUserAnswers:ask-legacy-answers]";
    const markerCount = restoredAgain?.messages.filter((message) =>
      typeof message.content === "string" && message.content.startsWith(marker)
    ).length;
    const visibleCardCount = restoredAgain?.chatHistory.filter((message) =>
      message.id === visibleCardId
    ).length;

    expect(markerCount).toBe(1);
    expect(visibleCardCount).toBe(0);
    expect(memory.updateThread).not.toHaveBeenCalled();
  });

  it("overlay 内联反问的 askUserAnswers 仍补建可见答卷卡(inline 无汇总卡,需保留)", async () => {
    const { visibleAskUserAnswerMessageId } = await import(
      "../bridge/askUserAnswerMessage.js"
    );
    const { loadSessionFromThread } = await import("../bridge/threadPersistence.js");
    const answers = {
      "q-one": { chosen: [], freeText: "内联答案" },
    };
    const baseAskUser = toolCall("askUser", { kind: "done" }, "ask-overlay-answers");
    if (baseAskUser.body.kind !== "askUser") throw new Error("expect askUser body");
    // overlay 模式(写作中途澄清):没有 fullpage 汇总卡,可见答卷卡是答案的唯一展示位。
    const overlayAskUser: ToolCallSpec = {
      ...baseAskUser,
      body: {
        kind: "askUser",
        data: { ...baseAskUser.body.data, mode: { kind: "overlay" } },
      },
      result: { kind: "askUserAnswers", data: answers },
    };
    threads.set("askuser-overlay-answers", storedThread("askuser-overlay-answers", metadata({
      messages: [{ role: "user", content: "帮我写一篇文章" }],
      chatHistory: [toolMessage(overlayAskUser)],
    })));

    const restored = await loadSessionFromThread("askuser-overlay-answers");
    const visibleCardId = visibleAskUserAnswerMessageId("ask-overlay-answers");
    const visibleCard = restored?.chatHistory.find((message) => message.id === visibleCardId);
    expect(visibleCard?.parts[0]).toMatchObject({
      kind: "askUserAnswerCard",
      data: {
        toolCallId: "ask-overlay-answers",
        items: [{ questionId: "q-one", answerText: "内联答案" }],
      },
    });
  });

  it("writes docId into initial thread metadata", async () => {
    const { createSessionThread } = await import("../bridge/threadPersistence.js");

    await createSessionThread("session-initial", "初始线程");

    const thread = threads.get("session-initial");
    const meta = thread?.metadata as QingagentThreadMetadata | undefined;
    expect(meta?.docId).toBe("session-initial");
  });

  it("新建 SessionState 与 thread 的内容时间严格同源", async () => {
    const { createSession } = await import("../bridge/sessionState.js");
    const { createSessionThread } = await import("../bridge/threadPersistence.js");
    const createdAt = "2026-02-03T04:05:06.789Z";
    const state = createSession("session-shared-created-at", createdAt);

    await createSessionThread("session-shared-created-at", "同源", { createdAt });

    const thread = threads.get("session-shared-created-at");
    const meta = thread?.metadata as QingagentThreadMetadata | undefined;
    expect(state.lastContentEditedAt).toBe(createdAt);
    expect(meta?.lastContentEditedAt).toBe(createdAt);
    expect((thread?.createdAt as Date).toISOString()).toBe(createdAt);
  });

  it("keeps persisted threadSummary populated for home listing", async () => {
    const { createSession } = await import("../bridge/sessionState.js");
    const { listSessionThreads, persistSessionMetadata } = await import(
      "../bridge/threadPersistence.js"
    );
    const state = createSession("session-home-summary");
    state.title = "首页摘要";
    state.docState = { kind: "editing" };
    state.legacySections = [textSection("第一段"), textSection("第二段")];
    state.doc = legacySectionsToPm(state.legacySections as never);
    state.materials.set("material-1", {
      id: "material-1",
      filename: "source.txt",
      mimeType: "text/plain",
      text: "素材正文",
      summary: null,
      fileId: null,
      metadata: { pages: null, wordCount: 4, title: null },
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });

    await persistSessionMetadata(state);
    const listed = await listSessionThreads();
    const meta = listed.threads[0]?.metadata as QingagentThreadMetadata | undefined;

    expect(meta?.threadSummary).toEqual({
      sectionCount: 2,
      wordCount: Math.round("第一段第二段".length / 1.5),
      status: "editing",
      materialCount: 1,
    });
  });

  it("首页查询全量排序后分页，≥51 条时不会漏掉 raw updatedAt 前 50 外的内容第一名", async () => {
    const { listHomeSessionThreads } = await import("../bridge/threadPersistence.js");
    const base = Date.parse("2026-01-01T00:00:00.000Z");
    const all = Array.from({ length: 60 }, (_, index) => ({
      id: `bulk-${String(index).padStart(2, "0")}`,
      title: `bulk-${index}`,
      resourceId: "qingagent-user",
      createdAt: new Date(base + index),
      updatedAt: new Date(base + (60 - index) * 1_000),
      metadata: {
        lastContentEditedAt: index === 59
          ? "2027-01-01T00:00:00.000Z"
          : "2025-01-01T00:00:00.000Z",
      },
    }));
    memory.listThreads
      .mockResolvedValueOnce({ threads: all, total: all.length, hasMore: false })
      .mockResolvedValueOnce({ threads: [], total: 0, hasMore: false });

    const result = await listHomeSessionThreads({ page: 0, perPage: 50 });

    expect(memory.listThreads).toHaveBeenNthCalledWith(1, expect.objectContaining({
      page: 0,
      perPage: false,
    }));
    expect(result.threads).toHaveLength(50);
    expect(result.threads[0]?.id).toBe("bulk-59");
    expect(result.total).toBe(60);
    expect(result.hasMore).toBe(true);
  });

  it("首页查询 current 优先去重，并用统一有效时间与稳定 tie-break", async () => {
    const { listHomeSessionThreads } = await import("../bridge/threadPersistence.js");
    const sharedCreatedAt = new Date("2026-01-01T00:00:00.000Z");
    const currentDuplicate = {
      id: "same-id",
      title: "current",
      resourceId: "qingagent-user",
      createdAt: sharedCreatedAt,
      updatedAt: new Date("2026-02-01T00:00:00.000Z"),
      metadata: { lastContentEditedAt: "not-a-date", source: "current" },
    };
    const legacyDuplicate = {
      ...currentDuplicate,
      title: "legacy",
      resourceId: "user-default",
      updatedAt: new Date("2028-01-01T00:00:00.000Z"),
      metadata: { lastContentEditedAt: "2029-01-01T00:00:00.000Z", source: "legacy" },
    };
    const tieB = {
      id: "b-id",
      title: "b",
      resourceId: "qingagent-user",
      createdAt: new Date("invalid"),
      updatedAt: new Date("invalid"),
      metadata: { lastContentEditedAt: null },
    };
    const tieA = { ...tieB, id: "a-id", title: "a" };
    const newerCreated = {
      ...tieB,
      id: "newer-created",
      title: "newer",
      createdAt: new Date("2026-03-01T00:00:00.000Z"),
      metadata: { lastContentEditedAt: "1970-01-01T00:00:00.000Z" },
    };
    memory.listThreads
      .mockResolvedValueOnce({
        threads: [currentDuplicate, tieB, tieA, newerCreated],
        total: 4,
        hasMore: false,
      })
      .mockResolvedValueOnce({ threads: [legacyDuplicate], total: 1, hasMore: false });

    const result = await listHomeSessionThreads({ page: 0, perPage: 10 });

    expect(result.total).toBe(4);
    expect(result.threads.filter((thread) => thread.id === "same-id")).toHaveLength(1);
    expect(result.threads.find((thread) => thread.id === "same-id")?.title).toBe("current");
    expect(result.threads.find((thread) => thread.id === "same-id")?.contentEditedAt)
      .toBe("2026-02-01T00:00:00.000Z");
    expect(result.threads.map((thread) => thread.id)).toEqual([
      "same-id",
      "newer-created",
      "a-id",
      "b-id",
    ]);
    expect(result.threads.every((thread) => Number.isFinite(Date.parse(thread.contentEditedAt))))
      .toBe(true);
  });

  it("reads document body fields from the documents table by default", async () => {
    const { loadSessionFromThread } = await import("../bridge/threadPersistence.js");
    const sessionId = "session-read-table";
    threads.set(sessionId, storedThread(sessionId, metadata({
      docId: "doc-table",
      docState: { kind: "editing" },
      docVersion: 1,
      legacySections: [textSection("metadata body")],
    })));
    vi.spyOn(documentRepo, "load").mockResolvedValue({
      id: "doc-table",
      threadId: sessionId,
      resourceId: "qingagent-user",
      title: "table title",
      docState: "locked",
      docVersion: 9,
      lastSyncedVersion: 1,
      legacySections: [textSection("table body")],
      version: 5,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-02T00:00:00.000Z",
    });

    const restored = await loadSessionFromThread(sessionId);

    expect(documentRepo.load).toHaveBeenCalledWith("doc-table");
    expect(restored?.docState).toEqual({ kind: "editing" });
    expect(restored?.docVersion).toBe(9);
    expect(restored?.legacySections).toEqual([textSection("table body")]);
  });

  it("falls back to metadata when the documents table misses", async () => {
    const { loadSessionFromThread } = await import("../bridge/threadPersistence.js");
    const sessionId = "session-read-miss";
    threads.set(sessionId, storedThread(sessionId, metadata({
      docId: "doc-miss",
      docVersion: 2,
      legacySections: [textSection("metadata survives")],
    })));
    vi.spyOn(documentRepo, "load").mockResolvedValue(null);

    const restored = await loadSessionFromThread(sessionId);

    expect(documentRepo.load).toHaveBeenCalledWith("doc-miss");
    expect(restored?.docVersion).toBe(2);
    expect(restored?.legacySections).toEqual([textSection("metadata survives")]);
  });

  it("falls back to metadata when the documents table read throws", async () => {
    const { loadSessionFromThread } = await import("../bridge/threadPersistence.js");
    const sessionId = "session-read-error";
    threads.set(sessionId, storedThread(sessionId, metadata({
      docId: "doc-error",
      docVersion: 4,
      legacySections: [textSection("metadata survives error")],
    })));
    vi.spyOn(documentRepo, "load").mockRejectedValue(new Error("db unavailable"));

    const restored = await loadSessionFromThread(sessionId);

    expect(documentRepo.load).toHaveBeenCalledWith("doc-error");
    expect(restored?.docVersion).toBe(4);
    expect(restored?.legacySections).toEqual([textSection("metadata survives error")]);
  });

  it("uses sessionId as legacy docId fallback for document table reads", async () => {
    const { loadSessionFromThread } = await import("../bridge/threadPersistence.js");
    const sessionId = "legacy-doc-table";
    const oldMeta = metadata({ docId: undefined, legacySections: [textSection("old meta")] });
    delete oldMeta.docId;
    threads.set(sessionId, storedThread(sessionId, oldMeta));
    vi.spyOn(documentRepo, "load").mockResolvedValue({
      id: sessionId,
      threadId: sessionId,
      resourceId: "qingagent-user",
      title: "legacy table",
      docState: "draft",
      docVersion: 8,
      lastSyncedVersion: 1,
      legacySections: [textSection("legacy table body")],
      version: 1,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-02T00:00:00.000Z",
    });

    const restored = await loadSessionFromThread(sessionId);

    expect(documentRepo.load).toHaveBeenCalledWith(sessionId);
    expect(restored?.docId).toBe(sessionId);
    expect(restored?.docVersion).toBe(8);
    expect(restored?.legacySections).toEqual([textSection("legacy table body")]);
  });

  it("H1: documents wins 后清理 stale suggestions 并持久化自愈 metadata", async () => {
    const {
      drainSessionPersistence,
      loadSessionFromThread,
    } = await import("../bridge/threadPersistence.js");
    const sessionId = "h1-documents-wins";
    const oldDoc = legacySectionsToPm([textSection("metadata old")] as never);
    const latestSections = [textSection("documents latest")];
    const latestDoc = legacySectionsToPm(latestSections as never);
    const staleSuggestion = suggestionRecord("stale-patch");
    threads.set(sessionId, storedThread(sessionId, metadata({
      docId: "doc-h1",
      docState: { kind: "pendingReview" },
      docVersion: 2,
      doc: oldDoc,
      legacySections: [textSection("metadata old")],
      suggestions: [staleSuggestion],
      patchVerdicts: { "stale-patch": "accepted" },
      chatHistory: [],
    })));
    vi.spyOn(documentRepo, "load").mockResolvedValue({
      id: "doc-h1",
      threadId: sessionId,
      resourceId: "qingagent-user",
      title: "documents title",
      docState: "editing",
      docVersion: 4,
      lastSyncedVersion: 4,
      legacySections: latestSections,
      pmDoc: latestDoc,
      version: 2,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-02T00:00:00.000Z",
    });
    vi.spyOn(documentDraftRepo, "load").mockResolvedValue(null);

    const restored = await loadSessionFromThread(sessionId);

    expect(restored?.docVersion).toBe(4);
    expect(restored?.doc).toEqual(latestDoc);
    expect(restored?.legacySections).toEqual(latestSections);
    expect(restored?.docState).toEqual({ kind: "editing" });
    expect(restored?.suggestions.size).toBe(0);
    expect(restored?.patchVerdicts.size).toBe(0);
    expect(spans.some((span) =>
      (span.input as { name?: string }).name === "restore_reconcile" &&
      (span.input as { input?: { metadataDocVersion?: number; documentsDocVersion?: number } }).input?.metadataDocVersion === 2 &&
      (span.input as { input?: { metadataDocVersion?: number; documentsDocVersion?: number } }).input?.documentsDocVersion === 4
    )).toBe(true);

    await drainSessionPersistence();
    const persisted = threads.get(sessionId)?.metadata as QingagentThreadMetadata | undefined;
    expect(persisted?.docVersion).toBe(4);
    expect(persisted?.doc).toEqual(latestDoc);
    expect(persisted?.legacySections).toEqual(latestSections);
    expect(persisted?.docState).toEqual({ kind: "editing" });
    expect(persisted?.suggestions).toEqual([]);
    expect(persisted?.patchVerdicts).toEqual({});
  });

  it("H1: documents 版本较新但有匹配 document_drafts 时保留 pending review", async () => {
    const {
      drainSessionPersistence,
      loadSessionFromThread,
    } = await import("../bridge/threadPersistence.js");
    const sessionId = "h1-preserve-matching-draft";
    const latestSections = [textSection("documents base")];
    const latestDoc = legacySectionsToPm(latestSections as never);
    const draftDoc = legacySectionsToPm([textSection("documents draft")] as never);
    const reviewSuggestion = suggestionRecord("kept-patch");
    threads.set(sessionId, storedThread(sessionId, metadata({
      docId: "doc-h1-match",
      docState: { kind: "pendingReview" },
      docVersion: 2,
      legacySections: [textSection("metadata old")],
      suggestions: [reviewSuggestion],
    })));
    vi.spyOn(documentRepo, "load").mockResolvedValue({
      id: "doc-h1-match",
      threadId: sessionId,
      resourceId: "qingagent-user",
      title: "documents title",
      docState: "editing",
      docVersion: 4,
      lastSyncedVersion: 4,
      legacySections: latestSections,
      pmDoc: latestDoc,
      version: 2,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-02T00:00:00.000Z",
    });
    vi.spyOn(documentDraftRepo, "load").mockResolvedValue({
      docId: "doc-h1-match",
      threadId: sessionId,
      baseVersion: 4,
      baseHash: getPmContentHash(latestDoc),
      draftPmDoc: draftDoc,
      status: "pending_review",
      conflict: null,
      reviewBatchId: "batch-kept",
      groupMode: "atomic",
      sourceStreamId: "stream-kept",
      sourceToolCallId: "tool-kept",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });

    const restored = await loadSessionFromThread(sessionId);

    expect(restored?.docVersion).toBe(4);
    expect(restored?.doc).toEqual(latestDoc);
    expect(restored?.docState).toEqual({ kind: "pendingReview" });
    expect(restored?.suggestions.size).toBeGreaterThan(0);
    expect(restored?.suggestionBaseVersion).toBe(4);
    expect(restored?.docDraftCandidateDoc).toEqual(draftDoc);

    await drainSessionPersistence();
    const persisted = threads.get(sessionId)?.metadata as QingagentThreadMetadata | undefined;
    expect(persisted?.docVersion).toBe(4);
    expect(persisted?.suggestions?.length).toBeGreaterThan(0);
  });
});
