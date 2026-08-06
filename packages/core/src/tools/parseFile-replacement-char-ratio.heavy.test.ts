import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));

describe("replacementCharRatio 大文本内存", () => {
  it("在 128 MiB 堆上限内扫描 16 MiB 文本", () => {
    const probe = String.raw`
      const { replacementCharRatio } = await import("./packages/core/src/tools/replacementCharRatio.ts");
      const text = "a".repeat(16 * 1024 * 1024);
      const startedAt = Date.now();
      const ratio = replacementCharRatio(text);
      if (ratio !== 0) throw new Error("unexpected ratio: " + ratio);
      const elapsedMs = Date.now() - startedAt;
      if (elapsedMs > 10_000) throw new Error("scan timed out: " + elapsedMs + "ms");
    `;
    const result = spawnSync(process.execPath, [
      "--max-old-space-size=128",
      "--import",
      "tsx",
      "--input-type=module",
      "--eval",
      probe,
    ], {
      cwd: repoRoot,
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
      timeout: 15_000,
    });

    expect(
      result.status,
      [result.error?.message, result.signal, result.stderr].filter(Boolean).join("\n"),
    ).toBe(0);
  });
});
