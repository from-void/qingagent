import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import type { BridgeFrame, Command } from "@qingagent/contract-ts";
import type { Material } from "@qingagent/core";

async function collectFrames(gen: AsyncGenerator<BridgeFrame>): Promise<BridgeFrame[]> {
  const frames: BridgeFrame[] = [];
  for await (const frame of gen) frames.push(frame);
  return frames;
}

async function loadBridge() {
  vi.resetModules();
  const schedulePersist = vi.fn(async () => undefined);
  const deleteUploadedFile = vi.fn(async () => true);

  vi.doMock("@qingagent/core", async () => {
    const actual = await vi.importActual<typeof import("@qingagent/core")>("@qingagent/core");
    return {
      ...actual,
      schedulePersist,
      createSessionThread: vi.fn(async () => undefined),
    };
  });
  vi.doMock("../lib/uploadStorage", () => ({
    UPLOAD_DIR: "/tmp/qingagent-test-uploads",
    isValidUploadId: vi.fn(() => true),
    isWithinUploadDir: vi.fn(() => true),
    deleteUploadedFile,
  }));

  const bridge = await import("../gateway/bridgeHandler");
  const core = await import("@qingagent/core");
  return { bridge, schedulePersist, deleteUploadedFile, core };
}

async function createSession(
  bridge: typeof import("../gateway/bridgeHandler"),
): Promise<NonNullable<ReturnType<typeof bridge.getSession>>> {
  const frames = await collectFrames(
    bridge.handleCommand({
      kind: "startSession",
      data: { mode: { kind: "new", data: { template: null } } },
    }),
  );
  const meta = frames.find((frame) => frame.kind === "sessionMeta");
  if (meta?.kind !== "sessionMeta") throw new Error("missing sessionMeta");
  const session = bridge.getSession(meta.data.sessionId);
  if (!session) throw new Error("missing session");
  return session;
}

type MaterialOverrides = Partial<Omit<Material, "metadata">> & {
  metadata?: Partial<Material["metadata"]>;
};

