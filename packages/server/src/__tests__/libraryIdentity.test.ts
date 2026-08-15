import type { Client } from "@qingagent/db";
import { describe, expect, it } from "vitest";
import { getOrCreateLibraryId, LIBRARY_ID_SETTING_KEY } from "../lib/libraryIdentity";

function memoryClient(initial?: string): Client {
  let value = initial;
  return {
    async execute(statement: unknown) {
      const query = statement as { sql: string; args: unknown[] };
      const sql = query.sql.trimStart();
      if (sql.startsWith("INSERT OR IGNORE")) {
        if (value === undefined) value = String(query.args[1]);
        return { rows: [], columns: [], rowsAffected: 1, lastInsertRowid: undefined };
      }
      if (sql.startsWith("SELECT value")) {
        return {
          rows: value === undefined ? [] : [{ value }],
          columns: ["value"],
          rowsAffected: 0,
          lastInsertRowid: undefined,
        };
      }
      throw new Error("unexpected query");
    },
  } as unknown as Client;
}

describe("libraryId 库内持久身份", () => {
  it("首次写入后永远读取同一个 libraryId", async () => {
    const client = memoryClient();
    const first = await getOrCreateLibraryId({
      candidate: "00000000-0000-4000-8000-000000000001",
      client,
      skipMigration: true,
    });
    const second = await getOrCreateLibraryId({
      candidate: "00000000-0000-4000-8000-000000000002",
      client,
      skipMigration: true,
    });
    expect(first).toBe("00000000-0000-4000-8000-000000000001");
    expect(second).toBe(first);
    expect(LIBRARY_ID_SETTING_KEY).toBe("library_id.v1");
  });

  it("非法既有 identity fail closed，不生成替代 ID", async () => {
    await expect(getOrCreateLibraryId({
      candidate: "00000000-0000-4000-8000-000000000001",
      client: memoryClient("corrupted"),
      skipMigration: true,
    })).rejects.toThrow("libraryId missing or malformed");
  });
});
