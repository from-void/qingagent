import { afterAll, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseFileTool } from "../tools/parseFile.js";
import { UPLOADS_BASE } from "../session/uploadFileResolver.js";

// CC 脱敏:web 模式模型只拿到内部 fileId,parseFile 用安全 resolver 还原 ./uploads 下的真实路径。
// 这里建临时上传目录夹具,验证 parseFile({ fileId }) 能读出内容、filename/mimeType 由 resolver 补齐。

type ParseFileResult = {
  ok: boolean;
  error?: string;
  failureKind?: "unsupported" | "error";
  text: string;
  metadata: { pages: number | null; wordCount: number; title: string | null };
};

const FILE_ID = "abcdef01-2345-4678-89ab-cdef01234567";
const FILE_NAME = "sample.txt";
const CONTENT = "脱敏 fileId 解析测试正文";
const createdFixtureDirs = new Set<string>();

async function createUploadFixture(
  fileId: string,
  filename: string,
  content: string | Buffer,
): Promise<void> {
  const directory = path.resolve(UPLOADS_BASE, fileId);
  createdFixtureDirs.add(directory);
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.resolve(directory, filename), content);
}

async function setupFixture(): Promise<void> {
  await createUploadFixture(FILE_ID, FILE_NAME, CONTENT);
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
    await Promise.all(
      Array.from(createdFixtureDirs, (directory) =>
        fs.rm(directory, { recursive: true, force: true })),
    );
  });

  it("传 fileId(省略 filename/mimeType)→ resolver 还原路径并解析出正文", async () => {
    await setupFixture();
    const result = await run({ fileId: FILE_ID });
    expect(result.text).toContain(CONTENT);
  });

  it("Desktop runtime 仅传 fileId → resolver 读取上传 TXT", async () => {
    await setupFixture();
    const result = await runDesktop({ fileId: FILE_ID });

    expect(result.ok).toBe(true);
    expect(result.text).toBe(CONTENT);
  });

  it("Desktop runtime 的 BOM + CRLF TXT 正文保真", async () => {
    const fileId = "11111111-2222-4333-8444-555555555555";
    const content = "第一行\r\n第二行：全角标点，保留。\r\n";
    await createUploadFixture(
      fileId,
      "bom-crlf.txt",
      Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(content)]),
    );

    const result = await runDesktop({ fileId });

    expect(result.ok).toBe(true);
    expect(result.text).toBe(content);
  });

  it("Desktop runtime 的多级标题 Markdown 正文保真", async () => {
    const fileId = "22222222-3333-4444-8555-666666666666";
    const content = "# 一级标题\n\n## 二级标题\n\n### 三级标题\n\n正文。";
    await createUploadFixture(fileId, "outline.md", content);

    const result = await runDesktop({ fileId });

    expect(result.ok).toBe(true);
    expect(result.text).toBe(content);
  });

  it("Desktop runtime 的全角标点 CSV 正文保真", async () => {
    const fileId = "33333333-4444-4555-8666-777777777777";
    const content = "姓名,备注\r\n张三,\"你好，世界！\"\r\n李四,\"金额：￥100。\"\r\n";
    await createUploadFixture(fileId, "中文.csv", content);

    const result = await runDesktop({ fileId });

    expect(result.ok).toBe(true);
    expect(result.text).toBe(content);
  });

  it("Desktop 同时传 fileId + filePath 时必须优先读取 fileId", async () => {
    const fileId = "44444444-5555-4666-8777-888888888888";
    const expected = "FILE_ID_CHANNEL_BODY";
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "parse-file-priority-"));
    const injectedPath = path.join(tempDir, "injected.txt");
    await createUploadFixture(fileId, "uploaded.txt", expected);
    await fs.writeFile(injectedPath, "FILE_PATH_CHANNEL_MUST_NOT_WIN", "utf8");
    try {
      const result = await runDesktop({
        fileId,
        filePath: injectedPath,
        content: Buffer.from("CONTENT_CHANNEL_MUST_NOT_WIN").toString("base64"),
      });

      expect(result.ok).toBe(true);
      expect(result.text).toBe(expected);
      expect(result.text).not.toContain("FILE_PATH_CHANNEL_MUST_NOT_WIN");
      expect(result.text).not.toContain("CONTENT_CHANNEL_MUST_NOT_WIN");
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("非法 fileId → 返回结构化错误,不抛异常", async () => {
    const result = await run({ fileId: "not-a-uuid" });
    expect(result.ok).toBe(false);
    expect(result.failureKind).toBe("error");
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

  it("Desktop 仅传 filePath 时按真实扩展名补齐 MIME 并解析", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "parse-file-desktop-mime-"));
    const textPath = path.join(tempDir, "桌面附件.txt");
    await fs.writeFile(textPath, "FILE_PATH_ONLY_BODY", "utf8");
    try {
      const result = await runDesktop({ filePath: textPath });

      expect(result.text).toBe("FILE_PATH_ONLY_BODY");
      expect(result.metadata.wordCount).toBe("FILE_PATH_ONLY_BODY".length);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("Desktop filePath 扩展名未知时仍要求显式 MIME", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "parse-file-desktop-mime-"));
    const unknownPath = path.join(tempDir, "桌面附件.unknown");
    await fs.writeFile(unknownPath, "UNKNOWN_EXTENSION_BODY", "utf8");
    try {
      const result = await runDesktop({ filePath: unknownPath });

      expect(result.text).toContain("[Error]");
      expect(result.text).toContain("mimeType");
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });
});
