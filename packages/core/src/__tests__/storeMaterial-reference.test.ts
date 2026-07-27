import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BridgeFrame } from "@qingagent/contract-ts";
import fs from "node:fs/promises";
import path from "node:path";
import { parseFileTool } from "../tools/parseFile.js";
import { UPLOADS_BASE } from "../session/uploadFileResolver.js";

// storeMaterial 不再让模型传正文(避免吐几万字、生成巨慢)。正文走"引用本地已提取内容":
//   - parseFile 解析的全文 → bridge 按 filename 缓存 → storeMaterial 按名引用;
//   - fetchArticle 抓取的全文 → 无天然 filename → 回退"本轮最近一次提取"兜底引用。
//   - webSearch 搜索即抓取的全文 → bridge 按 url/title 缓存 → storeMaterial 按名引用。
// 本测试用不带 text 的 storeMaterial 参数,断言落库正文等于上游提取的全文。

vi.mock("../mastra.js", () => ({
  mastra: {
    getLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
    getMemory: () => null,
  },
  getObservability: () => null,
}));

vi.mock("../agents/qingagent.js", () => ({
  getQingagentSkills: vi.fn(async () => ({
    maybeRefresh: vi.fn(async () => {}),
    has: vi.fn(async () => false),
  })),
  qingagentAgent: { stream: vi.fn(), resumeStream: vi.fn() },
}));

async function* streamOf(...chunks: unknown[]): AsyncGenerator<unknown> {
  for (const chunk of chunks) yield chunk;
}
async function drain(gen: AsyncGenerator<BridgeFrame>): Promise<void> {
  for await (const _ of gen) {
    void _;
  }
}
async function collectFrames(gen: AsyncGenerator<BridgeFrame>): Promise<BridgeFrame[]> {
  const frames: BridgeFrame[] = [];
  for await (const frame of gen) frames.push(frame);
  return frames;
}

type ParseFileResult = {
  text: string;
  metadata: {
    pages: number | null;
    wordCount: number;
    title: string | null;
  };
};

const toolCall = (toolName: string, toolCallId: string, args: Record<string, unknown>) => ({
  type: "tool-call",
  payload: { toolName, toolCallId, args },
});
const toolResult = (
  toolName: string,
  toolCallId: string,
  args: Record<string, unknown>,
  result: Record<string, unknown>,
) => ({ type: "tool-result", payload: { toolName, toolCallId, args, result } });
const toolOutput = (
  toolCallId: string,
  output: Record<string, unknown>,
) => ({ type: "tool-output", payload: { toolCallId, output } });

async function executeParseFileFixture(
  filename: string,
  mimeType: string,
  buffer = Buffer.from([0, 1, 2, 3, 4, 5]),
): Promise<ParseFileResult> {
  const previousRuntime = process.env.QINGAGENT_RUNTIME;
  process.env.QINGAGENT_RUNTIME = "desktop";
  try {
    return (await parseFileTool.execute!(
      {
        content: buffer.toString("base64"),
        filename,
        mimeType,
      },
      {} as never,
    )) as ParseFileResult;
  } finally {
    if (previousRuntime === undefined) delete process.env.QINGAGENT_RUNTIME;
    else process.env.QINGAGENT_RUNTIME = previousRuntime;
  }
}

function storeMaterialFailureFor(frames: BridgeFrame[], toolCallId: string): BridgeFrame | undefined {
  for (let index = frames.length - 1; index >= 0; index -= 1) {
    const frame = frames[index];
    if (!frame) continue;
    if (
      frame.kind === "toolCallUpdated" &&
      frame.data.toolCallId === toolCallId &&
      frame.data.spec.status.kind === "failed"
    ) {
      return frame;
    }
  }
  return undefined;
}

