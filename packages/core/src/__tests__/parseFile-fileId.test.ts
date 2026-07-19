import { afterAll, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseFileTool } from "../tools/parseFile.js";
import { UPLOADS_BASE } from "../session/uploadFileResolver.js";

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
  const previousRuntime = process.env.QINGAGENT_RUNTIME;
  delete process.env.QINGAGENT_RUNTIME;
  try {
    return (await parseFileTool.execute!(input as never, {} as never)) as ParseFileResult;
  } finally {
    if (previousRuntime === undefined) delete process.env.QINGAGENT_RUNTIME;
    else process.env.QINGAGENT_RUNTIME = previousRuntime;
  }
}

async function runDesktop(input: Record<string, unknown>): Promise<ParseFileResult> {
  const previousRuntime = process.env.QINGAGENT_RUNTIME;
  process.env.QINGAGENT_RUNTIME = "desktop";
  try {
    return (await parseFileTool.execute!(input as never, {} as never)) as ParseFileResult;
  } finally {
    if (previousRuntime === undefined) delete process.env.QINGAGENT_RUNTIME;
    else process.env.QINGAGENT_RUNTIME = previousRuntime;
  }
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

  it("Web 执行层忽略注入的 filePath/content，只接受 fileId", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "parse-file-web-policy-"));
    const injectedPath = path.join(tempDir, "injected.txt");
    await fs.writeFile(injectedPath, "WEB_PATH_INJECTION_MUST_NOT_LEAK", "utf8");
    await setupFixture();
    try {
      const pathResult = await run({
        filePath: injectedPath,
        filename: "injected.txt",
        mimeType: "text/plain",
      });
      const contentResult = await run({
        content: Buffer.from("WEB_CONTENT_INJECTION_MUST_NOT_LEAK").toString("base64"),
        filename: "injected.txt",
        mimeType: "text/plain",
      });
      const fileIdResult = await run({
        fileId: FILE_ID,
        filePath: injectedPath,
        content: Buffer.from("WEB_CONTENT_INJECTION_MUST_NOT_LEAK").toString("base64"),
        filename: "spoofed.txt",
        mimeType: "text/plain",
      });

      expect(pathResult.text).toBe("[Error] 文件不可访问");
      expect(contentResult.text).toBe("[Error] 文件不可访问");
      expect(fileIdResult.text).toContain(CONTENT);
      expect(fileIdResult.text).not.toContain("WEB_PATH_INJECTION_MUST_NOT_LEAK");
      expect(fileIdResult.text).not.toContain("WEB_CONTENT_INJECTION_MUST_NOT_LEAK");
      expect(pathResult.text).not.toContain("WEB_PATH_INJECTION_MUST_NOT_LEAK");
      expect(contentResult.text).not.toContain("WEB_CONTENT_INJECTION_MUST_NOT_LEAK");
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("Desktop 静默拒绝 .env、SSH 私钥及指向秘密文件的软链，正常素材照读", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "parse-file-desktop-policy-"));
    const sshDir = path.join(tempDir, ".ssh");
    const envPath = path.join(tempDir, ".env");
    const sshKeyPath = path.join(sshDir, "id_ed25519");
    const symlinkPath = path.join(tempDir, "notes.txt");
    const normalPath = path.join(tempDir, "report.txt");
    await fs.mkdir(sshDir, { recursive: true });
    await fs.writeFile(envPath, "SECRET_ENV_TOKEN", "utf8");
    await fs.writeFile(sshKeyPath, "SECRET_SSH_TOKEN", "utf8");
    await fs.writeFile(normalPath, "NORMAL_MATERIAL_BODY", "utf8");
    try {
      const inputs = [envPath, sshKeyPath];
      try {
        await fs.symlink(envPath, symlinkPath);
        inputs.push(symlinkPath);
      } catch {
        // Windows 未开启开发者模式时可能无法创建软链；路径黑名单断言仍继续。
      }
      for (const filePath of inputs) {
        const result = await runDesktop({ filePath, filename: "report.txt", mimeType: "text/plain" });
        expect(result.text).toBe("[Error] 文件不可访问");
        expect(result.metadata.wordCount).toBe(0);
        expect(result.text).not.toContain(filePath);
      }

      const normal = await runDesktop({
        filePath: normalPath,
        filename: "report.txt",
        mimeType: "text/plain",
      });
      expect(normal.text).toBe("NORMAL_MATERIAL_BODY");
      expect(String(parseFileTool.description)).not.toContain("优先使用");
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });
});
