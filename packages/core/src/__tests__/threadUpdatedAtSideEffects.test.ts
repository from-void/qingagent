import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LibSQLStore } from "@mastra/libsql";
import { Memory } from "@mastra/memory";
import { describe, expect, it } from "vitest";

describe("Mastra LibSQL thread.updatedAt side effects", () => {
  it("区分 saveThread、updateThread 与消息写，并保持 metadata 内容时间不变", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "qingagent-thread-time-"));
    try {
      const storage = new LibSQLStore({
        id: "thread-time-side-effects",
        url: `file:${join(tempDir, "memory.db")}`,
      });
      const memory = new Memory({
        storage,
        options: { lastMessages: 20, semanticRecall: false, generateTitle: false },
      });
      const threadId = "thread-time-side-effects";
      const suppliedAt = new Date("2020-01-01T00:00:00.000Z");
      const contentTime = "2019-12-31T23:59:59.000Z";

      await memory.saveThread({
        thread: {
          id: threadId,
          title: "初始",
          resourceId: "qingagent-user",
          createdAt: suppliedAt,
          updatedAt: suppliedAt,
          metadata: { lastContentEditedAt: contentTime },
        },
      });
      const afterSave = await memory.getThreadById({ threadId });
      expect(afterSave?.updatedAt.toISOString()).toBe(suppliedAt.toISOString());

      await memory.updateThread({
        id: threadId,
        title: "只改 metadata",
        metadata: { lastContentEditedAt: contentTime, opened: true },
      });
      const afterUpdate = await memory.getThreadById({ threadId });
      expect(afterUpdate!.updatedAt.getTime()).toBeGreaterThan(suppliedAt.getTime());
      expect(afterUpdate?.metadata?.lastContentEditedAt).toBe(contentTime);

      await new Promise((resolve) => setTimeout(resolve, 5));
      await memory.saveMessages({
        messages: [{
          id: "message-1",
          threadId,
          resourceId: "qingagent-user",
          role: "user",
          createdAt: new Date(),
          content: { format: 2, parts: [{ type: "text", text: "仅写消息" }] },
        }],
      });
      const afterMessage = await memory.getThreadById({ threadId });
      expect(afterMessage!.updatedAt.getTime()).toBeGreaterThan(afterUpdate!.updatedAt.getTime());
      expect(afterMessage?.metadata?.lastContentEditedAt).toBe(contentTime);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
