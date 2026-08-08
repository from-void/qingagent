import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { QingagentThreadMetadata } from "../session/threadPersistence.js";
import { countDocVisibleChars } from "@qingagent/pm-schema";
import {
  prepareTempDocumentsDb,
  type TempDocumentsDb,
} from "@qingagent/db/testing";
import { getDocumentsClient } from "@qingagent/db";

describe("usage thread metadata targeted reads", () => {
  let tempDb: TempDocumentsDb;

  beforeAll(() => {
    tempDb = prepareTempDocumentsDb("qingagent-usage-thread-metadata-");
  });

  afterAll(() => tempDb.cleanup());

  it("同一批真实 thread 数据下与全量实现标题/docstats 完全一致", async () => {
    const { listSessionThreads } = await import("../session/threadPersistence.js");
    const {
      getSessionDocumentStatsSince,
      getSessionThreadTitles,
    } = await import("../session/usageThreadMetadata.js");
    await listSessionThreads({ page: 0, perPage: false });
    const client = getDocumentsClient();
    const cutoff = Date.parse("2026-07-28T12:00:00.000Z");
    const pmDoc = {
      type: "doc",
      content: [{
        type: "paragraph",
        content: [{ type: "text", text: "新格式正文" }],
      }],
    };
    const rows = [
      {
        id: "current-recent",
        resourceId: "qingagent-user",
        title: "线程标题",
        createdAt: "2026-08-01T00:00:00.000Z",
        metadata: { title: "元数据标题", doc: pmDoc },
      },
      {
        id: "canonical-doc-recent",
        resourceId: "qingagent-user",
        title: "旧正文格式线程标题",
        createdAt: "2026-07-30T00:00:00.000Z",
        metadata: {
          title: "",
          doc: {
            type: "doc",
            content: [{ type: "paragraph", content: [{ type: "text", text: "另一篇正文" }] }],
          },
        },
      },
      {
        id: "current-old",
        resourceId: "qingagent-user",
        title: "窗口外",
        createdAt: "2026-07-01T00:00:00.000Z",
        metadata: { title: "窗口外", doc: pmDoc },
      },
      {
        id: "other-resource",
        resourceId: "other-user",
        title: "不可见",
        createdAt: "2026-08-02T00:00:00.000Z",
        metadata: { title: "不可见", doc: pmDoc },
      },
      ...Array.from({ length: 201 }, (_, index) => ({
        id: `batch-${index}`,
        resourceId: "qingagent-user",
        title: `批次线程-${index}`,
        createdAt: "2026-07-01T00:00:00.000Z",
        metadata: { title: `批次元数据-${index}` },
      })),
    ];
    await client.batch(rows.map((row) => ({
      sql: `INSERT INTO mastra_threads
        (id, resourceId, title, metadata, createdAt, updatedAt)
        VALUES (?, ?, ?, jsonb(?), ?, ?)`,
      args: [
        row.id,
        row.resourceId,
        row.title,
        JSON.stringify(row.metadata),
        row.createdAt,
        row.createdAt,
      ],
    })), "write");

    const { threads } = await listSessionThreads({ page: 0, perPage: false });
    const oldTitles = new Map(threads.map((thread) => {
      const meta = (thread.metadata ?? {}) as unknown as QingagentThreadMetadata;
      return [thread.id, meta.title || thread.title || ""];
    }));
    let oldDocs = 0;
    let oldWords = 0;
    for (const thread of threads) {
      if (thread.createdAt.getTime() < cutoff) continue;
      oldDocs += 1;
      const doc = ((thread.metadata ?? {}) as unknown as QingagentThreadMetadata).doc;
      if (doc) oldWords += countDocVisibleChars(doc);
    }

    const requestedIds = rows.map((row) => row.id);
    const newTitles = await getSessionThreadTitles(requestedIds);
    const newStats = await getSessionDocumentStatsSince(cutoff);

    expect(Object.fromEntries(newTitles)).toEqual(Object.fromEntries(oldTitles));
    expect(newStats).toEqual({ docs: oldDocs, words: oldWords });
  });
});