describe("storeMaterial 正文走引用(不传 text)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("parseFile 文件过大时工具卡进入失败态并保留真实原因", async () => {
    const { createSession, processAgentStream } = await import("../bridge/index.js");
    const state = createSession("parse-file-too-large-card");
    const frames = await collectFrames(
      processAgentStream(
        streamOf(
          toolCall("parseFile", "p-large", { filePath: "/x/oversized.pdf" }),
          toolResult("parseFile", "p-large", { filePath: "/x/oversized.pdf" }, {
            ok: false,
            error: "文件过大（上限 64MiB）",
            errorCode: "FILE_TOO_LARGE",
            text: "[Error] 文件过大（上限 64MiB）",
            metadata: { pages: null, wordCount: 0, title: null },
          }),
        ),
        { state, agentMessageId: "m", streamId: "s-large", runId: "r" },
      ),
    );

    const failed = storeMaterialFailureFor(frames, "p-large");
    expect(failed?.kind).toBe("toolCallUpdated");
    if (failed?.kind === "toolCallUpdated" && failed.data.spec.status.kind === "failed") {
      expect(failed.data.spec.status.data.reason).toBe("文件过大（上限 64MiB）");
    } else {
      throw new Error("parseFile 超限结果未进入失败态");
    }
  });

  it("parseFile→storeMaterial:按 filename 引用 parseFile 全文落库", async () => {
    const { createSession, processAgentStream } = await import("../bridge/index.js");
    const state = createSession("ref-parse");
    const FULL = "这是 parseFile 提取出来的很长正文内容。".repeat(80);

    await drain(
      processAgentStream(
        streamOf(
          toolCall("parseFile", "p1", { filePath: "/x/a.pdf", filename: "a.pdf" }),
          toolResult("parseFile", "p1", { filename: "a.pdf" }, {
            text: FULL,
            wordCount: FULL.length,
            pages: 1,
          }),
          // storeMaterial 参数里完全没有 text —— 正文靠引用接力
          toolCall("storeMaterial", "s1", {
            filename: "a.pdf",
            mimeType: "application/pdf",
            pages: 1,
            title: null,
          }),
          toolResult(
            "storeMaterial",
            "s1",
            { filename: "a.pdf", mimeType: "application/pdf", pages: 1, title: null },
            { materialId: "mat-parse", stored: true },
          ),
        ),
        { state, agentMessageId: "m", streamId: "s-parse", runId: "r" },
      ),
    );

    const mat = state.materials.get("mat-parse");
    expect(mat).toBeTruthy();
    expect(mat?.text).toBe(FULL); // 引用 parseFile 全文,非模型参数
    expect(mat?.metadata.wordCount).toBe(FULL.length);
    expect(mat?.metadata.parseState).toBe("ready");
    expect(mat?.metadata.parseError).toBeNull();
  }, 10_000);

  it("服务重启后提取缓存为空时，storeMaterial 复用已有素材正文", async () => {
    const { createSession, processAgentStream } = await import("../bridge/index.js");
    const state = createSession("ref-restart-existing-material");
    const oldText = "重启前已经持久化的素材正文。".repeat(40);
    state.materials.set("mat-restart", {
      id: "mat-restart",
      filename: "重启素材.pdf",
      mimeType: "application/pdf",
      text: oldText,
      summary: "旧摘要",
      fileId: "file-restart",
      metadata: {
        pages: 2,
        wordCount: oldText.length,
        title: "重启素材",
        sourceUrl: null,
      },
      createdAt: "2026-07-26T00:00:00.000Z",
      updatedAt: "2026-07-26T00:00:00.000Z",
    });
    state._extractedTexts = new Map();

    const frames = await collectFrames(
      processAgentStream(
        streamOf(
          toolCall("storeMaterial", "s-restart", {
            filename: "重启素材.pdf",
            mimeType: "application/pdf",
            summary: "重启后更新摘要",
          }),
          toolResult("storeMaterial", "s-restart", {
            filename: "重启素材.pdf",
            mimeType: "application/pdf",
            summary: "重启后更新摘要",
          }, { materialId: "mat-restart", stored: true }),
        ),
        { state, agentMessageId: "m", streamId: "s-restart", runId: "r" },
      ),
    );

    expect(storeMaterialFailureFor(frames, "s-restart")).toBeUndefined();
    expect(state.materials.get("mat-restart")).toMatchObject({
      text: oldText,
      summary: "重启后更新摘要",
      fileId: "file-restart",
      createdAt: "2026-07-26T00:00:00.000Z",
    });
  });

  it("本轮没有提取事件且没有旧正文时，提示重新解析或抓取", async () => {
    const { createSession, processAgentStream } = await import("../bridge/index.js");
    const state = createSession("ref-restart-missing-text");
    state._extractedTexts = new Map();

    const frames = await collectFrames(
      processAgentStream(
        streamOf(
          toolCall("storeMaterial", "s-missing", {
            filename: "尚未恢复.pdf",
            mimeType: "application/pdf",
          }),
          toolResult("storeMaterial", "s-missing", {
            filename: "尚未恢复.pdf",
            mimeType: "application/pdf",
          }, { materialId: "mat-missing", stored: true }),
        ),
        { state, agentMessageId: "m", streamId: "s-missing", runId: "r" },
      ),
    );

    const failed = storeMaterialFailureFor(frames, "s-missing");
    expect(failed?.kind).toBe("toolCallUpdated");
    if (failed?.kind === "toolCallUpdated" && failed.data.spec.status.kind === "failed") {
      expect(failed.data.spec.status.data.reason).toBe(
        "未找到该素材的正文（可能因服务重启丢失临时解析结果），请重新解析文件或重新抓取链接。",
      );
    } else {
      throw new Error("完全无正文时 storeMaterial 未进入失败态");
    }
    expect(state.materials.has("mat-missing")).toBe(false);
  });

  it("parseFile→storeMaterial:模型改形 filename 时仍沿用上传 fileId", async () => {
    const { createSession, processAgentStream } = await import("../bridge/index.js");
    const state = createSession("ref-parse-file-id-mismatch");
    const uploadFileId = "11111111-1111-4111-8111-111111111111";
    const uploadFilename = '工伤"银行".pdf';
    const modelFilename = "工伤“银行”.pdf";
    const FULL = "上传文件解析出的正文，后续模型可能把文件名里的直引号改成弯引号。".repeat(30);

    const frames = await collectFrames(
      processAgentStream(
        streamOf(
          toolCall("parseFile", "p-file-id", {
            fileId: uploadFileId,
            filename: uploadFilename,
            mimeType: "application/pdf",
          }),
          toolResult("parseFile", "p-file-id", {
            fileId: uploadFileId,
            filename: uploadFilename,
            mimeType: "application/pdf",
          }, {
            text: FULL,
            wordCount: FULL.length,
            pages: 1,
          }),
          toolCall("storeMaterial", "s-file-id", {
            filename: modelFilename,
            mimeType: "application/pdf",
            pages: 1,
            title: null,
          }),
          toolResult(
            "storeMaterial",
            "s-file-id",
            { filename: modelFilename, mimeType: "application/pdf", pages: 1, title: null },
            { materialId: "mat-file-id", stored: true },
          ),
        ),
        { state, agentMessageId: "m", streamId: "s-file-id", runId: "r" },
      ),
    );

    const mat = state.materials.get("mat-file-id");
    expect(mat).toBeTruthy();
    expect(mat?.filename).toBe(modelFilename);
    expect(mat?.text).toBe(FULL);
    expect(mat?.fileId).toBe(uploadFileId);
    expect([...state.materials.values()].map((material) => material.fileId)).toEqual([uploadFileId]);

    const upserted = frames.filter((frame) => frame.kind === "resourceUpserted");
    expect(upserted).toHaveLength(1);
    expect(upserted[0]?.kind).toBe("resourceUpserted");
    if (upserted[0]?.kind === "resourceUpserted") {
      const metadata = upserted[0].data.resource.metadata as {
        fileId?: unknown;
        updatedAt?: unknown;
      };
      expect(metadata.fileId).toBe(uploadFileId);
      expect(metadata.updatedAt).toBe(mat?.updatedAt);
      expect(upserted[0].data.resource.displayName).toBe(modelFilename);
    }
  }, 10_000);

  it("fetchArticle→storeMaterial:filename 与缓存键不同,靠'最近一次提取'兜底引用", async () => {
    const { createSession, processAgentStream } = await import("../bridge/index.js");
    const state = createSession("ref-fetch");
    const WEB = "这是 fetchArticle 抓回来的网页正文。".repeat(60);

    await drain(
      processAgentStream(
        streamOf(
          toolCall("fetchArticle", "f1", { url: "https://example.com/a" }),
          toolResult("fetchArticle", "f1", { url: "https://example.com/a" }, {
            ok: true,
            text: WEB,
            wordCount: WEB.length,
            title: "网页标题",
          }),
          // filename 用标题(不在 parsedFileFullText 里) → 走 lastExtractedFullText 兜底
          toolCall("storeMaterial", "s2", {
            filename: "网页标题",
            mimeType: "text/html",
            pages: null,
            title: "网页标题",
          }),
          toolResult(
            "storeMaterial",
            "s2",
            { filename: "网页标题", mimeType: "text/html", pages: null, title: "网页标题" },
            { materialId: "mat-web", stored: true },
          ),
        ),
        { state, agentMessageId: "m", streamId: "s-fetch", runId: "r" },
      ),
    );

    const mat = state.materials.get("mat-web");
    expect(mat).toBeTruthy();
    expect(mat?.text).toBe(WEB); // 引用抓取全文,非模型参数
  });

  it("p08 串台回归:多文件解析后键未命中绝不兜底——宁可空正文也不绑成别的素材", async () => {
    const { createSession, processAgentStream } = await import("../bridge/index.js");
    const state = createSession("ref-crosstalk");
    const FULL_A = "甲文件的独有正文。".repeat(50);
    const FULL_B = "乙文件的独有正文。".repeat(50);

    const frames = await collectFrames(
      processAgentStream(
        streamOf(
          toolCall("parseFile", "p1", { filePath: "/x/a.txt", filename: "a.txt" }),
          toolResult("parseFile", "p1", { filename: "a.txt" }, { text: FULL_A, wordCount: 1 }),
          toolCall("parseFile", "p2", { filePath: "/x/b.txt", filename: "b.txt" }),
          toolResult("parseFile", "p2", { filename: "b.txt" }, { text: FULL_B, wordCount: 1 }),
          // 三次落库:两次精确命中,一次自创 filename(两个缓存键都不匹配)
          toolCall("storeMaterial", "s1", { filename: "a.txt", mimeType: "text/plain" }),
          toolResult("storeMaterial", "s1", { filename: "a.txt", mimeType: "text/plain" }, { materialId: "mat-a", stored: true }),
          toolCall("storeMaterial", "s2", { filename: "b.txt", mimeType: "text/plain" }),
          toolResult("storeMaterial", "s2", { filename: "b.txt", mimeType: "text/plain" }, { materialId: "mat-b", stored: true }),
          toolCall("storeMaterial", "s3", { filename: "模型自创名.txt", mimeType: "text/plain" }),
          toolResult("storeMaterial", "s3", { filename: "模型自创名.txt", mimeType: "text/plain" }, { materialId: "mat-c", stored: true }),
        ),
        { state, agentMessageId: "m", streamId: "s-ct", runId: "r" },
      ),
    );

    expect(state.materials.get("mat-a")?.text).toBe(FULL_A);
    expect(state.materials.get("mat-b")?.text).toBe(FULL_B);
    // 旧实现这里会串成 FULL_B(最近一次提取);现在拒绝兜底,且不再生成空素材。
    expect(state.materials.has("mat-c")).toBe(false);
    const failed = storeMaterialFailureFor(frames, "s3");
    expect(failed?.kind).toBe("toolCallUpdated");
    if (failed?.kind === "toolCallUpdated") {
      expect(failed.data.spec.status.kind).toBe("failed");
      if (failed.data.spec.status.kind === "failed") {
        expect(failed.data.spec.status.data.retriable).toBe(false);
        expect(failed.data.spec.status.data.reason).toContain("素材正文为空");
      }
    }
  });

  it("parseFile 返回旧 xls/ppt unsupported 时确定性落 error 素材且不缓存为正文", async () => {
    const { createSession, processAgentStream } = await import("../bridge/index.js");
    const cases = [
      {
        sessionId: "ref-unsupported-xls",
        filename: "legacy.xls",
        mimeType: "application/vnd.ms-excel",
        result: await executeParseFileFixture("legacy.xls", "application/vnd.ms-excel"),
        fileId: "legacy-xls-upload",
        materialId: "mat-xls",
        parseToolCallId: "p-xls",
        storeToolCallId: "s-xls",
      },
      {
        sessionId: "ref-unsupported-ppt",
        filename: "legacy.ppt",
        mimeType: "application/vnd.ms-powerpoint",
        result: await executeParseFileFixture("legacy.ppt", "application/vnd.ms-powerpoint"),
        fileId: "legacy-ppt-upload",
        materialId: "mat-ppt",
        parseToolCallId: "p-ppt",
        storeToolCallId: "s-ppt",
      },
    ];

    expect(cases[0]?.result.text).toContain("[Unsupported]");
    expect(cases[1]?.result.text).toContain("[Unsupported]");

    for (const c of cases) {
      const state = createSession(c.sessionId);
      const frames = await collectFrames(
        processAgentStream(
          streamOf(
            toolCall("parseFile", c.parseToolCallId, {
              fileId: c.fileId,
              filePath: `/x/${c.filename}`,
              filename: c.filename,
              mimeType: c.mimeType,
            }),
            toolResult("parseFile", c.parseToolCallId, {
              fileId: c.fileId,
              filename: c.filename,
              mimeType: c.mimeType,
            }, c.result),
            toolCall("storeMaterial", c.storeToolCallId, {
              filename: c.filename,
              mimeType: c.mimeType,
            }),
            toolResult("storeMaterial", c.storeToolCallId, {
              filename: c.filename,
              mimeType: c.mimeType,
            }, { materialId: c.materialId, stored: true }),
          ),
          { state, agentMessageId: "m", streamId: `s-${c.materialId}`, runId: "r" },
        ),
      );

      const errorMaterial = [...state.materials.values()].find(
        (material) => material.fileId === c.fileId,
      );
      expect(errorMaterial).toBeTruthy();
      expect(errorMaterial?.text).toBe("");
      expect(errorMaterial?.metadata.parseState).toBe("error");
      expect(errorMaterial?.metadata.parseError).toContain("不支持解析");
      expect(errorMaterial?.metadata.parseError).toContain(`旧版 .${c.filename.split(".").pop()}`);
      expect(frames.some((frame) =>
        frame.kind === "resourceUpserted" &&
        frame.data.resource.resourceRef.id === errorMaterial?.id &&
        (frame.data.resource.metadata as { parseState?: unknown }).parseState === "error"
      )).toBe(true);
      expect(state.materials.has(c.materialId)).toBe(false);
      expect(frames.some((frame) =>
        frame.kind === "resourceUpserted" &&
        frame.data.resource.resourceRef.id === c.materialId
      )).toBe(false);
      const failed = storeMaterialFailureFor(frames, c.storeToolCallId);
      expect(failed?.kind).toBe("toolCallUpdated");
      if (failed?.kind === "toolCallUpdated") {
        expect(failed.data.spec.status.kind).toBe("failed");
        if (failed.data.spec.status.kind === "failed") {
          expect(failed.data.spec.status.data.retriable).toBe(false);
          expect(failed.data.spec.status.data.reason).toContain("素材正文为空");
        }
      }
    }
  });

  it("parseFile 失败 tool-result 按 fileId 稳定 upsert error material 并发 resourceUpserted", async () => {
    const { createSession, processAgentStream } = await import("../bridge/index.js");
    const state = createSession("ref-parse-error-material");

    const frames = await collectFrames(
      processAgentStream(
        streamOf(
          toolCall("parseFile", "p-a1", {
            fileId: "file-a",
            filename: "same.pdf",
            mimeType: "application/pdf",
          }),
          toolResult("parseFile", "p-a1", {
            fileId: "file-a",
            filename: "same.pdf",
            mimeType: "application/pdf",
          }, {
            ok: false,
            text: "[Error] Failed to parse PDF file: damaged A",
            failureKind: "error",
            metadata: { pages: null, wordCount: 0, title: null },
          }),
          toolCall("parseFile", "p-b", {
            fileId: "file-b",
            filename: "same.pdf",
            mimeType: "application/pdf",
          }),
          toolResult("parseFile", "p-b", {
            fileId: "file-b",
            filename: "same.pdf",
            mimeType: "application/pdf",
          }, {
            ok: false,
            text: "[Unsupported] 暂不支持该文件。",
            failureKind: "unsupported",
            metadata: { pages: null, wordCount: 0, title: null },
          }),
          toolCall("parseFile", "p-a2", {
            fileId: "file-a",
            filename: "same.pdf",
            mimeType: "application/pdf",
          }),
          toolResult("parseFile", "p-a2", {
            fileId: "file-a",
            filename: "same.pdf",
            mimeType: "application/pdf",
          }, {
            ok: false,
            text: "[Error] Failed to parse PDF file: damaged A again",
            failureKind: "error",
            metadata: { pages: null, wordCount: 0, title: null },
          }),
        ),
        { state, agentMessageId: "m", streamId: "s-parse-error", runId: "r" },
      ),
    );

    const materials = [...state.materials.values()].sort((a, b) => (a.fileId ?? "").localeCompare(b.fileId ?? ""));
    expect(materials).toHaveLength(2);
    expect(materials.map((material) => material.fileId)).toEqual(["file-a", "file-b"]);
    expect(materials[0]?.filename).toBe("same.pdf");
    expect(materials[0]?.text).toBe("");
    expect(materials[0]?.metadata.parseState).toBe("error");
    expect(materials[0]?.metadata.parseError).toContain("damaged A again");
    expect(materials[1]?.metadata.parseError).toContain("不支持解析");

    const upserted = frames.filter((frame) => frame.kind === "resourceUpserted");
    expect(upserted).toHaveLength(3);
    expect(upserted.some((frame) =>
      frame.kind === "resourceUpserted" &&
      frame.data.resource.resourceRef.id === materials[0]?.id &&
      (frame.data.resource.metadata as { fileId?: unknown; parseState?: unknown }).fileId === "file-a" &&
      (frame.data.resource.metadata as { parseState?: unknown }).parseState === "error"
    )).toBe(true);
    const latestFileAFrame = [...upserted].reverse().find((frame) =>
      frame.kind === "resourceUpserted" &&
      frame.data.resource.resourceRef.id === materials[0]?.id &&
      (frame.data.resource.metadata as { fileId?: unknown }).fileId === "file-a"
    );
    expect(latestFileAFrame?.kind).toBe("resourceUpserted");
    if (latestFileAFrame?.kind === "resourceUpserted") {
      expect((latestFileAFrame.data.resource.metadata as { updatedAt?: unknown }).updatedAt)
        .toBe(materials[0]?.updatedAt);
    }
  });

  it("Desktop filePath-only 失败素材沿用上传注册表真实 UUID", async () => {
    const { createSession, processAgentStream, stableErrorMaterialId } = await import(
      "../bridge/index.js"
    );
    const state = createSession("ref-desktop-file-path-binding");
    const fileId = "88888888-8888-4888-8888-888888888888";
    const filename = "desktop-report.txt";
    const fileDir = path.resolve(UPLOADS_BASE, fileId);
    const registeredPath = path.resolve(fileDir, filename);
    const normalizedVariant = `${fileDir}/nested/../${filename}`;
    await fs.mkdir(fileDir, { recursive: true });
    await fs.writeFile(registeredPath, "DESKTOP_UPLOAD_BODY", "utf8");

    try {
      await drain(
        processAgentStream(
          streamOf(
            toolCall("parseFile", "p-desktop-path", {
              filePath: normalizedVariant,
            }),
            toolResult("parseFile", "p-desktop-path", {
              filePath: normalizedVariant,
            }, {
              ok: false,
              text: "[Error] Failed to parse text file",
              failureKind: "error",
              metadata: { pages: null, wordCount: 0, title: null },
            }),
          ),
          {
            state,
            agentMessageId: "m",
            streamId: "s-desktop-path",
            runId: "r",
            fileIds: [fileId],
          },
        ),
      );

      const material = state.materials.get(stableErrorMaterialId(fileId));
      expect(material).toMatchObject({
        fileId,
        filename,
        mimeType: "text/plain",
      });
      expect(
        [...state.materials.values()].some((candidate) => candidate.fileId === filename),
      ).toBe(false);
    } finally {
      await fs.rm(fileDir, { recursive: true, force: true });
    }
  });

  it("parseFile 空正文不生成 error 素材，storeMaterial 仍拒绝空正文", async () => {
    const { createSession, processAgentStream } = await import("../bridge/index.js");
    const state = createSession("ref-empty-text");
    const frames = await collectFrames(
      processAgentStream(
        streamOf(
          toolCall("parseFile", "p-empty", {
            filePath: "/x/empty.txt",
            filename: "empty.txt",
            mimeType: "text/plain",
          }),
          toolResult("parseFile", "p-empty", {
            filename: "empty.txt",
            mimeType: "text/plain",
          }, { text: "", metadata: { pages: 1, wordCount: 0, title: null } }),
          toolCall("storeMaterial", "s-empty", {
            filename: "empty.txt",
            mimeType: "text/plain",
          }),
          toolResult("storeMaterial", "s-empty", {
            filename: "empty.txt",
            mimeType: "text/plain",
          }, { materialId: "mat-empty", stored: true }),
        ),
        { state, agentMessageId: "m", streamId: "s-empty", runId: "r" },
      ),
    );

    expect(state.materials.size).toBe(0);
    expect(frames.some((frame) => frame.kind === "resourceUpserted")).toBe(false);
    expect(storeMaterialFailureFor(frames, "s-empty")).toBeTruthy();
  });

  it("storeMaterial 拒绝把 Error/Unsupported 占位前缀当正文落库", async () => {
    const { createSession, processAgentStream } = await import("../bridge/index.js");
    const state = createSession("ref-placeholder-content");
    state._extractedTexts = new Map([
      ["bad.txt", { text: "[Error] Failed to parse text file: binary", sourceUrl: null, fileId: null }],
    ]);

    const frames = await collectFrames(
      processAgentStream(
        streamOf(
          toolCall("storeMaterial", "s-placeholder", {
            filename: "bad.txt",
            mimeType: "text/plain",
          }),
          toolResult("storeMaterial", "s-placeholder", {
            filename: "bad.txt",
            mimeType: "text/plain",
          }, { materialId: "mat-placeholder", stored: true }),
        ),
        { state, agentMessageId: "m", streamId: "s-placeholder", runId: "r" },
      ),
    );

    expect(state.materials.has("mat-placeholder")).toBe(false);
    expect(frames.some((frame) => frame.kind === "resourceUpserted")).toBe(false);
    expect(storeMaterialFailureFor(frames, "s-placeholder")).toBeTruthy();
  });

  it("p08 串台回归:多链接抓取按 url/title 精确绑定,各素材正文互不覆盖且带 sourceUrl", async () => {
    const { createSession, processAgentStream } = await import("../bridge/index.js");
    const state = createSession("ref-multifetch");
    const T1 = "第一个网站的独有正文。".repeat(40);
    const T2 = "第二个网站的独有正文。".repeat(40);

    await drain(
      processAgentStream(
        streamOf(
          toolCall("fetchArticle", "f1", { url: "https://a.example.com/1" }),
          toolResult("fetchArticle", "f1", { url: "https://a.example.com/1" }, { text: T1, title: "甲站文章" }),
          toolCall("fetchArticle", "f2", { url: "https://b.example.com/2" }),
          toolResult("fetchArticle", "f2", { url: "https://b.example.com/2" }, { text: T2, title: "乙站文章" }),
          // 模型惯用标题当 filename 落库——旧实现两份正文都会是 T2
          toolCall("storeMaterial", "s1", { filename: "甲站文章", mimeType: "text/html" }),
          toolResult("storeMaterial", "s1", { filename: "甲站文章", mimeType: "text/html" }, { materialId: "mat-1", stored: true }),
          toolCall("storeMaterial", "s2", { filename: "乙站文章", mimeType: "text/html" }),
          toolResult("storeMaterial", "s2", { filename: "乙站文章", mimeType: "text/html" }, { materialId: "mat-2", stored: true }),
        ),
        { state, agentMessageId: "m", streamId: "s-mf", runId: "r" },
      ),
    );

    expect(state.materials.get("mat-1")?.text).toBe(T1);
    expect(state.materials.get("mat-1")?.metadata.sourceUrl).toBe("https://a.example.com/1");
    expect(state.materials.get("mat-2")?.text).toBe(T2);
    expect(state.materials.get("mat-2")?.metadata.sourceUrl).toBe("https://b.example.com/2");
  });

  it("webSearch→storeMaterial:webSearch 结果正文按 url/title 缓存并可绑定素材", async () => {
    const { createSession, processAgentStream } = await import("../bridge/index.js");
    const state = createSession("ref-websearch");
    const WEB =
      "搜索结果抓取回来的网页正文，包含事实、背景、关键数据、影响分析和来源信息。".repeat(16);

    await drain(
      processAgentStream(
        streamOf(
          toolCall("webSearch", "w1", { query: "研究主题", count: 2 }),
          toolResult("webSearch", "w1", { query: "研究主题", count: 2 }, {
            ok: true,
            query: "研究主题",
            items: [
              {
                url: "https://search.example.com/a",
                title: "搜索文章 A",
                snippet: "摘要 A",
                status: "browser",
                wordCount: WEB.length,
                text: WEB,
              },
              {
                url: "https://search.example.com/b",
                title: "空壳文章 B",
                snippet: "摘要 B",
                status: "skipped",
                wordCount: 0,
                text: "",
              },
            ],
          }),
          toolCall("storeMaterial", "s1", {
            filename: "搜索文章 A",
            mimeType: "text/html",
            title: "搜索文章 A",
          }),
          toolResult(
            "storeMaterial",
            "s1",
            { filename: "搜索文章 A", mimeType: "text/html", title: "搜索文章 A" },
            { materialId: "mat-websearch", stored: true },
          ),
        ),
        { state, agentMessageId: "m", streamId: "s-websearch", runId: "r" },
      ),
    );

    expect(state.materials.get("mat-websearch")?.text).toBe(WEB);
    expect(state.materials.get("mat-websearch")?.metadata.sourceUrl).toBe(
      "https://search.example.com/a",
    );
  });

  it("research-fulltext→webSearch→storeMaterial:模型面节选不影响素材落全文", async () => {
    const { createSession, processAgentStream } = await import("../bridge/index.js");
    const state = createSession("ref-websearch-fulltext");
    const FULL =
      "旁路传入的搜索全文，包含完整事实、背景、关键数据、影响分析和来源信息。".repeat(180);
    const EXCERPT = FULL.slice(0, 2500);

    await drain(
      processAgentStream(
        streamOf(
          toolCall("webSearch", "w-full", { query: "长文研究", count: 1 }),
          toolOutput("w-full", {
            type: "research-fulltext",
            items: [
              {
                url: "https://search.example.com/full",
                title: "搜索长文",
                materialId: "mat-search-full",
                text: FULL,
              },
            ],
          }),
          toolResult("webSearch", "w-full", { query: "长文研究", count: 1 }, {
            ok: true,
            query: "长文研究",
            items: [
              {
                url: "https://search.example.com/full",
                title: "搜索长文",
                snippet: "摘要",
                status: "done",
                wordCount: FULL.length,
                materialId: "mat-search-full",
                truncated: true,
                text: EXCERPT,
              },
            ],
          }),
          toolCall("storeMaterial", "s-full", {
            filename: "搜索长文",
            mimeType: "text/html",
            title: "搜索长文",
          }),
          toolResult(
            "storeMaterial",
            "s-full",
            { filename: "搜索长文", mimeType: "text/html", title: "搜索长文" },
            { materialId: "mat-websearch-full", stored: true },
          ),
        ),
        { state, agentMessageId: "m", streamId: "s-websearch-full", runId: "r" },
      ),
    );

    expect(state.materials.get("mat-websearch-full")?.text).toBe(FULL);
    expect(state.materials.get("mat-websearch-full")?.text).not.toBe(EXCERPT);
    expect(state.materials.get("mat-websearch-full")?.metadata.sourceUrl).toBe(
      "https://search.example.com/full",
    );
  });

  it("research-fulltext→webSearch→storeMaterial:materialId 优先绑定全文,filename 写错也不串台", async () => {
    const { createSession, processAgentStream } = await import("../bridge/index.js");
    const state = createSession("ref-websearch-material-id");
    const OTHER_FULL =
      "另一条搜索结果的完整正文，不能被错误绑定到目标素材上。".repeat(160);
    const FULL =
      "materialId 精确命中的搜索全文，包含完整事实、背景、关键数据、影响分析和来源信息。".repeat(180);

    await drain(
      processAgentStream(
        streamOf(
          toolCall("webSearch", "w-mid", { query: "material id 研究", count: 2 }),
          toolOutput("w-mid", {
            type: "research-fulltext",
            items: [
              {
                url: "https://search.example.com/other",
                title: "另一篇文章",
                materialId: "mat-Y",
                text: OTHER_FULL,
              },
              {
                url: "https://search.example.com/mat-x",
                title: "目标文章",
                materialId: "mat-X",
                text: FULL,
              },
            ],
          }),
          toolResult("webSearch", "w-mid", { query: "material id 研究", count: 2 }, {
            ok: true,
            query: "material id 研究",
            items: [
              {
                url: "https://search.example.com/other",
                title: "另一篇文章",
                snippet: "另一篇摘要",
                status: "done",
                wordCount: OTHER_FULL.length,
                materialId: "mat-Y",
                truncated: true,
                text: OTHER_FULL.slice(0, 2500),
              },
              {
                url: "https://search.example.com/mat-x",
                title: "目标文章",
                snippet: "摘要",
                status: "done",
                wordCount: FULL.length,
                materialId: "mat-X",
                truncated: true,
                text: FULL.slice(0, 2500),
              },
            ],
          }),
          toolCall("storeMaterial", "s-mid", {
            materialId: "mat-X",
            filename: "错误文件名",
            mimeType: "text/html",
            title: "错误标题",
          }),
          toolResult(
            "storeMaterial",
            "s-mid",
            {
              materialId: "mat-X",
              filename: "错误文件名",
              mimeType: "text/html",
              title: "错误标题",
            },
            { materialId: "mat-X", stored: true },
          ),
        ),
        { state, agentMessageId: "m", streamId: "s-websearch-mid", runId: "r" },
      ),
    );

    expect(state.materials.get("mat-X")?.text).toBe(FULL);
    expect(state.materials.get("mat-X")?.text).not.toBe(OTHER_FULL);
    expect(state.materials.get("mat-X")?.metadata.sourceUrl).toBe(
      "https://search.example.com/mat-x",
    );
  });

  it("去扩展名宽容匹配:storeMaterial 丢了扩展名仍能命中 parseFile 缓存", async () => {
    const { createSession, processAgentStream } = await import("../bridge/index.js");
    const state = createSession("ref-stem");
    const FULL = "报告全文内容。".repeat(30);

    await drain(
      processAgentStream(
        streamOf(
          toolCall("parseFile", "p1", { filePath: "/x/年度报告.txt", filename: "年度报告.txt" }),
          toolResult("parseFile", "p1", { filename: "年度报告.txt" }, { text: FULL, wordCount: 1 }),
          toolCall("parseFile", "p2", { filePath: "/x/别的.txt", filename: "别的.txt" }),
          toolResult("parseFile", "p2", { filename: "别的.txt" }, { text: "别的内容", wordCount: 1 }),
          // 丢扩展名 + 本轮有两次提取(排除单提取兜底路径,验证的是 stem 匹配)
          toolCall("storeMaterial", "s1", { filename: "年度报告", mimeType: "text/plain" }),
          toolResult("storeMaterial", "s1", { filename: "年度报告", mimeType: "text/plain" }, { materialId: "mat-stem", stored: true }),
        ),
        { state, agentMessageId: "m", streamId: "s-stem", runId: "r" },
      ),
    );

    expect(state.materials.get("mat-stem")?.text).toBe(FULL);
  });

  it("summarizeMaterial 更新帧保留 metadata.fileId", async () => {
    const { createSession, processAgentStream } = await import("../bridge/index.js");
    const state = createSession("ref-summary-file-id");
    state.materials.set("mat-summary", {
      id: "mat-summary",
      filename: "summary.pdf",
      mimeType: "application/pdf",
      text: "全文",
      summary: "旧摘要",
      fileId: "33333333-3333-3333-3333-333333333333",
      metadata: {
        pages: 1,
        wordCount: 2,
        title: "Summary",
        sourceUrl: null,
      },
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });

    const frames = await collectFrames(
      processAgentStream(
        streamOf(
          toolCall("summarizeMaterial", "sum1", {
            materialId: "mat-summary",
            summary: "模型摘要",
          }),
          toolResult(
            "summarizeMaterial",
            "sum1",
            { materialId: "mat-summary", summary: "模型摘要" },
            { ok: true },
          ),
        ),
        { state, agentMessageId: "m", streamId: "s-summary", runId: "r" },
      ),
    );

    const updatedAt = state.materials.get("mat-summary")?.updatedAt;
    expect(state.materials.get("mat-summary")?.summary).toBe("模型摘要");
    expect(updatedAt).toEqual(expect.any(String));
    expect(frames).toContainEqual({
      kind: "resourceUpdated",
      data: {
        resourceRef: { id: "mat-summary", domain: { kind: "file" } },
        summary: "模型摘要",
        metadata: {
          pages: 1,
          wordCount: 2,
          title: "Summary",
          sourceUrl: null,
          fileId: "33333333-3333-3333-3333-333333333333",
          updatedAt,
        },
      },
    });
  });

  it("GitHub 搜索片段只有明确选择后才进缓存并可落库，且不与 read_file 串台", async () => {
    const { createSession, processAgentStream } = await import("../bridge/index.js");
    const state = createSession("github-fragment-selection");
    const fullText = "完整文件正文".repeat(30);
    const fragmentText = "用户明确选择的代码片段";

    await drain(processAgentStream(streamOf(
      toolCall("github_search_code", "search", { action: "search", owner: "o", repo: "r", query: "needle" }),
      toolResult("github_search_code", "search", {}, { ok: true, count: 1, hits: [{ fragmentId: "ghfrag-a", fragment: fragmentText }], rateLimit: {} }),
      toolCall("github_read_file", "read", { owner: "o", repo: "r", path: "full.ts" }),
      toolResult("github_read_file", "read", {}, { materialId: "github-full", title: "r/full.ts", text: fullText, sourceUrl: "https://github.test/full", rateLimit: {} }),
      toolCall("github_search_code", "select", { action: "select_fragment", owner: "o", repo: "r", query: "needle", fragmentId: "ghfrag-selected" }),
      toolResult("github_search_code", "select", {}, { ok: true, selected: true, materialId: "ghfrag-selected", title: "r/a.ts#L7", text: fragmentText, sourceUrl: "https://github.test/fragment", rateLimit: {} }),
      toolCall("storeMaterial", "store-fragment", { filename: "r/a.ts#L7", mimeType: "text/plain" }),
      toolResult("storeMaterial", "store-fragment", {}, { materialId: "stored-fragment", stored: true }),
      toolCall("storeMaterial", "store-full", { filename: "r/full.ts", mimeType: "text/plain" }),
      toolResult("storeMaterial", "store-full", {}, { materialId: "stored-full", stored: true }),
    ), { state, agentMessageId: "m", streamId: "s", runId: "r" }));

    expect(state._extractedTexts?.has("ghfrag-a")).toBe(false);
    expect(state.materials.get("stored-fragment")?.text).toBe(fragmentText);
    expect(state.materials.get("stored-full")?.text).toBe(fullText);
  });

  it("GitHub 空选择片段不进缓存且拒绝 store", async () => {
    const { createSession, processAgentStream } = await import("../bridge/index.js");
    const state = createSession("github-empty-fragment");
    const frames = await collectFrames(processAgentStream(streamOf(
      toolCall("github_search_code", "select", { action: "select_fragment", fragmentId: "ghfrag-empty" }),
      toolResult("github_search_code", "select", {}, { ok: true, selected: true, materialId: "ghfrag-empty", title: "r/a.ts#L1", text: "   ", sourceUrl: "https://github.test/empty", rateLimit: {} }),
      toolCall("storeMaterial", "store", { filename: "r/a.ts#L1", mimeType: "text/plain" }),
      toolResult("storeMaterial", "store", {}, { materialId: "stored-empty", stored: true }),
    ), { state, agentMessageId: "m", streamId: "s", runId: "r" }));
    expect(state._extractedTexts?.has("ghfrag-empty")).toBe(false);
    expect(state.materials.has("stored-empty")).toBe(false);
    expect(storeMaterialFailureFor(frames, "store")).toBeTruthy();
  });
});
