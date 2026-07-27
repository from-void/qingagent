import type { PmDoc } from "@qingagent/pm-schema";
import { describe, expect, it, vi } from "vitest";
import { UPLOAD_PLACEHOLDER_IMAGE_SRC } from "./insertUploadedAsset";
import {
  buildPageExitDocSaveCommand,
  drainPageExitDocSaveOutbox,
  flushDocSaveOnPageExit,
  PAGE_EXIT_DOC_SAVE_OUTBOX_DRAIN_LOCK,
  readPageExitDocSaveOutbox,
  type PageExitOutboxStorage,
} from "./pageExitSave";
import {
  crossTabLeaseStorageKey,
  type CrossTabLockManager,
} from "../../../system/crossTabLock";

function createStorage(): PageExitOutboxStorage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    key: (index) => [...values.keys()][index] ?? null,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
    removeItem: (key) => {
      values.delete(key);
    },
  };
}

function createLockManager(): CrossTabLockManager {
  let held = false;
  return {
    async request<T>(
      name: string,
      options: { mode: "exclusive"; ifAvailable?: boolean },
      callback: (
        lock: { name: string; mode: "exclusive" | "shared" } | null,
      ) => T | PromiseLike<T>,
    ): Promise<T> {
      if (held && options.ifAvailable) return callback(null);
      if (held) throw new Error("test lock only supports ifAvailable");
      held = true;
      try {
        return await callback({ name, mode: "exclusive" });
      } finally {
        held = false;
      }
    },
  };
}

function placeholderDoc(extraContent: PmDoc["content"] = []): PmDoc {
  return {
    type: "doc",
    attrs: { schemaVersion: 1 },
    content: [
      ...extraContent,
      {
        type: "image",
        attrs: {
          blockId: "upload-image-pending",
          src: UPLOAD_PLACEHOLDER_IMAGE_SRC,
          alt: "figure.png",
          uploading: true,
          progress: 20,
          error: false,
        },
      } as unknown as PmDoc["content"][number],
    ],
  };
}

describe("pageExitSave 图片上传占位", () => {
  it("新文档只有上传占位时不创建幽灵文档", () => {
    expect(buildPageExitDocSaveCommand({
      sessionId: "session-new",
      expectedDocumentSnapshot: 0,
      baseContentHash: "empty",
      pmDoc: placeholderDoc(),
      hasPendingDocSave: true,
      createMutationId: () => "mutation-new",
    })).toBeNull();
  });

  it("已有文档离页保存时剔除未完成图片但保留真实正文", () => {
    const paragraph: PmDoc["content"][number] = {
      type: "paragraph",
      attrs: { blockId: "p-1" },
      content: [{ type: "text", text: "正文" }],
    };
    const command = buildPageExitDocSaveCommand({
      sessionId: "session-existing",
      expectedDocumentSnapshot: 7,
      baseContentHash: "base",
      pmDoc: placeholderDoc([paragraph]),
      baselineDoc: {
        type: "doc",
        attrs: { schemaVersion: 1 },
        content: [paragraph],
      },
      hasPendingDocSave: true,
      createMutationId: () => "mutation-existing",
    });

    expect(command).not.toBeNull();
    expect(command?.data.doc?.content).toEqual([paragraph]);
    expect(command?.data.legacySections).toBeUndefined();
  });
});

