import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Command, LegacySection, BridgeFrame } from "@qingagent/contract-ts";
import { getPmContentHash, legacySectionsToPm, type PmDoc } from "@qingagent/pm-schema";

const originalUserVersionWindowMs = process.env.QINGAGENT_USER_VERSION_WINDOW_MS;

async function collectFrames(gen: AsyncGenerator<BridgeFrame>): Promise<BridgeFrame[]> {
  const frames: BridgeFrame[] = [];
  for await (const frame of gen) frames.push(frame);
  return frames;
}

function section(text: string): LegacySection {
  return { kind: "p", data: { text } };
}

function h1(text: string): LegacySection {
  return { kind: "h1", data: { text } };
}

async function loadBridge() {
  vi.resetModules();
  const commitDocumentOp = vi.fn();
  const persistSessionMetadata = vi.fn(async () => undefined);
  const schedulePersist = vi.fn(async () => undefined);
  const runAgentTurn = vi.fn(async function* (..._args: unknown[]): AsyncGenerator<BridgeFrame> {});
  const invalidateDraftStateAfterCanonicalWrite = vi.fn(async () => undefined);

  vi.doMock("@qingagent/core", async () => {
    const actual = await vi.importActual<typeof import("@qingagent/core")>("@qingagent/core");
    return {
      ...actual,
      commitDocumentOp,
      persistSessionMetadata,
      schedulePersist,
      runAgentTurn,
      invalidateDraftStateAfterCanonicalWrite,
      createSessionThread: vi.fn(async () => undefined),
    };
  });

  const bridge = await import("../gateway/bridgeHandler");
  return {
    bridge,
    commitDocumentOp,
    persistSessionMetadata,
    runAgentTurn,
    invalidateDraftStateAfterCanonicalWrite,
  };
}

async function createDraftSession(
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
  session.docState = { kind: "editing" };
  session.docVersion = 1;
  session.lastSyncedDocumentSnapshot = 1;
  session.legacySections = [section("old")];
  session.doc = legacySectionsToPm(session.legacySections as never);
  session._lastEmittedWireKind = "editing:none:idle";
  return session;
}

function addSuggestion(
  session: Awaited<ReturnType<typeof createDraftSession>>,
  id = "patch-1",
): void {
  session.doc ??= legacySectionsToPm(session.legacySections as never);
  session.suggestions.set(id, {
    messageId: "msg",
    toolCallId: id,
    before: "old",
    after: "new",
    blockIndex: 0,
    suggestion: {
      id,
      docId: session.docId,
      baseVersion: session.docVersion,
      baseSchemaVersion: session.doc.attrs.schemaVersion,
      status: "reviewing",
      anchor: {
        blockId: session.doc.content[0]?.attrs.blockId ?? "block-review",
        pmFrom: 1,
        pmTo: 2,
        quote: "old",
        textHash: "test",
      },
      patch: { kind: "prosemirror_steps", steps: [] },
      preview: { deleteText: "old", insertText: "new" },
      summary: "change",
    },
  });
}

function updateCommand(sessionId: string, overrides: Partial<Extract<Command, { kind: "updateDoc" }>["data"]> = {}): Command {
  return {
    kind: "updateDoc",
    data: {
      sessionId,
      expectedDocumentSnapshot: 1,
      doc: legacySectionsToPm([section("new")]) as never,
      legacySections: [section("new")],
      clientMutationId: "mutation-1",
      ...overrides,
    },
  };
}

