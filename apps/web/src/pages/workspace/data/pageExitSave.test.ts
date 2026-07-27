import type { PmDoc } from "@qingagent/pm-schema";
import { describe, expect, it, vi } from "vitest";
import { UPLOAD_PLACEHOLDER_IMAGE_SRC } from "./insertUploadedAsset";
import {
  buildPageExitDocSaveCommand,
  drainPageExitDocSaveOutbox,
  flushDocSaveOnPageExit,
  readPageExitDocSaveOutbox,
  type PageExitOutboxStorage,
} from "./pageExitSave";

function createStorage(): PageExitOutboxStorage {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
    removeItem: (key) => {
      values.delete(key);
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
    })).resolves.toEqual({ saved: 1, remaining: 0 });
    expect(fetchRequest).toHaveBeenCalledOnce();
    expect(readPageExitDocSaveOutbox({ storage })).toEqual([]);
  });
});
