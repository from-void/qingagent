import { afterAll, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import { parseFileTool } from "../tools/parseFile.js";
import { UPLOADS_BASE } from "../bridge/uploadFileResolver.js";

// CC 脱敏:web 模式模型只拿到内部 fileId,parseFile 用安全 resolver 还原 ./uploads 下的真实路径。
// 这里建临时上传目录夹具,验证 parseFile({ fileId }) 能读出内容、filename/mimeType 由 resolver 补齐。

type ParseFileResult = { text: string; metadata: { pages: number | null; wordCount: number; title: string | null } };

const FILE_ID = "abcdef01-2345-4678-89ab-cdef01234567";
const FILE_DIR = path.resolve(UPLOADS_BASE, FILE_ID);
const FILE_NAME = "sample.txt";
const CONTENT = "脱敏 fileId 解析测试正文";

async function setupFixture(): Promise<void> {
  await fs.mkdir(FILE_DIR, { recursive: true });
  await fs.writeFile(path.resolve(FILE_DIR, FILE_NAME), CONTENT, "utf8");
}

async function run(input: Record<string, unknown>): Promise<ParseFileResult> {
  return (await parseFileTool.execute!(input as never, {} as never)) as ParseFileResult;
}

describe("parseFile fileId 解析(CC 脱敏)", () => {
  afterAll(async () => {
    await fs.rm(FILE_DIR, { recursive: true, force: true });
  });

  it("传 fileId(省略 filename/mimeType)→ resolver 还原路径并解析出正文", async () => {
    await setupFixture();
    const result = await run({ fileId: FILE_ID });
    expect(result.text).toContain(CONTENT);
  });

  it("非法 fileId → 返回可读错误,不抛异常", async () => {
    const result = await run({ fileId: "not-a-uuid" });
    expect(result.text).toContain("[Error]");
    expect(result.text).toContain("无法解析 fileId");
  });

  it("三者皆缺 → 明确错误提示", async () => {
    const result = await run({ filename: "x.txt", mimeType: "text/plain" });
    expect(result.text).toContain("[Error]");
  });
});
