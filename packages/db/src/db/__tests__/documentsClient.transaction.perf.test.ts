import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  commitTransaction,
  getDocumentsClient,
  rollbackTransaction,
  withTransaction,
} from "../documentsClient.js";
import { documentRepo } from "../documentRepo.js";
import { upsertDocumentSuggestion } from "../documentSuggestionsRepo.js";
import {
  documentInput,
  prepareTempDocumentsDb,
  type TempDocumentsDb,
} from "./dbTestUtils.js";

let db: TempDocumentsDb;

beforeEach(() => {
  db = prepareTempDocumentsDb("qa-documents-client-txn-");
});

afterEach(() => {
  db.cleanup();
});

function deferred(): {
  promise: Promise<void>;
  resolve: () => void;
} {
  let resolve = () => {};
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

async function countSuggestion(id: string): Promise<number> {
  const result = await getDocumentsClient().execute({
    sql: "SELECT COUNT(*) AS n FROM document_suggestions WHERE id = ?",
    args: [id],
  });
  return Number(result.rows[0]?.n ?? 0);
}

async function seedDocument(id: string): Promise<void> {
  await documentRepo.save(documentInput(id, { threadId: `thread-${id}` }));
}

async function useFastBusyTimeoutForTest(): Promise<void> {
  await getDocumentsClient().execute("PRAGMA busy_timeout=100");
}

function suggestion(id: string, docId: string) {
  return {
    id,
    docId,
    baseVersion: 1,
    baseSchemaVersion: 1,
    status: "reviewing" as const,
    anchor: {
      blockId: `block-${docId}`,
      pmFrom: 0,
      pmTo: 0,
      quote: "",
      textHash: `hash-${docId}`,
    },
    patch: { kind: "prosemirror_steps" as const, steps: [] },
    preview: {
      deleteText: "",
      insertText: "",
    },
    summary: `summary-${id}`,
  };
}

describe("documentsClient transactions", () => {
  it("嵌套 withTransaction 会立即抛出明确错误而不是永久挂起", async () => {
    const timeoutMs = 300;
    const startedAt = performance.now();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const guardedTransaction = Promise.race([
      withTransaction(async () => {
        await withTransaction(async () => commitTransaction("inner"));
        return commitTransaction("outer");
      }),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error(`嵌套事务未在 ${timeoutMs}ms 内快速失败`)),
          timeoutMs,
        );
      }),
    ]);

    let thrown: unknown;
    try {
      await guardedTransaction;
    } catch (error) {
      thrown = error;
    } finally {
      clearTimeout(timeout);
    }

    expect(thrown).toBeInstanceOf(Error);
    if (thrown instanceof Error) {
      expect(thrown.message).toBe(
        "嵌套事务不受支持，请传递同一 client 组合原子操作",
      );
      expect(thrown.stack).toContain("withTransaction");
      expect(performance.now() - startedAt).toBeLessThan(timeoutMs);
    }
  });

  it("顺序两次 withTransaction 均成功", async () => {
    await expect(
      withTransaction(async () => commitTransaction("first")),
    ).resolves.toBe("first");
    await expect(
      withTransaction(async () => commitTransaction("second")),
    ).resolves.toBe("second");
  });

  it("事务 rollback 不会卷走事务期间共享连接写入的 suggestions", async () => {
    await seedDocument("doc-txn-isolation");
    await useFastBusyTimeoutForTest();
    const started = deferred();
    const releaseRollback = deferred();

    const transaction = withTransaction(async () => {
      started.resolve();
      await releaseRollback.promise;
      return rollbackTransaction(undefined);
    });

    await started.promise;
    const write = upsertDocumentSuggestion(
      suggestion("sug-during-rollback", "doc-txn-isolation"),
    );
    setTimeout(() => releaseRollback.resolve(), 125);
    await Promise.all([transaction, write]);

    expect(await countSuggestion("sug-during-rollback")).toBe(1);
  });

  it("并发 withTransaction 串行执行且都成功", async () => {
    await seedDocument("doc-serial-txn");
    const firstStarted = deferred();
    const releaseFirst = deferred();
    const order: string[] = [];

    const first = withTransaction(async () => {
      order.push("first-start");
      firstStarted.resolve();
      await releaseFirst.promise;
      order.push("first-end");
      return commitTransaction("first");
    });

    await firstStarted.promise;
    const second = withTransaction(async () => {
      order.push("second-start");
      return commitTransaction("second");
    });

    await Promise.resolve();
    expect(order).toEqual(["first-start"]);
    releaseFirst.resolve();

    await expect(first).resolves.toBe("first");
    await expect(second).resolves.toBe("second");
    expect(order).toEqual(["first-start", "first-end", "second-start"]);
  });

  it("事务挂起期间共享连接写入会走 SQLITE_BUSY 重试并最终成功", async () => {
    await seedDocument("doc-busy-retry");
    await useFastBusyTimeoutForTest();
    const started = deferred();
    const releaseCommit = deferred();

    const transaction = withTransaction(async (txnClient) => {
      await txnClient.execute({
        sql: "UPDATE documents SET title = ? WHERE id = ?",
        args: ["txn-holds-write-lock", "doc-busy-retry"],
      });
      started.resolve();
      await releaseCommit.promise;
      return commitTransaction(undefined);
    });

    await started.promise;
    const startedAt = performance.now();
    const write = upsertDocumentSuggestion(
      suggestion("sug-busy-retry", "doc-busy-retry"),
    );
    setTimeout(() => releaseCommit.resolve(), 125);

    await Promise.all([transaction, write]);
    const elapsed = performance.now() - startedAt;

    expect(await countSuggestion("sug-busy-retry")).toBe(1);
    expect(elapsed).toBeLessThan(5_000);
  });
});
