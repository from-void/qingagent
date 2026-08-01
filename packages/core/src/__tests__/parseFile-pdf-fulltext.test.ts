import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { parseFileBuffer } from "../tools/parseFile.js";

const FIXTURE_URL = new URL(
  "./fixtures/B-r33-edge-compute-reliability-report.pdf",
  import.meta.url,
);

describe("parseFileBuffer PDF 全文抽取", () => {
  it("多页文字 PDF 不丢页外内容流中的正文和关键数字", async () => {
    const result = await parseFileBuffer({
      buffer: await readFile(FIXTURE_URL),
      filename: "B-r33-edge-compute-reliability-report.pdf",
      mimeType: "application/pdf",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    expect(result.metadata.pages).toBe(22);
    expect(result.metadata.indexable).toBe(true);
    expect(result.metadata.wordCount).toBeGreaterThan(10_000);
    expect(result.text).toContain("Chapter 3: Reliability findings");
    expect(result.text).toContain("8.4 seconds to 2.7 seconds");
    expect(result.text).toContain("96.8 percent of read requests");
    expect(result.text).not.toContain("仅解析前");
  });
});
