import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { QingagentThreadMetadata } from "../session/threadPersistence.js";

const originalDatabaseUrl = process.env.DATABASE_URL;

afterEach(() => {
  if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = originalDatabaseUrl;
  vi.resetModules();
});

describe("seedInitialContent content time", () => {
  it("种子 thread 的初始排序键与创建时间同源", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "qingagent-seed-content-time-"));
    try {
      process.env.DATABASE_URL = `file:${join(tempDir, "seed.db")}`;
      vi.resetModules();
      const core = await import("../index.js");

      await core.seedInitialContent();
      const listed = await core.listHomeSessionThreads({ page: 0, perPage: 100 });

      expect(listed.threads.length).toBeGreaterThanOrEqual(4);
      for (const thread of listed.threads) {
        const meta = thread.metadata as unknown as QingagentThreadMetadata;
        expect(meta.lastContentEditedAt).toBe(thread.createdAtIso);
        expect(thread.contentEditedAt).toBe(thread.createdAtIso);
      }
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