describe("pageExitSave 持久 outbox", () => {
  const baseline: PmDoc = {
    type: "doc",
    attrs: { schemaVersion: 1 },
    content: [{
      type: "paragraph",
      attrs: { blockId: "p-1" },
      content: [{ type: "text", text: "旧正文" }],
    }],
  };
  const edited: PmDoc = {
    type: "doc",
    attrs: { schemaVersion: 1 },
    content: [{
      type: "paragraph",
      attrs: { blockId: "p-1" },
      content: [{ type: "text", text: "离页前最后编辑" }],
    }],
  };

  it("先落本地再尝试 Beacon，发送失败仍保留可恢复副本", async () => {
    const storage = createStorage();
    const sendBeacon = vi.fn(() => {
      expect(readPageExitDocSaveOutbox({ storage })).toHaveLength(1);
      return false;
    });
    const fetchKeepalive = vi.fn(async () => {
      throw new TypeError("keepalive quota exceeded");
    });

    expect(flushDocSaveOnPageExit({
      sessionId: "session-outbox",
      expectedDocumentSnapshot: 7,
      baseContentHash: "base-7",
      pmDoc: edited,
      baselineDoc: baseline,
      hasPendingDocSave: false,
      createMutationId: () => "exit-outbox",
      sendBeacon,
      fetchKeepalive,
      outboxStorage: storage,
    })).toBe("keepalive");

    await Promise.resolve();
    expect(sendBeacon).toHaveBeenCalledOnce();
    expect(readPageExitDocSaveOutbox({ storage })).toMatchObject([{
      id: "exit-outbox",
      sessionId: "session-outbox",
      fallbackBase: {
        expectedDocumentSnapshot: 7,
        baseContentHash: "base-7",
      },
      pmDoc: edited,
    }]);
  });

  it("恢复后用非 keepalive 普通请求确认补交并清理副本", async () => {
    const storage = createStorage();
    flushDocSaveOnPageExit({
      sessionId: "session-recover",
      expectedDocumentSnapshot: 4,
      baseContentHash: "base-4",
      pmDoc: edited,
      baselineDoc: baseline,
      hasPendingDocSave: false,
      createMutationId: () => "exit-recover",
      sendBeacon: () => true,
      outboxStorage: storage,
    });
    const fetchRequest = vi.fn(async (_url: string, init: RequestInit) => {
      expect(init.keepalive).toBeUndefined();
      const command = JSON.parse(String(init.body));
      expect(command.data.legacySections).toBeUndefined();
      return {
        ok: true,
        status: 200,
        json: async () => [{
          kind: "docWriteResult",
          data: {
            ok: true,
            clientMutationId: command.data.clientMutationId,
            docVersion: 5,
          },
        }],
      };
    });

    await expect(drainPageExitDocSaveOutbox({
      storage,
      fetchRequest,
      lockManager: createLockManager(),
    })).resolves.toEqual({
      saved: 1,
      conflicts: [],
      remaining: 0,
      busy: false,
    });
    expect(fetchRequest).toHaveBeenCalledOnce();
    expect(readPageExitDocSaveOutbox({ storage })).toEqual([]);
  });

  it("双标签并发 drain 只有一个消费者提交同一 outbox", async () => {
    const storage = createStorage();
    const lockManager = createLockManager();
    flushDocSaveOnPageExit({
      sessionId: "session-concurrent",
      expectedDocumentSnapshot: 5,
      baseContentHash: "base-5",
      pmDoc: edited,
      baselineDoc: baseline,
      hasPendingDocSave: false,
      createMutationId: () => "exit-concurrent",
      sendBeacon: () => true,
      outboxStorage: storage,
    });
    let releaseFetch!: () => void;
    const fetchGate = new Promise<void>((resolve) => {
      releaseFetch = resolve;
    });
    const fetchRequest = vi.fn(async (_url: string, init: RequestInit) => {
      await fetchGate;
      const command = JSON.parse(String(init.body));
      return {
        ok: true,
        status: 200,
        json: async () => [{
          kind: "docWriteResult",
          data: {
            ok: true,
            clientMutationId: command.data.clientMutationId,
            docVersion: 6,
          },
        }],
      };
    });

    const first = drainPageExitDocSaveOutbox({
      storage,
      fetchRequest,
      lockManager,
    });
    await Promise.resolve();
    const second = await drainPageExitDocSaveOutbox({
      storage,
      fetchRequest,
      lockManager,
    });

    expect(second).toEqual({
      saved: 0,
      conflicts: [],
      remaining: 1,
      busy: true,
    });
    expect(fetchRequest).toHaveBeenCalledOnce();
    releaseFetch();
    await expect(first).resolves.toEqual({
      saved: 1,
      conflicts: [],
      remaining: 0,
      busy: false,
    });
    expect(fetchRequest).toHaveBeenCalledOnce();
  });

  it("持有者崩溃后存活标签在租约过期时接管并补交", async () => {
    const storage = createStorage();
    flushDocSaveOnPageExit({
      sessionId: "session-crashed-owner",
      expectedDocumentSnapshot: 9,
      baseContentHash: "base-9",
      pmDoc: edited,
      baselineDoc: baseline,
      hasPendingDocSave: false,
      createMutationId: () => "exit-crashed-owner",
      sendBeacon: () => true,
      outboxStorage: storage,
    });
    storage.setItem(
      crossTabLeaseStorageKey(PAGE_EXIT_DOC_SAVE_OUTBOX_DRAIN_LOCK),
      JSON.stringify({
        version: 1,
        ownerId: "tab-crashed",
        expiresAt: Date.now() - 1,
      }),
    );
    const fetchRequest = vi.fn(
      async (_url: string, init: RequestInit) => {
        const command = JSON.parse(String(init.body));
        return {
          ok: true,
          status: 200,
          json: async () => [{
            kind: "docWriteResult",
            data: {
              ok: true,
              clientMutationId: command.data.clientMutationId,
              docVersion: 10,
            },
          }],
        };
      },
    );

    await expect(drainPageExitDocSaveOutbox({
      storage,
      fetchRequest,
    })).resolves.toEqual({
      saved: 1,
      conflicts: [],
      remaining: 0,
      busy: false,
    });
    expect(fetchRequest).toHaveBeenCalledOnce();
    expect(readPageExitDocSaveOutbox({ storage })).toEqual([]);
  });

  it("陈旧离页快照撞 CAS 后保留较新外部版本，冲突项显式出列且不 rebase", async () => {
    const storage = createStorage();
    flushDocSaveOnPageExit({
      sessionId: "session-stale",
      expectedDocumentSnapshot: 7,
      baseContentHash: "base-7",
      pmDoc: edited,
      baselineDoc: baseline,
      hasPendingDocSave: false,
      createMutationId: () => "exit-stale",
      sendBeacon: () => true,
      outboxStorage: storage,
    });
    const submittedVersions: number[] = [];
    const fetchRequest = vi.fn(async (_url: string, init: RequestInit) => {
      const command = JSON.parse(String(init.body));
      submittedVersions.push(command.data.expectedDocumentSnapshot);
      return {
        ok: true,
        status: 200,
        json: async () => [{
          kind: "docWriteResult",
          data: {
            ok: false,
            clientMutationId: command.data.clientMutationId,
            conflict: {
              expectedDocumentSnapshot: 7,
              actualDocumentSnapshot: 8,
            },
          },
        }],
      };
    });

    await expect(drainPageExitDocSaveOutbox({
      storage,
      fetchRequest,
      fetchCurrentBase: async () => ({
        expectedDocumentSnapshot: 8,
        baseContentHash: "newer-external-content",
      }),
      lockManager: createLockManager(),
    })).resolves.toEqual({
      saved: 0,
      conflicts: [{
        id: "exit-stale",
        sessionId: "session-stale",
        latestBase: {
          expectedDocumentSnapshot: 8,
          baseContentHash: "newer-external-content",
        },
      }],
      remaining: 0,
      busy: false,
    });
    expect(submittedVersions).toEqual([7]);
    expect(readPageExitDocSaveOutbox({ storage })).toEqual([]);
  });
});