describe("handleCommand updateDoc", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    delete process.env.QINGAGENT_USER_VERSION_WINDOW_MS;
  });

  afterEach(() => {
    if (originalUserVersionWindowMs === undefined) {
      delete process.env.QINGAGENT_USER_VERSION_WINDOW_MS;
    } else {
      process.env.QINGAGENT_USER_VERSION_WINDOW_MS = originalUserVersionWindowMs;
    }
  });

  it("writes with doc_version, syncs in-memory state, and persists metadata", async () => {
    const {
      bridge,
      commitDocumentOp,
      persistSessionMetadata,
      invalidateDraftStateAfterCanonicalWrite,
    } = await loadBridge();
    const session = await createDraftSession(bridge);
    const submittedDoc = legacySectionsToPm([section("new")]);
    commitDocumentOp.mockResolvedValue({
      status: "committed",
      docVersion: 2,
      contentHash: "hash-2",
      doc: submittedDoc,
      versionId: "version-2",
      createdNewVersion: true,
      committedAt: "2026-03-04T05:06:07.000Z",
    });

    const frames = await collectFrames(bridge.handleCommand(updateCommand(session.sessionId, {
      baseContentHash: "pmv1-base",
      doc: submittedDoc as never,
    })));

    expect(commitDocumentOp).toHaveBeenCalledWith(expect.objectContaining({
      docId: session.docId,
      expectedDocumentSnapshot: 1,
      baseContentHash: "pmv1-base",
      clientMutationId: "mutation-1",
      opKind: "replace_doc",
      actorType: "user",
      coalesce: { windowMs: 60_000 },
    }));
    expect(frames).toEqual([
      {
        kind: "docWriteResult",
        data: { ok: true, clientMutationId: "mutation-1", docVersion: 2 },
      },
    ]);
    expect(session.legacySections).toEqual([section("new")]);
    expect(session.docVersion).toBe(2);
    expect(session.lastContentEditedAt).toBe("2026-03-04T05:06:07.000Z");
    expect(session.lastSyncedDocumentSnapshot).toBe(1);
    expect(invalidateDraftStateAfterCanonicalWrite).toHaveBeenCalledWith(session);
    expect(persistSessionMetadata).toHaveBeenCalledWith(session);
  });

  it("幂等回放即使返回版本高于陈旧内存，也不推进内容时间", async () => {
    const { bridge, commitDocumentOp } = await loadBridge();
    const session = await createDraftSession(bridge);
    const originalContentTime = "2025-01-02T03:04:05.000Z";
    session.lastContentEditedAt = originalContentTime;
    const submittedDoc = legacySectionsToPm([section("replayed")]);
    commitDocumentOp.mockResolvedValue({
      status: "committed",
      docVersion: 2,
      contentHash: "hash-replayed",
      doc: submittedDoc,
      versionId: "version-replayed",
      createdNewVersion: false,
      committedAt: "2024-01-01T00:00:00.000Z",
    });

    await collectFrames(bridge.handleCommand(updateCommand(session.sessionId, {
      doc: submittedDoc as never,
    })));

    expect(session.docVersion).toBe(2);
    expect(session.lastContentEditedAt).toBe(originalContentTime);
  });

  it("no-op 保存向客户端确认当前版本，不虚增 session 基线", async () => {
    const { bridge, commitDocumentOp } = await loadBridge();
    const session = await createDraftSession(bridge);
    const originalDoc = session.doc!;
    const originalContentTime = session.lastContentEditedAt;
    commitDocumentOp.mockResolvedValue({
      status: "committed",
      docVersion: 1,
      contentHash: getPmContentHash(originalDoc),
      doc: originalDoc,
      versionId: "version-current",
      createdNewVersion: false,
      committedAt: "2026-03-04T05:06:07.000Z",
    });

    const frames = await collectFrames(bridge.handleCommand(updateCommand(session.sessionId, {
      baseContentHash: getPmContentHash(originalDoc),
      doc: originalDoc as never,
      legacySections: [section("old")],
      clientMutationId: "mutation-noop",
    })));

    expect(frames).toEqual([
      {
        kind: "docWriteResult",
        data: { ok: true, clientMutationId: "mutation-noop", docVersion: 1 },
      },
    ]);
    expect(session.docVersion).toBe(1);
    expect(session.doc).toEqual(originalDoc);
    expect(session.lastContentEditedAt).toBe(originalContentTime);
  });

  it("commits PM updateDoc through commitDocumentOp and keeps the legacy mirror derived", async () => {
    const { bridge, commitDocumentOp, persistSessionMetadata } = await loadBridge();
    const session = await createDraftSession(bridge);
    const pmDoc = legacySectionsToPm([section("PM 正文")]);
    commitDocumentOp.mockResolvedValue({
      status: "committed",
      docVersion: 2,
      contentHash: "hash-2",
      doc: pmDoc,
      versionId: "version-2",
    });

    const frames = await collectFrames(bridge.handleCommand(updateCommand(session.sessionId, {
      doc: pmDoc as never,
      legacySections: [section("derived mirror")],
    })));

    expect(commitDocumentOp).toHaveBeenCalledWith(expect.objectContaining({
      docId: session.docId,
      expectedDocumentSnapshot: 1,
      clientMutationId: "mutation-1",
      opKind: "replace_doc",
      actorType: "user",
      coalesce: { windowMs: 60_000 },
    }));
    expect(frames).toEqual([
      {
        kind: "docWriteResult",
        data: { ok: true, clientMutationId: "mutation-1", docVersion: 2 },
      },
    ]);
    expect(session.doc).toEqual(pmDoc);
    expect(session.legacySections).toEqual([section("PM 正文")]);
    expect(session.docVersion).toBe(2);
    expect(persistSessionMetadata).toHaveBeenCalledWith(session);
  });

  it("strips diagram.svg from PM updateDoc before committing", async () => {
    const { bridge, commitDocumentOp } = await loadBridge();
    const session = await createDraftSession(bridge);
    const evilDoc: PmDoc = {
      type: "doc",
      attrs: { schemaVersion: 1 },
      content: [
        {
          type: "diagram",
          attrs: {
            blockId: "diagram-1",
            lang: "mermaid",
            source: "flowchart TD\n A-->B",
            svg: '<svg onload="alert(1)"><script>alert(1)</script></svg>',
          },
        },
      ],
    };
    commitDocumentOp.mockImplementation(async (input) => ({
      status: "committed",
      docVersion: 2,
      contentHash: "hash-sanitized",
      doc: input.apply().nextDoc,
      versionId: "version-sanitized",
    }));

    await collectFrames(bridge.handleCommand(updateCommand(session.sessionId, {
      doc: evilDoc as never,
      legacySections: [{ kind: "diagram", data: { lang: "mermaid", source: "flowchart TD\n A-->B" } } as never],
    })));

    const committed = commitDocumentOp.mock.calls[0]?.[0].apply().nextDoc as PmDoc;
    const block = committed.content[0];
    expect(block?.type).toBe("diagram");
    expect(block?.type === "diagram" ? block.attrs.svg : "x").toBeNull();
    expect(session.doc).toEqual(committed);
  });

  it("R3-03 refreshes session title from edited H1 before persisting metadata", async () => {
    const { bridge, commitDocumentOp, persistSessionMetadata } = await loadBridge();
    const session = await createDraftSession(bridge);
    session.title = "旧标题";
    const pmDoc = legacySectionsToPm([h1("新标题"), section("正文")] as never);
    commitDocumentOp.mockResolvedValue({
      status: "committed",
      docVersion: 2,
      contentHash: "hash-title",
      doc: pmDoc,
      versionId: "version-title",
    });

    const frames = await collectFrames(bridge.handleCommand(updateCommand(session.sessionId, {
      doc: pmDoc as never,
    })));

    expect(frames).toEqual([
      { kind: "sessionMeta", data: { sessionId: session.sessionId, title: "新标题" } },
      {
        kind: "docWriteResult",
        data: { ok: true, clientMutationId: "mutation-1", docVersion: 2 },
      },
    ]);
    expect(session.title).toBe("新标题");
    expect(persistSessionMetadata).toHaveBeenCalledWith(expect.objectContaining({ title: "新标题" }));
  });

  it("用户改名后置 pinned，后续 H1 编辑不再覆盖标题", async () => {
    const { bridge, commitDocumentOp, persistSessionMetadata } = await loadBridge();
    const session = await createDraftSession(bridge);

    const renameFrames = await collectFrames(bridge.handleCommand({
      kind: "renameSession",
      data: { sessionId: session.sessionId, title: "我的标题" },
    }));
    expect(renameFrames).toEqual([
      { kind: "sessionMeta", data: { sessionId: session.sessionId, title: "我的标题" } },
    ]);
    expect(session).toMatchObject({ title: "我的标题", titlePinned: true });

    const pmDoc = legacySectionsToPm([h1("新的 H1"), section("正文")] as never);
    commitDocumentOp.mockResolvedValue({
      status: "committed", docVersion: 2, contentHash: "hash-pinned", doc: pmDoc, versionId: "version-pinned",
    });
    const frames = await collectFrames(bridge.handleCommand(updateCommand(session.sessionId, { doc: pmDoc as never })));
    expect(frames.some((frame) => frame.kind === "sessionMeta")).toBe(false);
    expect(session.title).toBe("我的标题");
    expect(persistSessionMetadata).toHaveBeenCalledWith(expect.objectContaining({ title: "我的标题", titlePinned: true }));
  });

  it("passes windowMs zero to commitDocumentOp when env parsing disables coalescing", async () => {
    process.env.QINGAGENT_USER_VERSION_WINDOW_MS = "invalid";
    const { bridge, commitDocumentOp } = await loadBridge();
    const session = await createDraftSession(bridge);
    const submittedDoc = legacySectionsToPm([section("new")]);
    commitDocumentOp.mockResolvedValue({
      status: "committed",
      docVersion: 2,
      contentHash: "hash-2",
      doc: submittedDoc,
      versionId: "version-2",
    });

    await collectFrames(bridge.handleCommand(updateCommand(session.sessionId, {
      doc: submittedDoc as never,
    })));

    expect(commitDocumentOp).toHaveBeenCalledWith(expect.objectContaining({
      coalesce: { windowMs: 0 },
    }));
  });

  it("returns machine-readable conflict with actual doc_version", async () => {
    const { bridge, commitDocumentOp } = await loadBridge();
    const session = await createDraftSession(bridge);
    const contentTimeBeforeConflict = session.lastContentEditedAt;
    commitDocumentOp.mockResolvedValue({ status: "conflict", currentVersion: 5 });

    const frames = await collectFrames(bridge.handleCommand(updateCommand(session.sessionId)));

    expect(frames).toEqual([
      {
        kind: "docWriteResult",
        data: {
          ok: false,
          clientMutationId: "mutation-1",
          conflict: { expectedDocumentSnapshot: 1, actualDocumentSnapshot: 5 },
        },
      },
    ]);
    expect(session.lastContentEditedAt).toBe(contentTimeBeforeConflict);
  });

  it("rejects while an agent run is suspended and does not write", async () => {
    const { bridge } = await loadBridge();
    const session = await createDraftSession(bridge);
    session.runId = "run-1";

    const frames = await collectFrames(bridge.handleCommand(updateCommand(session.sessionId)));

    expect(frames).toEqual([
      {
        kind: "docWriteResult",
        data: { ok: false, clientMutationId: "mutation-1", reason: "agent_busy" },
      },
    ]);
  });

  it("rejects document edits while an agent stream is active", async () => {
    const { bridge } = await loadBridge();
    const session = await createDraftSession(bridge);
    session.streamId = "active-stream";

    const frames = await collectFrames(bridge.handleCommand(updateCommand(session.sessionId)));

    expect(frames).toEqual([
      {
        kind: "docWriteResult",
        data: { ok: false, clientMutationId: "mutation-1", reason: "not_editable" },
      },
    ]);
  });

  it("enforces draft state on the backend and does not write", async () => {
    const { bridge } = await loadBridge();
    const session = await createDraftSession(bridge);
    session.docState = { kind: "pendingReview" };
    addSuggestion(session);

    const frames = await collectFrames(bridge.handleCommand(updateCommand(session.sessionId)));

    expect(frames).toEqual([
      {
        kind: "docWriteResult",
        data: { ok: false, clientMutationId: "mutation-1", reason: "not_editable" },
      },
    ]);
  });

  it("空文档(empty)首次 updateDoc 走 createIfMissing 创建首版并落库(先写后聊/模板填充)", async () => {
    const { bridge, commitDocumentOp } = await loadBridge();
    // 不用 createDraftSession(它会塞入 doc);startSession 拿一个无 canonical doc 的空 session
    const startFrames = await collectFrames(
      bridge.handleCommand({
        kind: "startSession",
        data: { mode: { kind: "new", data: { template: null } } },
      }),
    );
    const meta = startFrames.find((f) => f.kind === "sessionMeta");
    if (meta?.kind !== "sessionMeta") throw new Error("missing sessionMeta");
    const session = bridge.getSession(meta.data.sessionId);
    if (!session) throw new Error("missing session");

    const submittedDoc = legacySectionsToPm([h1("产品需求文档"), section("")]);
    commitDocumentOp.mockResolvedValue({
      status: "committed",
      docVersion: 1,
      contentHash: "hash-1",
      doc: submittedDoc,
      versionId: "version-1",
    });

    const frames = await collectFrames(
      bridge.handleCommand(
        updateCommand(session.sessionId, {
          doc: submittedDoc as never,
          legacySections: [h1("产品需求文档"), section("")],
          expectedDocumentSnapshot: 0,
        }),
      ),
    );

    // 空文档首写:不再 not_editable;带 createIfMissing 建首版,且不进 coalesce 合并窗口
    expect(commitDocumentOp).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedDocumentSnapshot: 0,
        opKind: "replace_doc",
        actorType: "user",
        createIfMissing: expect.objectContaining({ docState: "editing", lastSyncedVersion: 0 }),
      }),
    );
    const ack = frames.find((f) => f.kind === "docWriteResult");
    expect(ack).toEqual({
      kind: "docWriteResult",
      data: { ok: true, clientMutationId: "mutation-1", docVersion: 1 },
    });
    const docStateIndex = frames.findIndex(
      (f) =>
        f.kind === "docStateChanged" &&
        f.data.state.kind === "editing" &&
        f.data.activeOverlay === null &&
        f.data.agentBusy === false,
    );
    const ackIndex = frames.findIndex((f) => f.kind === "docWriteResult");
    expect(docStateIndex).toBeGreaterThanOrEqual(0);
    expect(ackIndex).toBeGreaterThan(docStateIndex);
    expect(session.docState).toEqual({ kind: "editing" });
  });

  it("reports missing document rows as not_found", async () => {
    const { bridge, commitDocumentOp } = await loadBridge();
    const session = await createDraftSession(bridge);
    commitDocumentOp.mockResolvedValue({ status: "not_found" });

    const frames = await collectFrames(bridge.handleCommand(updateCommand(session.sessionId)));

    expect(frames).toEqual([
      {
        kind: "docWriteResult",
        data: { ok: false, clientMutationId: "mutation-1", reason: "not_found" },
      },
    ]);
  });

  it("injects the edited document into the next agent turn", async () => {
    const { bridge, commitDocumentOp, runAgentTurn } = await loadBridge();
    const session = await createDraftSession(bridge);
    const submittedDoc = legacySectionsToPm([section("new")]);
    commitDocumentOp.mockResolvedValue({
      status: "committed",
      docVersion: 2,
      contentHash: "hash-2",
      doc: submittedDoc,
      versionId: "version-2",
    });
    await collectFrames(bridge.handleCommand(updateCommand(session.sessionId, {
      doc: submittedDoc as never,
    })));

    await collectFrames(
      bridge.handleCommand({
        kind: "sendMessage",
        data: {
          sessionId: session.sessionId,
          text: "继续修改",
          mentions: [],
          skills: [],
          chips: [],
          fileIds: [],
        },
      }),
    );

    expect(runAgentTurn).toHaveBeenCalled();
    const agentSession = runAgentTurn.mock.calls[0]?.[0] as { legacySections?: LegacySection[] };
    expect(agentSession.legacySections).toEqual([section("new")]);
  });

  it("throws when the session does not exist", async () => {
    const { bridge } = await loadBridge();
    await expect(
      collectFrames(bridge.handleCommand(updateCommand("missing-session"))),
    ).rejects.toThrow("Session not found: missing-session");
  });
});
