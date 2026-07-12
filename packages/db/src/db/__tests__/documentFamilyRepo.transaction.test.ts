import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const transactionClient = {
    execute: vi.fn(),
  };
  const documentsClient = {
    execute: vi.fn(),
  };
  return {
    transactionClient,
    documentsClient,
    commitTransaction: vi.fn((value: undefined) => ({ action: "commit" as const, value })),
    getDocumentsClient: vi.fn(() => documentsClient),
    withTransaction: vi.fn(async (fn: (client: typeof transactionClient) => Promise<unknown>) => fn(transactionClient)),
    ensureMigrated: vi.fn(async () => undefined),
  };
});

vi.mock("../documentsClient.js", () => ({
  commitTransaction: mocks.commitTransaction,
  getDocumentsClient: mocks.getDocumentsClient,
  withTransaction: mocks.withTransaction,
}));

vi.mock("../migrations.js", () => ({
  ensureMigrated: mocks.ensureMigrated,
}));

import { deleteDocumentFamily } from "../documentFamilyRepo.js";

describe("deleteDocumentFamily transaction boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.documentsClient.execute.mockRejectedValue(new Error("收集 doc id 不得逃出删除事务"));
    mocks.transactionClient.execute.mockImplementation(async (input: { sql: string }) => {
      if (input.sql.startsWith("SELECT id FROM documents")) {
        return { rows: [{ id: "late-doc" }] };
      }
      return { rows: [] };
    });
  });

  it("在删除事务连接内收集在途提交可能写入的 doc id", async () => {
    await deleteDocumentFamily("session-late-doc");

    expect(mocks.getDocumentsClient).not.toHaveBeenCalled();
    expect(mocks.transactionClient.execute).toHaveBeenNthCalledWith(1, {
      sql: "SELECT id FROM documents WHERE thread_id = ? OR id = ?",
      args: ["session-late-doc", "session-late-doc"],
    });
    expect(mocks.transactionClient.execute).toHaveBeenCalledWith({
      sql: "DELETE FROM document_versions WHERE doc_id IN (?, ?)",
      args: ["session-late-doc", "late-doc"],
    });
  });
});
