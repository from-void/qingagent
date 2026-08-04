import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createRollingConsoleTransport } from "./rollingFiles.js";

test("rolling console transport 多次 write 按增量累计 UTF-8 字节", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "qingagent-rolling-"));
  const messages = ["a", "中文", "🙂"];
  const expectedBytes = messages.reduce(
    (sum, message) => sum + new TextEncoder().encode(consoleLine(message)).byteLength,
    0,
  );
  const transport = createRollingConsoleTransport(dir, {
    maxDays: 7,
    maxBytes: 1024 * 1024,
    maxBufferBytes: expectedBytes,
    flushIntervalMs: 60_000,
    now: () => new Date("2026-08-04T00:00:00.000Z"),
  });

  try {
    for (const message of messages) transport.write("log", [message]);
    const content = await waitForFile(path.join(dir, "main-2026-08-04.log"));

    assert.deepEqual(content.match(/\[LOG\] (?:a|中文|🙂)\n/g), [
      "[LOG] a\n",
      "[LOG] 中文\n",
      "[LOG] 🙂\n",
    ]);
    assert.equal(new TextEncoder().encode(content).byteLength, expectedBytes);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

function consoleLine(message: string): string {
  return `[${new Date().toISOString()}] [LOG] ${message}\n`;
}

async function waitForFile(filePath: string): Promise<string> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      return await readFile(filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
  throw new Error(`日志未按累计字节阈值刷盘: ${filePath}`);
}