function makeMaterial(overrides: MaterialOverrides = {}): Material {
  const base: Material = {
    id: "mat-1",
    filename: "report.pdf",
    mimeType: "application/pdf",
    text: "full text",
    summary: "旧摘要",
    fileId: "11111111-1111-1111-1111-111111111111",
    metadata: {
      pages: 2,
      wordCount: 9,
      title: "Report",
      sourceUrl: "https://example.com/report",
    },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
  return {
    ...base,
    ...overrides,
    metadata: { ...base.metadata, ...overrides.metadata },
  };
}

function updateMaterialSummaryCommand(
  sessionId: string,
  materialId = "mat-1",
  summary = "新摘要",
): Command {
  return {
    kind: "updateMaterialSummary",
    data: { sessionId, materialId, summary },
  };
}

function removeMaterialCommand(sessionId: string, materialId = "mat-1"): Command {
  return {
    kind: "removeMaterial",
    data: { sessionId, materialId },
  };
}

function reparseMaterialCommand(sessionId: string, fileId: string): Command {
  return {
    kind: "reparseMaterial",
    data: { sessionId, fileId },
  };
}

function busyFrame(streamId: string): BridgeFrame {
  return {
    kind: "stream",
    data: {
      kind: "draftingFailed",
      data: {
        streamId,
        reason: "生成中，请稍后再试",
        retriable: false,
      },
    },
  };
}

describe("handleCommand material commands", () => {
  const uploadedDirs: string[] = [];

  async function seedUploadedFile(
    core: typeof import("@qingagent/core"),
    fileId: string,
    filename: string,
    content: string | Buffer,
  ): Promise<void> {
    const dir = path.join(core.UPLOADS_BASE, fileId);
    uploadedDirs.push(dir);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, filename), content);
  }

  function singleResourceUpserted(frames: BridgeFrame[]) {
    expect(frames).toHaveLength(1);
    const frame = frames[0];
    expect(frame?.kind).toBe("resourceUpserted");
    if (frame?.kind !== "resourceUpserted") throw new Error("missing resourceUpserted");
    return frame.data.resource;
  }

  afterEach(async () => {
    const dirs = uploadedDirs.splice(0);
    await Promise.all(dirs.map((dir) => fs.rm(dir, { recursive: true, force: true })));
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it("updates a material summary and emits resourceUpdated with metadata.fileId", async () => {
    const { bridge, schedulePersist } = await loadBridge();
    const session = await createSession(bridge);
    const mat = makeMaterial();
    session.materials.set(mat.id, mat);

    const frames = await collectFrames(
      bridge.handleCommand(updateMaterialSummaryCommand(session.sessionId)),
    );

    expect(mat.summary).toBe("新摘要");
    expect(mat.updatedAt).not.toBe("2026-01-01T00:00:00.000Z");
    expect(frames).toEqual([
      {
        kind: "resourceUpdated",
        data: {
          resourceRef: { id: "mat-1", domain: { kind: "file" } },
          summary: "新摘要",
          metadata: { ...mat.metadata, fileId: mat.fileId },
        },
      },
    ]);
    expect(schedulePersist).toHaveBeenCalledWith(session, "command:updateMaterialSummary");
  });

  it("素材已不存在时摘要更新明确失败，删除仍幂等回 resourceRemoved", async () => {
    const { bridge, schedulePersist, deleteUploadedFile } = await loadBridge();
    const session = await createSession(bridge);
    const missingMaterialId = "missing-material";

    await expect(collectFrames(
      bridge.handleCommand(
        updateMaterialSummaryCommand(session.sessionId, missingMaterialId),
      ),
    )).rejects.toThrow("Material not found");

    await expect(collectFrames(
      bridge.handleCommand(
        removeMaterialCommand(session.sessionId, missingMaterialId),
      ),
    )).resolves.toEqual([
      {
        kind: "resourceRemoved",
        data: {
          resourceRef: {
            id: missingMaterialId,
            domain: { kind: "file" },
          },
        },
      },
    ]);
    expect(schedulePersist).not.toHaveBeenCalled();
    expect(deleteUploadedFile).not.toHaveBeenCalled();
  });

  it("removes a material, clears extraction cache, deletes the unshared upload, and emits resourceRemoved", async () => {
    const { bridge, schedulePersist, deleteUploadedFile } = await loadBridge();
    const session = await createSession(bridge);
    const mat = makeMaterial();
    session.materials.set(mat.id, mat);
    session._extractedTexts = new Map([
      [mat.filename, { text: "file text", sourceUrl: null, fileId: mat.fileId }],
      [mat.metadata.title!, { text: "title text", sourceUrl: null, fileId: mat.fileId }],
      [mat.metadata.sourceUrl!, { text: "url text", sourceUrl: mat.metadata.sourceUrl!, fileId: mat.fileId }],
      ["keep", { text: "keep text", sourceUrl: null, fileId: null }],
    ]);

    const frames = await collectFrames(
      bridge.handleCommand(removeMaterialCommand(session.sessionId)),
    );

    expect(session.materials.has(mat.id)).toBe(false);
    expect(session._extractedTexts.has(mat.filename)).toBe(false);
    expect(session._extractedTexts.has(mat.metadata.title!)).toBe(false);
    expect(session._extractedTexts.has(mat.metadata.sourceUrl!)).toBe(false);
    expect(session._extractedTexts.has("keep")).toBe(true);
    expect(deleteUploadedFile).toHaveBeenCalledWith(mat.fileId);
    expect(frames).toEqual([
      {
        kind: "resourceRemoved",
        data: {
          resourceRef: { id: "mat-1", domain: { kind: "file" } },
        },
      },
    ]);
    expect(schedulePersist).toHaveBeenCalledWith(session, "command:removeMaterial");
  });

  it("同一会话内两个素材共享 fileId 时，删一个不释放会话级引用也不删物理文件", async () => {
    const { bridge, deleteUploadedFile } = await loadBridge();
    const session = await createSession(bridge);
    const sharedFileId = "22222222-2222-2222-2222-222222222222";
    const first = makeMaterial({ id: "mat-1", fileId: sharedFileId });
    const second = makeMaterial({
      id: "mat-2",
      filename: "copy.pdf",
      fileId: sharedFileId,
      metadata: { title: "Copy" },
    });
    session.materials.set(first.id, first);
    session.materials.set(second.id, second);

    const frames = await collectFrames(
      bridge.handleCommand(removeMaterialCommand(session.sessionId, first.id)),
    );

    expect(session.materials.has(first.id)).toBe(false);
    expect(session.materials.get(second.id)).toBe(second);
    expect(deleteUploadedFile).not.toHaveBeenCalled();
    expect(frames).toEqual([
      {
        kind: "resourceRemoved",
        data: {
          resourceRef: { id: "mat-1", domain: { kind: "file" } },
        },
      },
    ]);
  });

  it("rejects update and remove material commands while the session is busy", async () => {
    const { bridge, schedulePersist, deleteUploadedFile } = await loadBridge();
    const session = await createSession(bridge);
    const mat = makeMaterial();
    session.materials.set(mat.id, mat);

    session.streamId = "active-stream";
    const updateFrames = await collectFrames(
      bridge.handleCommand(updateMaterialSummaryCommand(session.sessionId, mat.id, "忙碌写入")),
    );

    session.streamId = null;
    session.runId = "run-1";
    const removeFrames = await collectFrames(
      bridge.handleCommand(removeMaterialCommand(session.sessionId, mat.id)),
    );

    expect(updateFrames).toEqual([busyFrame("active-stream")]);
    expect(removeFrames).toEqual([busyFrame("blocked")]);
    expect(mat.summary).toBe("旧摘要");
    expect(session.materials.get(mat.id)).toBe(mat);
    expect(schedulePersist).not.toHaveBeenCalled();
    expect(deleteUploadedFile).not.toHaveBeenCalled();
  });

  it("rejects reparseMaterial while the session is busy without mutating materials", async () => {
    const { bridge, schedulePersist } = await loadBridge();
    const session = await createSession(bridge);
    session.streamId = "active-stream";

    const frames = await collectFrames(
      bridge.handleCommand(reparseMaterialCommand(session.sessionId, "33333333-3333-4333-8333-333333333333")),
    );

    expect(frames).toEqual([busyFrame("active-stream")]);
    expect(session.materials.size).toBe(0);
    expect(schedulePersist).not.toHaveBeenCalled();
  });

  it("reparseMaterial parses valid uploaded bytes into a ready material and emits resourceUpserted", async () => {
    const { bridge, schedulePersist, core } = await loadBridge();
    const session = await createSession(bridge);
    const fileId = "33333333-3333-4333-8333-333333333333";
    await seedUploadedFile(core, fileId, "source.txt", "重试解析后的正文内容");

    const frames = await collectFrames(
      bridge.handleCommand(reparseMaterialCommand(session.sessionId, fileId)),
    );

    const material = [...session.materials.values()].find((mat) => mat.fileId === fileId);
    expect(material).toBeTruthy();
    expect(material?.metadata.parseState).toBe("ready");
    expect(material?.metadata.parseError).toBeNull();
    expect(material?.text).toContain("重试解析后的正文内容");

    const resource = singleResourceUpserted(frames);
    expect(resource.resourceRef.id).toBe(material?.id);
    expect(resource.displayName).toBe("source.txt");
    expect(resource.mime).toBe("text/plain");
    expect(resource.byteLen).toBe(material?.text.length);
    expect(resource.metadata).toMatchObject({
      fileId,
      parseState: "ready",
      parseError: null,
    });
    expect(schedulePersist).toHaveBeenCalledWith(session, "command:reparseMaterial");
  });

  it("reparseMaterial stores unsupported legacy office files as error materials and emits resourceUpserted", async () => {
    const { bridge, schedulePersist, core } = await loadBridge();
    const session = await createSession(bridge);
    const fileId = "44444444-4444-4444-8444-444444444444";
    await seedUploadedFile(core, fileId, "legacy.xls", Buffer.from([0, 1, 2, 3, 4, 5]));

    const frames = await collectFrames(
      bridge.handleCommand(reparseMaterialCommand(session.sessionId, fileId)),
    );

    const material = [...session.materials.values()].find((mat) => mat.fileId === fileId);
    expect(material).toBeTruthy();
    expect(material?.text).toBe("");
    expect(material?.summary).toContain("不支持解析");
    expect(material?.metadata.parseState).toBe("error");
    expect(material?.metadata.parseError).toContain("不支持解析");

    const resource = singleResourceUpserted(frames);
    expect(resource.resourceRef.id).toBe(material?.id);
    expect(resource.displayName).toBe("legacy.xls");
    expect(resource.mime).toBe("application/vnd.ms-excel");
    expect(resource.byteLen).toBe(0);
    expect(resource.metadata).toMatchObject({
      fileId,
      parseState: "error",
    });
    expect(schedulePersist).toHaveBeenCalledWith(session, "command:reparseMaterial");
  });

  it("reparseMaterial stores an error material when the original upload is missing", async () => {
    const { bridge, schedulePersist } = await loadBridge();
    const session = await createSession(bridge);
    const fileId = "55555555-5555-4555-8555-555555555555";

    const frames = await collectFrames(
      bridge.handleCommand(reparseMaterialCommand(session.sessionId, fileId)),
    );

    const material = [...session.materials.values()].find((mat) => mat.fileId === fileId);
    expect(material).toBeTruthy();
    expect(material?.text).toBe("");
    expect(material?.summary).toBe("原始文件不存在，无法重试解析");
    expect(material?.metadata.parseState).toBe("error");
    expect(material?.metadata.parseError).toBe("原始文件不存在，无法重试解析");

    const resource = singleResourceUpserted(frames);
    expect(resource.resourceRef.id).toBe(material?.id);
    expect(resource.displayName).toBe(fileId);
    expect(resource.metadata).toMatchObject({
      fileId,
      parseState: "error",
      parseError: "原始文件不存在，无法重试解析",
    });
    expect(schedulePersist).toHaveBeenCalledWith(session, "command:reparseMaterial");
  });

  it("reparseMaterial 失败时保留已有 ready 素材正文、提取元数据与缓存", async () => {
    const { bridge, schedulePersist } = await loadBridge();
    const session = await createSession(bridge);
    const fileId = "77777777-7777-4777-8777-777777777777";
    const existing = makeMaterial({
      id: "mat-last-good",
      filename: "last-good.pdf",
      text: "LAST_GOOD_BODY",
      fileId,
      metadata: {
        pages: 7,
        wordCount: 123,
        title: "Last Good",
        sourceUrl: "https://example.com/last-good",
        parseState: "ready",
        parseError: null,
      },
    });
    session.materials.set(existing.id, existing);
    session._extractedTexts = new Map([
      [existing.filename, { text: existing.text, sourceUrl: existing.metadata.sourceUrl ?? null, fileId }],
      [existing.id, { text: existing.text, sourceUrl: existing.metadata.sourceUrl ?? null, fileId }],
    ]);

    const frames = await collectFrames(
      bridge.handleCommand(reparseMaterialCommand(session.sessionId, fileId)),
    );

    const material = session.materials.get(existing.id);
    expect(material).toMatchObject({
      id: existing.id,
      text: "LAST_GOOD_BODY",
      summary: "旧摘要",
      metadata: {
        pages: 7,
        wordCount: 123,
        title: "Last Good",
        sourceUrl: "https://example.com/last-good",
        parseState: "error",
        parseError: "原始文件不存在，无法重试解析",
      },
      createdAt: existing.createdAt,
    });
    expect(session._extractedTexts?.get(existing.filename)?.text).toBe("LAST_GOOD_BODY");
    expect(session._extractedTexts?.get(existing.id)?.text).toBe("LAST_GOOD_BODY");

    const resource = singleResourceUpserted(frames);
    expect(resource.resourceRef.id).toBe(existing.id);
    expect(resource.byteLen).toBe("LAST_GOOD_BODY".length);
    expect(resource.metadata).toMatchObject({
      fileId,
      pages: 7,
      wordCount: 123,
      title: "Last Good",
      parseState: "error",
      parseError: "原始文件不存在，无法重试解析",
    });
    expect(schedulePersist).toHaveBeenCalledWith(session, "command:reparseMaterial");
  });

  it("reparseMaterial flips an existing error material to ready with the same id", async () => {
    const { bridge, schedulePersist, core } = await loadBridge();
    const session = await createSession(bridge);
    const fileId = "66666666-6666-4666-8666-666666666666";
    const materialId = core.stableErrorMaterialId(fileId);
    const existing = makeMaterial({
      id: materialId,
      filename: "原文件名.txt",
      mimeType: "text/plain",
      text: "",
      summary: "解析失败：旧错误",
      fileId,
      metadata: {
        pages: null,
        wordCount: 0,
        title: null,
        parseState: "error",
        parseError: "解析失败：旧错误",
      },
    });
    session.materials.set(existing.id, existing);
    await seedUploadedFile(core, fileId, "resolved-name.txt", "重新解析成功");

    const frames = await collectFrames(
      bridge.handleCommand(reparseMaterialCommand(session.sessionId, fileId)),
    );

    expect(session.materials.size).toBe(1);
    const material = session.materials.get(materialId);
    expect(material).toBeTruthy();
    expect(material?.id).toBe(materialId);
    expect(material?.filename).toBe("原文件名.txt");
    expect(material?.metadata.parseState).toBe("ready");
    expect(material?.metadata.parseError).toBeNull();
    expect(material?.summary).toBeNull();
    expect(material?.text).toContain("重新解析成功");

    const resource = singleResourceUpserted(frames);
    expect(resource.resourceRef.id).toBe(materialId);
    expect(resource.displayName).toBe("原文件名.txt");
    expect(resource.metadata).toMatchObject({
      fileId,
      parseState: "ready",
      parseError: null,
    });
    expect(schedulePersist).toHaveBeenCalledWith(session, "command:reparseMaterial");
  });

  it("HTTP 命令白名单接受 reparseMaterial(真机走查回归:漏加白名单致 400 拒绝)", async () => {
    // 单测直调 bridgeHandler 会绕过 routes/stream 的 VALID_COMMAND_KINDS 白名单层;
    // 5B 真机走查实锤:白名单漏 reparseMaterial → POST /api/v1/commands 400、重试静默失败。
    const { validateCommandKind } = await import("../routes/stream");
    expect(
      validateCommandKind({
        kind: "reparseMaterial",
        data: { sessionId: "s-whitelist", fileId: "file-whitelist" },
      }),
    ).toBeNull();
  });
});
