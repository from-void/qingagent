import { describe, it, expect, vi } from "vitest";

const nonRegularFsMock = vi.hoisted(() => ({
  path: "/__parse-file-mocked-device__",
  read: vi.fn(),
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    realpath: async (...args: Parameters<typeof actual.realpath>) => {
      if (args[0] === nonRegularFsMock.path) return nonRegularFsMock.path;
      return actual.realpath(...args);
    },
    open: async (...args: Parameters<typeof actual.open>) => {
      if (args[0] !== nonRegularFsMock.path) return actual.open(...args);
      return {
        stat: async () => ({ isFile: () => false, nlink: 1, size: 0 }),
        read: nonRegularFsMock.read,
        close: async () => undefined,
      } as unknown as Awaited<ReturnType<typeof actual.open>>;
    },
  };
});

import { parseFileTool } from "../tools/parseFile.js";
import { storeMaterialTool } from "../tools/storeMaterial.js";
import { createSessionScopedTools } from "../session/sessionTools.js";
import type { Material } from "../types/material.js";

// ---------------------------------------------------------------------------
// Helpers: extract the Zod schema from the Mastra tool and validate.
// ---------------------------------------------------------------------------

function validateToolInput(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  toolDef: { inputSchema?: unknown },
  input: unknown,
): { success: boolean; error?: string } {
  const schema = toolDef.inputSchema as
    | { parse: (v: unknown) => unknown }
    | undefined;
  if (!schema) {
    return { success: false, error: "Tool has no inputSchema" };
  }
  try {
    schema.parse(input);
    return { success: true };
  } catch (e) {
    return {
      success: false,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

async function executeParseFileOnDesktop(input: Record<string, unknown>): Promise<unknown> {
  const previousRuntime = process.env.QINGAGENT_RUNTIME;
  process.env.QINGAGENT_RUNTIME = "desktop";
  try {
    return await parseFileTool.execute!(input as never, {} as never);
  } finally {
    if (previousRuntime === undefined) delete process.env.QINGAGENT_RUNTIME;
    else process.env.QINGAGENT_RUNTIME = previousRuntime;
  }
}

const FILE_ACCESS_DENIED_RESULT = {
  text: "[Error] 文件不可访问",
  metadata: { pages: null, wordCount: 0, title: null },
};

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timeoutId = setTimeout(() => reject(new Error(`操作超过 ${timeoutMs}ms 仍未完成`)), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

// ---------------------------------------------------------------------------
// Tests: parseFile tool schema
// ---------------------------------------------------------------------------

describe("parseFile tool schema", () => {
  it("validates a correct input", () => {
    const input = {
      content: Buffer.from("hello world").toString("base64"),
      filename: "test.txt",
      mimeType: "text/plain",
    };
    const result = validateToolInput(parseFileTool, input);
    expect(result.success).toBe(true);
  });

  it("validates PDF input", () => {
    const input = {
      content: Buffer.from("fake-pdf-data").toString("base64"),
      filename: "document.pdf",
      mimeType: "application/pdf",
    };
    const result = validateToolInput(parseFileTool, input);
    expect(result.success).toBe(true);
  });

  it("validates DOCX input", () => {
    const input = {
      content: Buffer.from("fake-docx-data").toString("base64"),
      filename: "report.docx",
      mimeType:
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    };
    const result = validateToolInput(parseFileTool, input);
    expect(result.success).toBe(true);
  });

  it("accepts missing content when filePath and content are both optional", () => {
    // Both filePath and content are optional in the schema; the execute
    // function handles the "neither provided" case at runtime.
    const input = { filename: "test.txt", mimeType: "text/plain" };
    const result = validateToolInput(parseFileTool, input);
    expect(result.success).toBe(true);
  });

  it("accepts input with filePath instead of content", () => {
    const input = {
      filePath: "/uploads/session/test.txt",
      filename: "test.txt",
      mimeType: "text/plain",
    };
    const result = validateToolInput(parseFileTool, input);
    expect(result.success).toBe(true);
  });

  // CC 脱敏:filename/mimeType 改为 schema 可选(传 fileId 时由 resolver 补齐);
  // "传 filePath/content 却缺 filename/mimeType" 的兜底改在 execute 运行时报错
  // (见 parseFile-fileId.test.ts),schema 层不再拒。
  it("filename 可选(schema 层接受缺省)", () => {
    const input = { content: "aGVsbG8=", mimeType: "text/plain" };
    const result = validateToolInput(parseFileTool, input);
    expect(result.success).toBe(true);
  });

  it("mimeType 可选(schema 层接受缺省)", () => {
    const input = { content: "aGVsbG8=", filename: "test.txt" };
    const result = validateToolInput(parseFileTool, input);
    expect(result.success).toBe(true);
  });

  it("accepts fileId-only input(web 脱敏路径)", () => {
    const input = { fileId: "abcdef01-2345-4678-89ab-cdef01234567" };
    const result = validateToolInput(parseFileTool, input);
    expect(result.success).toBe(true);
  });

  it("空对象 schema 层接受(execute 运行时兜底报错)", () => {
    const result = validateToolInput(parseFileTool, {});
    expect(result.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Tests: storeMaterial tool schema
// ---------------------------------------------------------------------------

describe("storeMaterial tool schema", () => {
  it("validates a correct input", () => {
    const input = {
      filename: "article.pdf",
      mimeType: "application/pdf",
      text: "这是一篇文章的内容",
      pages: 5,
      wordCount: 1000,
      title: "论文标题",
    };
    const result = validateToolInput(storeMaterialTool, input);
    expect(result.success).toBe(true);
  });

  it("validates with null pages and title", () => {
    const input = {
      filename: "notes.txt",
      mimeType: "text/plain",
      text: "一些笔记内容",
      pages: null,
      wordCount: 50,
      title: null,
    };
    const result = validateToolInput(storeMaterialTool, input);
    expect(result.success).toBe(true);
  });

  it("validates with optional summary field", () => {
    const input = {
      filename: "article.pdf",
      mimeType: "application/pdf",
      text: "这是一篇文章的内容",
      pages: 5,
      wordCount: 1000,
      title: "论文标题",
      summary: "这篇文章讨论了人工智能的发展趋势",
    };
    const result = validateToolInput(storeMaterialTool, input);
    expect(result.success).toBe(true);
  });

  it("validates without summary field (optional)", () => {
    const input = {
      filename: "article.pdf",
      mimeType: "application/pdf",
      text: "这是一篇文章的内容",
      pages: 5,
      wordCount: 1000,
      title: "论文标题",
    };
    const result = validateToolInput(storeMaterialTool, input);
    expect(result.success).toBe(true);
  });

  it("accepts input without text (正文走引用,text 不再是入参)", () => {
    const input = {
      filename: "test.txt",
      mimeType: "text/plain",
      pages: null,
      title: null,
    };
    const result = validateToolInput(storeMaterialTool, input);
    expect(result.success).toBe(true);
  });

  it("accepts 网页素材:省略 pages/title(fetchArticle 场景,真 bug 回归)", () => {
    // 抓网页时模型常只传 filename/mimeType/summary,不传 pages/title。
    // 旧 schema pages 是 required(z.number().nullable() 必须传)→ validation failed,搅乱整轮。
    const input = {
      filename: "AI News - LinkedIn",
      mimeType: "text/html",
      summary: "一句话摘要",
    };
    const result = validateToolInput(storeMaterialTool, input);
    expect(result.success).toBe(true);
  });

  it("rejects missing filename", () => {
    const input = {
      mimeType: "text/plain",
      text: "content",
      pages: null,
      wordCount: 10,
      title: null,
    };
    const result = validateToolInput(storeMaterialTool, input);
    expect(result.success).toBe(false);
  });

  it("rejects empty object", () => {
    const result = validateToolInput(storeMaterialTool, {});
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Tests: summarizeMaterial tool schema (session-scoped closure)
// ---------------------------------------------------------------------------

describe("summarizeMaterial tool schema", () => {
  // Create a session-scoped instance for schema validation
  const { summarizeMaterial: summarizeMaterialTool } = createSessionScopedTools(new Map());

  it("validates a correct input", () => {
    const input = {
      materialId: "mat-123-abcd",
      summary: "这篇文章讨论了人工智能的发展趋势",
      angle: "技术分析",
    };
    const result = validateToolInput(summarizeMaterialTool, input);
    expect(result.success).toBe(true);
  });

  it("validates with null angle", () => {
    const input = {
      materialId: "mat-456-efgh",
      summary: "一篇关于写作技巧的文章",
      angle: null,
    };
    const result = validateToolInput(summarizeMaterialTool, input);
    expect(result.success).toBe(true);
  });

  it("rejects missing materialId", () => {
    const input = {
      summary: "some summary",
      angle: null,
    };
    const result = validateToolInput(summarizeMaterialTool, input);
    expect(result.success).toBe(false);
  });

  it("rejects missing summary", () => {
    const input = {
      materialId: "mat-123-abcd",
      angle: null,
    };
    const result = validateToolInput(summarizeMaterialTool, input);
    expect(result.success).toBe(false);
  });

  it("rejects empty object", () => {
    const result = validateToolInput(summarizeMaterialTool, {});
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Tests: readMaterial tool schema (session-scoped closure)
// ---------------------------------------------------------------------------

describe("readMaterial tool schema", () => {
  // Create a session-scoped instance for schema validation
  const { readMaterial: readMaterialTool } = createSessionScopedTools(new Map());

  it("validates full mode", () => {
    const input = {
      materialId: "mat-123-abcd",
      mode: "full",
    };
    const result = validateToolInput(readMaterialTool, input);
    expect(result.success).toBe(true);
  });

  it("validates summary mode", () => {
    const input = {
      materialId: "mat-123-abcd",
      mode: "summary",
    };
    const result = validateToolInput(readMaterialTool, input);
    expect(result.success).toBe(true);
  });

  it("rejects invalid mode", () => {
    const input = {
      materialId: "mat-123-abcd",
      mode: "partial",
    };
    const result = validateToolInput(readMaterialTool, input);
    expect(result.success).toBe(false);
  });

  it("rejects missing materialId", () => {
    const input = {
      mode: "full",
    };
    const result = validateToolInput(readMaterialTool, input);
    expect(result.success).toBe(false);
  });

  it("rejects missing mode", () => {
    const input = {
      materialId: "mat-123-abcd",
    };
    const result = validateToolInput(readMaterialTool, input);
    expect(result.success).toBe(false);
  });

  it("rejects empty object", () => {
    const result = validateToolInput(readMaterialTool, {});
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Tests: Material type structure
// ---------------------------------------------------------------------------

describe("Material type", () => {
  it("accepts a well-formed Material object", () => {
    const material: Material = {
      id: "mat-123-abcd",
      filename: "article.pdf",
      mimeType: "application/pdf",
      text: "这是文章全文内容",
      summary: "这是文章摘要",
      fileId: null,
      metadata: {
        pages: 10,
        wordCount: 5000,
        title: "文章标题",
      },
      createdAt: "2026-05-23T10:00:00Z",
      updatedAt: "2026-05-23T10:00:00Z",
    };

    expect(material.id).toBe("mat-123-abcd");
    expect(material.filename).toBe("article.pdf");
    expect(material.metadata.pages).toBe(10);
    expect(material.metadata.wordCount).toBe(5000);
    expect(material.summary).toBe("这是文章摘要");
  });

  it("accepts Material with null optional fields", () => {
    const material: Material = {
      id: "mat-456-efgh",
      filename: "notes.txt",
      mimeType: "text/plain",
      text: "一些笔记",
      summary: null,
      fileId: null,
      metadata: {
        pages: null,
        wordCount: 20,
        title: null,
      },
      createdAt: "2026-05-23T10:00:00Z",
      updatedAt: "2026-05-23T10:00:00Z",
    };

    expect(material.summary).toBeNull();
    expect(material.metadata.pages).toBeNull();
    expect(material.metadata.title).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Tests: storeMaterial execute — pure computation (no store dependency)
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ctx = {} as any; // Mastra ToolExecutionContext — not needed for unit tests

describe("storeMaterial execute — pure computation", () => {
  it("returns a materialId and stored=true", async () => {
    const raw = await storeMaterialTool.execute!(
      {
        filename: "article.txt",
        mimeType: "text/plain",
        pages: null,
        title: null,
      },
      ctx,
    );
    const result = raw as { materialId: string; stored: boolean };

    expect(result.stored).toBe(true);
    expect(result.materialId).toBeTruthy();
    // materialId should be a deterministic hash-based ID
    expect(result.materialId).toMatch(/^mat-[0-9a-f]{12}$/);
  });

  it("generates unique IDs for different filenames", async () => {
    const raw1 = await storeMaterialTool.execute!(
      { filename: "a.txt", mimeType: "text/plain", pages: null, title: null },
      ctx,
    );
    const raw2 = await storeMaterialTool.execute!(
      { filename: "b.txt", mimeType: "text/plain", pages: null, title: null },
      ctx,
    );
    const r1 = raw1 as { materialId: string };
    const r2 = raw2 as { materialId: string };

    expect(r1.materialId).not.toBe(r2.materialId);
  });

  it("same filename produces same materialId", async () => {
    const raw1 = await storeMaterialTool.execute!(
      { filename: "report.pdf", mimeType: "application/pdf", pages: 5, title: "Report" },
      ctx,
    );
    const raw2 = await storeMaterialTool.execute!(
      { filename: "report.pdf", mimeType: "application/pdf", pages: 6, title: "Report Updated" },
      ctx,
    );
    const r1 = raw1 as { materialId: string };
    const r2 = raw2 as { materialId: string };

    expect(r1.materialId).toBe(r2.materialId);
  });
});

// ---------------------------------------------------------------------------
// Tests: readMaterial execute — session-scoped closure returns real data
// ---------------------------------------------------------------------------

describe("readMaterial execute — session-scoped closure", () => {
  const materials = new Map<string, Material>();
  materials.set("mat-read-1", {
    id: "mat-read-1",
    filename: "article.pdf",
    mimeType: "application/pdf",
    text: "这是文章全文内容，包含很多段落。",
    summary: "这是文章摘要",
    fileId: null,
    metadata: { pages: 10, wordCount: 5000, title: "文章标题" },
    createdAt: "2026-05-23T10:00:00Z",
    updatedAt: "2026-05-23T10:00:00Z",
  });
  materials.set("mat-read-2", {
    id: "mat-read-2",
    filename: "notes.txt",
    mimeType: "text/plain",
    text: "一些笔记内容",
    summary: null,
    fileId: null,
    metadata: { pages: null, wordCount: 20, title: null },
    createdAt: "2026-05-23T10:00:00Z",
    updatedAt: "2026-05-23T10:00:00Z",
  });
  materials.set("mat-read-image", {
    id: "mat-read-image",
    filename: "photo.png",
    mimeType: "image/png",
    text: "原始图片素材正文占位",
    summary: "图片摘要",
    visionSummary: "图片里有一张手写会议纪要。",
    fileId: "file-photo",
    metadata: { pages: null, wordCount: 12, title: "图片素材" },
    createdAt: "2026-05-23T10:00:00Z",
    updatedAt: "2026-05-23T10:00:00Z",
  });

  const { readMaterial } = createSessionScopedTools(materials);

  it("returns full text for existing material", async () => {
    const raw = await readMaterial.execute!(
      { materialId: "mat-read-1", mode: "full" },
      ctx,
    );
    const result = raw as { text: string; filename: string; wordCount: number };

    expect(result.text).toBe("这是文章全文内容，包含很多段落。");
    expect(result.filename).toBe("article.pdf");
    expect(result.wordCount).toBe(5000);
  });

  it("returns summary for existing material with summary", async () => {
    const raw = await readMaterial.execute!(
      { materialId: "mat-read-1", mode: "summary" },
      ctx,
    );
    const result = raw as { text: string; filename: string; wordCount: number };

    expect(result.text).toBe("这是文章摘要");
    expect(result.filename).toBe("article.pdf");
    expect(result.wordCount).toBe(5000);
  });

  it("returns full text with vision summary prefix when material has readImage result", async () => {
    const raw = await readMaterial.execute!(
      { materialId: "mat-read-image", mode: "full" },
      ctx,
    );
    const result = raw as { text: string; filename: string; wordCount: number };

    expect(result.text).toBe("【图像识别摘要】图片里有一张手写会议纪要。\n\n原始图片素材正文占位");
    expect(result.filename).toBe("photo.png");
    expect(result.wordCount).toBe(12);
  });

  it("summary mode does not include vision summary prefix", async () => {
    const raw = await readMaterial.execute!(
      { materialId: "mat-read-image", mode: "summary" },
      ctx,
    );
    const result = raw as { text: string; filename: string; wordCount: number };

    expect(result.text).toBe("图片摘要");
    expect(result.text).not.toContain("【图像识别摘要】");
  });

  it("returns '(No summary)' for material without summary", async () => {
    const raw = await readMaterial.execute!(
      { materialId: "mat-read-2", mode: "summary" },
      ctx,
    );
    const result = raw as { text: string; filename: string; wordCount: number };

    expect(result.text).toBe("(No summary)");
    expect(result.filename).toBe("notes.txt");
    expect(result.wordCount).toBe(20);
  });

  it("returns error for non-existent material", async () => {
    const raw = await readMaterial.execute!(
      { materialId: "nonexistent", mode: "full" },
      ctx,
    );
    const result = raw as { text: string; filename: string; wordCount: number };

    expect(result.text).toContain("[Error]");
    expect(result.text).toContain("nonexistent");
    expect(result.filename).toBe("");
    expect(result.wordCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Tests: summarizeMaterial execute — session-scoped closure updates state
// ---------------------------------------------------------------------------

describe("summarizeMaterial execute — session-scoped closure", () => {
  it("updates summary on existing material and returns updated=true", async () => {
    const materials = new Map<string, Material>();
    materials.set("mat-sum-1", {
      id: "mat-sum-1",
      filename: "article.txt",
      mimeType: "text/plain",
      text: "文章内容",
      summary: null,
      fileId: null,
      metadata: { pages: null, wordCount: 100, title: null },
      createdAt: "2026-05-23T10:00:00Z",
      updatedAt: "2026-05-23T10:00:00Z",
    });

    const { summarizeMaterial } = createSessionScopedTools(materials);

    const raw = await summarizeMaterial.execute!(
      { materialId: "mat-sum-1", summary: "A technical summary", angle: "technical" },
      ctx,
    );
    const result = raw as { updated: boolean };

    expect(result.updated).toBe(true);
    // Verify the material was actually updated in the map
    expect(materials.get("mat-sum-1")!.summary).toBe("A technical summary");
    expect(materials.get("mat-sum-1")!.updatedAt).not.toBe("2026-05-23T10:00:00Z");
  });

  it("returns updated=false for non-existent material", async () => {
    const materials = new Map<string, Material>();
    const { summarizeMaterial } = createSessionScopedTools(materials);

    const raw = await summarizeMaterial.execute!(
      { materialId: "nonexistent", summary: "some summary", angle: null },
      ctx,
    );
    const result = raw as { updated: boolean };

    expect(result.updated).toBe(false);
  });

  it("overwrites previous summary", async () => {
    const materials = new Map<string, Material>();
    materials.set("mat-sum-2", {
      id: "mat-sum-2",
      filename: "notes.txt",
      mimeType: "text/plain",
      text: "笔记内容",
      summary: "旧摘要",
      fileId: null,
      metadata: { pages: null, wordCount: 20, title: null },
      createdAt: "2026-05-23T10:00:00Z",
      updatedAt: "2026-05-23T10:00:00Z",
    });

    const { summarizeMaterial } = createSessionScopedTools(materials);

    await summarizeMaterial.execute!(
      { materialId: "mat-sum-2", summary: "新摘要", angle: null },
      ctx,
    );

    expect(materials.get("mat-sum-2")!.summary).toBe("新摘要");
  });
});

// ---------------------------------------------------------------------------
// Tests: parseFile execute — TXT parsing
// ---------------------------------------------------------------------------

describe("parseFile execute — TXT", () => {
  it("extracts plain text from a base64-encoded TXT file", async () => {
    const content = Buffer.from("这是一段测试文本内容").toString("base64");
    const result = await executeParseFileOnDesktop({
      content,
      filename: "test.txt",
      mimeType: "text/plain",
    });
    expect(result).toBeDefined();
    const r = result as { text: string; metadata: { pages: number | null; wordCount: number; title: string | null } };
    expect(r.text).toBe("这是一段测试文本内容");
    expect(r.metadata.pages).toBeNull();
    expect(r.metadata.wordCount).toBeGreaterThan(0);
  });

  it("extracts plain text from a markdown file", async () => {
    const md = "# Title\n\nSome **bold** text.";
    const content = Buffer.from(md).toString("base64");
    const result = await executeParseFileOnDesktop({
      content,
      filename: "readme.md",
      mimeType: "text/markdown",
    });
    expect(result).toBeDefined();
    const r = result as { text: string; metadata: { pages: number | null } };
    expect(r.text).toBe(md);
    expect(r.metadata.pages).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Tests: parseFile execute — filePath mode
// ---------------------------------------------------------------------------

describe("parseFile execute — filePath mode", () => {
  it("reads a real file from disk via filePath", async () => {
    const { writeFile, mkdir } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");

    const tmpDir = join(tmpdir(), `parseFile-test-${Date.now()}`);
    await mkdir(tmpDir, { recursive: true });

    const filePath = join(tmpDir, "sample.txt");
    await writeFile(filePath, "Hello from disk");

    const result = await executeParseFileOnDesktop({
      filePath,
      filename: "sample.txt",
      mimeType: "text/plain",
    });
    expect(result).toBeDefined();
    const r = result as { text: string; metadata: { pages: number | null; wordCount: number } };
    expect(r.text).toBe("Hello from disk");
    expect(r.metadata.wordCount).toBeGreaterThan(0);

    // Cleanup
    const { rm } = await import("node:fs/promises");
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("returns error when neither filePath nor content is provided", async () => {
    const result = await executeParseFileOnDesktop({
      filename: "orphan.txt",
      mimeType: "text/plain",
    });
    expect(result).toBeDefined();
    const r = result as { text: string; metadata: { wordCount: number } };
    expect(r.text).toContain("[Error]");
    expect(r.text).toContain("filePath");
    expect(r.metadata.wordCount).toBe(0);
  });

  it("throws when filePath points to a non-existent file", async () => {
    await expect(
      executeParseFileOnDesktop({
        filePath: "/tmp/nonexistent-file-" + Date.now() + ".txt",
        filename: "missing.txt",
        mimeType: "text/plain",
      }),
    ).rejects.toThrow();
  });

  it("prefers filePath over content when both are provided", async () => {
    const { writeFile, mkdir, rm } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");

    const tmpDir = join(tmpdir(), `parseFile-prefer-${Date.now()}`);
    await mkdir(tmpDir, { recursive: true });

    const filePath = join(tmpDir, "disk.txt");
    await writeFile(filePath, "from disk");

    const result = await executeParseFileOnDesktop({
      filePath,
      content: Buffer.from("from base64").toString("base64"),
      filename: "disk.txt",
      mimeType: "text/plain",
    });
    const r = result as { text: string };
    // filePath takes precedence
    expect(r.text).toBe("from disk");

    await rm(tmpDir, { recursive: true, force: true });
  });

  it("rejects a FIFO without a writer instead of blocking", async () => {
    const { execFile } = await import("node:child_process");
    const { mkdtemp, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const tmpDir = await mkdtemp(join(tmpdir(), "parseFile-fifo-"));
    const fifoPath = join(tmpDir, "untrusted.txt");

    try {
      await new Promise<void>((resolve, reject) => {
        execFile("mkfifo", [fifoPath], (error) => (error ? reject(error) : resolve()));
      });

      await expect(
        withTimeout(
          executeParseFileOnDesktop({
            filePath: fifoPath,
            filename: "untrusted.txt",
            mimeType: "text/plain",
          }),
          2_000,
        ),
      ).resolves.toEqual(FILE_ACCESS_DENIED_RESULT);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("rejects a character device as a non-regular file without reading it", async () => {
    const { existsSync } = await import("node:fs");
    const devicePath = existsSync("/dev/zero") ? "/dev/zero" : nonRegularFsMock.path;
    if (devicePath === "/dev/zero") {
      const { stat } = await import("node:fs/promises");
      expect((await stat(devicePath)).isCharacterDevice()).toBe(true);
    } else {
      nonRegularFsMock.read.mockClear();
    }

    await expect(
      withTimeout(
        executeParseFileOnDesktop({
          filePath: devicePath,
          filename: "zero.txt",
          mimeType: "text/plain",
        }),
        2_000,
      ),
    ).resolves.toEqual(FILE_ACCESS_DENIED_RESULT);
    if (devicePath === nonRegularFsMock.path) expect(nonRegularFsMock.read).not.toHaveBeenCalled();
  });

  it("rejects a regular file larger than the desktop byte limit", async () => {
    const { mkdtemp, open, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const tmpDir = await mkdtemp(join(tmpdir(), "parseFile-large-"));
    const filePath = join(tmpDir, "oversized.txt");
    const handle = await open(filePath, "w");

    try {
      await handle.truncate(64 * 1024 * 1024 + 1);
    } finally {
      await handle.close();
    }

    try {
      await expect(
        executeParseFileOnDesktop({
          filePath,
          filename: "oversized.txt",
          mimeType: "text/plain",
        }),
      ).resolves.toEqual(FILE_ACCESS_DENIED_RESULT);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });
});
