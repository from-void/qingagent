import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDurableFileLogger } from "../crashGuard.js";

const tempDirs: string[] = [];

describe("crashGuard durable log 跨日轮换", () => {
  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("每次写入按注入时钟解析文件名，日期变化时关闭旧 stream 并写入新文件", async () => {
    const logDir = await mkdtemp(join(tmpdir(), "qingagent-crash-rotation-"));
    tempDirs.push(logDir);
    let now = new Date("2026-08-04T23:59:59.000Z");
    const logger = createDurableFileLogger({ logDir, now: () => now });

    logger.log("info", "day-one");
    now = new Date("2026-08-05T00:00:01.000Z");
    logger.log("info", "day-two");
    await logger.close();

    await expect(readFile(join(logDir, "server-2026-08-04.log"), "utf8"))
      .resolves.toContain("day-one");
    await expect(readFile(join(logDir, "server-2026-08-05.log"), "utf8"))
      .resolves.toContain("day-two");
  });
});
