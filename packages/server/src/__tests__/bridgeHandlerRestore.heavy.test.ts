import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LegacySection, DocState, ToolCallSpec, BridgeFrame, DocSuggestion } from "@qingagent/contract-ts";
import { legacySectionsToPm, type PmDoc } from "@qingagent/pm-schema";

// resetModules 只用于重置 bridge 的进程内 session；真实 core 模块体积大且会注册
// 进程监听器，重复 importActual 会把模块初始化时间计入每个用例并泄漏 listeners。
const actualCore = await vi.importActual<typeof import("@qingagent/core")>("@qingagent/core");

// 这些 restore 用例模拟「旧快照里 docState 是 legacy 8 态字符串」的存量数据,
// 用来验证 restore 归一。R5e 后 session.docState 是 3 态 Content,故 legacy 种子需 cast。
function legacyDocState(kind: string): DocState {
  return { kind } as unknown as DocState;
}

async function collectFrames(gen: AsyncGenerator<BridgeFrame>): Promise<BridgeFrame[]> {
  const frames: BridgeFrame[] = [];
  for await (const frame of gen) frames.push(frame);
  return frames;
}

function section(text: string): LegacySection {
  return { kind: "p", data: { text } };
}

function markedPmDoc(text: string): PmDoc {
  return {
    type: "doc",
    attrs: { schemaVersion: 1 },
    content: [
      {
        type: "paragraph",
        attrs: { blockId: "restore-p-1" },
        content: [
          {
            type: "text",
            text,
            marks: [{ type: "bold" }],
          },
        ],
      },
    ],
  };
}

function reviewSuggestion(id: string): DocSuggestion {
  return {
    id,
    docId: "doc-restore",
    baseVersion: 4,
    baseSchemaVersion: 1,
    status: "reviewing",
    anchor: {
      blockId: "restore-p-1",
      pmFrom: 1,
      pmTo: 2,
      quote: "旧",
      textHash: "hash-restore",
    },
    patch: {
      kind: "prosemirror_steps",
      steps: [{ stepType: "replace", from: 1, to: 2 }],
    },
    preview: { deleteText: "旧", insertText: "新" },
    summary: "恢复待审",
  };
}

function toolCall(
  name: string,
  status: ToolCallSpec["status"],
  id = `${name}-1`,
): ToolCallSpec {
  return {
    id,
    name,
    render: { kind: ["askUser", "planDraft", "askUserQuestion"].includes(name) ? "rightForm" : "chatInline" },
    status,
    body: ["askUser", "planDraft", "askUserQuestion"].includes(name)
      ? {
          kind: "askUser",
          data: {
            id,
            mode: { kind: "fullpage" },
            purpose: { kind: "initialBrief" },
            source: null,
            rationale: null,
            questions: [
              {
                id: "q-one",
                label: "需要确认什么？",
                kind: { kind: "text" },
                options: [],
                placeholder: null,
              },
            ],
          },
        }
      : { kind: "generic", data: { argsJson: "{}" } },
    result: null,
  };
}

async function loadBridge() {
  vi.resetModules();

  vi.doMock("@qingagent/core", () => {
    return {
      ...actualCore,
      createSessionThread: vi.fn(async () => undefined),
      persistSessionMetadata: vi.fn(async () => undefined),
      schedulePersist: vi.fn(async () => undefined),
    };
  });

  return await import("../gateway/bridgeHandler");
}

async function createCachedSession(
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

describe("handleCommand existing-session restore", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("keeps in-memory open askUser suspension as modern empty content", async () => {
    const bridge = await loadBridge();
    const session = await createCachedSession(bridge);
    const askUser = toolCall(
      "askUser",
      { kind: "running", data: { progressPct: null, etaSec: null } },
      "ask-1",
    );
    session.docState = { kind: "editing" };
    session.chatHistory = [{
      id: "msg-ask",
      role: { kind: "agent" },
      ts: "2026-01-01T00:00:00.000Z",
      parts: [{ kind: "toolCall", data: askUser }],
      chips: null,
    }];
    session.runId = "run-ask";
    session.toolCallId = "ask-1";
    session._suspensionOwner = {
      streamId: "stream-ask",
      runId: "run-ask",
      toolCallId: "ask-1",
      toolName: "askUser",
    };

    const frames = await collectFrames(
      bridge.handleCommand({
        kind: "startSession",
        data: { mode: { kind: "existing", data: { id: session.sessionId } } },
      }),
    );

    expect(frames.find((frame) => frame.kind === "docStateChanged")).toEqual({
      kind: "docStateChanged",
      data: { state: { kind: "empty" }, activeOverlay: "askUser", agentBusy: false },
    });
    // R5e:无文档 → content 必为 empty(DC-1,纯 facts,无「活跃工作流→editing」旁路);
    // 出问卷的锁由 overlay=askUser 经 deriveEditorState 聚合为 locked,不进 content。
    // modern wire stays content-only; overlay comes from the askUser toolCall.
    expect(session.docState).toEqual({ kind: "empty" });
  });

  it("恢复三种问卷工具的缺失/空/非法 mode 时统一降级 fullpage", async () => {
    const dirtyModes: Array<{ label: string; value: unknown }> = [
      { label: "missing", value: undefined },
      { label: "null", value: null },
      { label: "empty", value: {} },
      { label: "invalid", value: { kind: "invalid" } },
    ];
    for (const name of ["askUser", "planDraft", "askUserQuestion"]) {
      for (const dirtyMode of dirtyModes) {
        const bridge = await loadBridge();
        const session = await createCachedSession(bridge);
        const spec = toolCall(name, { kind: "done" }, `${name}-dirty-mode-${dirtyMode.label}`);
        if (spec.body.kind !== "askUser") throw new Error("expect questionnaire body");
        if (dirtyMode.value === undefined) {
          delete (spec.body.data as unknown as { mode?: unknown }).mode;
        } else {
          (spec.body.data as unknown as { mode?: unknown }).mode = dirtyMode.value;
        }
        session.chatHistory = [{
          id: "msg-dirty-mode",
          role: { kind: "agent" },
          ts: "2026-07-11T00:00:00.000Z",
          parts: [{ kind: "toolCall", data: spec }],
          chips: null,
        }];

        const frames = [...bridge.emitRestoreFrames(session)];
        const restored = frames.find((frame) =>
          frame.kind === "toolCallUpdated" && frame.data.toolCallId === spec.id
        );
        expect(restored).toMatchObject({
          kind: "toolCallUpdated",
          data: {
            spec: {
              name,
              render: { kind: "rightForm" },
              body: { kind: "askUser", data: { mode: { kind: "fullpage" } } },
            },
          },
        });
      }
    }
  });

  // overlay 内联反问(写作中途澄清):没有 fullpage 汇总卡,可见答卷卡是答案唯一展示位,
  // restore 时要补建且幂等(第二次 restore 不重复)。
  function overlayAnsweredAskUser(): ToolCallSpec {
    const base = toolCall("askUser", { kind: "done" }, "ask-answered");
    if (base.body.kind !== "askUser") throw new Error("expect askUser body");
    return {
      ...base,
      body: {
        kind: "askUser",
        data: { ...base.body.data, mode: { kind: "overlay" } },
      },
      result: {
        kind: "askUserAnswers",
        data: { "q-one": { chosen: [], freeText: "答案A", numericValue: null } },
      },
    };
  }

  it("restores visible askUser answer card for cached legacy answered overlay askUser without duplicating", async () => {
    const bridge = await loadBridge();
    const session = await createCachedSession(bridge);
    const askUser = overlayAnsweredAskUser();
    session.chatHistory = [{
      id: "msg-ask-answered",
      role: { kind: "agent" },
      ts: "2026-01-01T00:00:00.000Z",
      parts: [{ kind: "toolCall", data: askUser }],
      chips: null,
    }];

    const firstFrames = await collectFrames(
      bridge.handleCommand({
        kind: "startSession",
        data: { mode: { kind: "existing", data: { id: session.sessionId } } },
      }),
    );
    const visibleCardId = "askuser-answer:ask-answered";
    const firstCardFrames = firstFrames.filter((frame) =>
      frame.kind === "chatMessageAdded" && frame.data.message.id === visibleCardId
    );

    expect(firstCardFrames).toHaveLength(1);
    expect(session.chatHistory.filter((message) => message.id === visibleCardId)).toHaveLength(1);

    await collectFrames(
      bridge.handleCommand({
        kind: "startSession",
        data: { mode: { kind: "existing", data: { id: session.sessionId } } },
      }),
    );
    expect(session.chatHistory.filter((message) => message.id === visibleCardId)).toHaveLength(1);
  });

  // P2 回归(用户走查):fullpage 开场问卷提交后,工具调用 done 已渲染「已提交答案」汇总卡,
  // restore 不再补建可见答卷卡「已提交写作方向问卷」,避免对话里两层等价内容。
  it("does NOT restore visible answer card for cached fullpage answered askUser (P2)", async () => {
    const bridge = await loadBridge();
    const session = await createCachedSession(bridge);
    const askUser: ToolCallSpec = {
      ...toolCall("askUser", { kind: "done" }, "ask-answered"), // toolCall 默认 fullpage
      result: {
        kind: "askUserAnswers",
        data: { "q-one": { chosen: [], freeText: "答案A", numericValue: null } },
      },
    };
    session.chatHistory = [{
      id: "msg-ask-answered",
      role: { kind: "agent" },
      ts: "2026-01-01T00:00:00.000Z",
      parts: [{ kind: "toolCall", data: askUser }],
      chips: null,
    }];

    const frames = await collectFrames(
      bridge.handleCommand({
        kind: "startSession",
        data: { mode: { kind: "existing", data: { id: session.sessionId } } },
      }),
    );
    const visibleCardId = "askuser-answer:ask-answered";
    expect(
      frames.filter(
        (frame) =>
          frame.kind === "chatMessageAdded" && frame.data.message.id === visibleCardId,
      ),
    ).toHaveLength(0);
    expect(session.chatHistory.filter((message) => message.id === visibleCardId)).toHaveLength(0);
  });

  it("/events restore 在活跃生成中只读投影,不把 running askUser 误终态化", async () => {
    const bridge = await loadBridge();
    const session = await createCachedSession(bridge);
    const askUser = toolCall(
      "askUser",
      { kind: "running", data: { progressPct: null, etaSec: null } },
      "ask-live",
    );
    session.docState = { kind: "editing" };
    session.chatHistory = [{
      id: "msg-ask-live",
      role: { kind: "agent" },
      ts: "2026-01-01T00:00:00.000Z",
      parts: [{ kind: "toolCall", data: askUser }],
      chips: null,
    }];
    bridge.sessionManager.frameLog.setActiveRunner(session.sessionId, true);
    session._lastEmittedWireKind = "editing:none:idle";

    const frames = await bridge.collectRestoreFrames(session.sessionId);

    const restoredAskUser = frames
      .filter((frame) => frame.kind === "chatMessageAdded")
      .flatMap((frame) => frame.kind === "chatMessageAdded" ? frame.data.message.parts : [])
      .find((part) => part.kind === "toolCall" && part.data.id === "ask-live");
    if (restoredAskUser?.kind !== "toolCall") throw new Error("missing restored askUser");
    expect(restoredAskUser.data.status.kind).toBe("running");
    const originalPart = session.chatHistory[0]?.parts[0];
    if (originalPart?.kind !== "toolCall") throw new Error("missing original askUser");
    expect(originalPart.data.status.kind).toBe("running");
    expect(session._lastEmittedWireKind).toBe("editing:none:idle");
  });

  it("normalizes cached review with no suggestions to editing", async () => {
    const bridge = await loadBridge();
    const session = await createCachedSession(bridge);
    session.docState = legacyDocState("review");
    session.legacySections = [section("正文")];
    session.doc = legacySectionsToPm(session.legacySections as never);

    const frames = await collectFrames(
      bridge.handleCommand({
        kind: "startSession",
        data: { mode: { kind: "existing", data: { id: session.sessionId } } },
      }),
    );

    expect(frames.find((frame) => frame.kind === "docStateChanged")).toEqual({
      kind: "docStateChanged",
      data: { state: { kind: "editing" }, activeOverlay: null, agentBusy: false },
    });
    expect(session.docState).toEqual({ kind: "editing" });
    expect(frames.some((frame) => frame.kind === "docDiffReady")).toBe(false);
  });

  it("restores documentSnapshotWritten from canonical PM without losing text marks", async () => {
    const bridge = await loadBridge();
    const session = await createCachedSession(bridge);
    session.docState = { kind: "editing" };
    session.legacySections = [section("加粗正文")];
    session.doc = markedPmDoc("加粗正文");
    session.docVersion = 3;

    const frames = await collectFrames(
      bridge.handleCommand({
        kind: "startSession",
        data: { mode: { kind: "existing", data: { id: session.sessionId } } },
      }),
    );

    const docFrame = frames.find((frame) => frame.kind === "documentSnapshotWritten");
    expect(docFrame).toMatchObject({
      kind: "documentSnapshotWritten",
      data: {
        doc: {
          version: 3,
          doc: {
            content: [
              {
                type: "paragraph",
                content: [
                  {
                    text: "加粗正文",
                    marks: [{ type: "bold" }],
                  },
                ],
              },
            ],
          },
        },
      },
    });
  });

  it("restore 回放 AI 任务清单 todosChanged", async () => {
    const bridge = await loadBridge();
    const session = await createCachedSession(bridge);
    session.todos = [
      { content: "确认需求范围", status: "completed" },
      { content: "实现后端状态帧", status: "in_progress" },
    ];

    const frames = await collectFrames(
      bridge.handleCommand({
        kind: "startSession",
        data: { mode: { kind: "existing", data: { id: session.sessionId } } },
      }),
    );

    expect(frames.find((frame) => frame.kind === "todosChanged")).toEqual({
      kind: "todosChanged",
      data: { todos: session.todos },
    });
  });

  // 回归:必现「文档冲突·刷新没用」。内存活 session 的 docVersion 因会话级并发写竞态停在陈旧值,
  // 页面刷新走 cached 重连分支重放陈旧版本 → 客户端发过期 expectedDocumentSnapshot → commitDocumentOp
  // 判 current.docVersion !== expected → docWriteConflict;刷新只是再次命中同一陈旧 cached。
  // 修复:重连前以 DB(documents.doc_version,唯一权威)向上对齐内存版本。
  it("reconnect reconciles a stale cached docVersion up to the DB's authoritative version", async () => {
    const bridge = await loadBridge();
    const { documentRepo } = await import("@qingagent/core");
    const session = await createCachedSession(bridge);
    const pm = legacySectionsToPm([section("正文内容")] as never);
    const now = new Date().toISOString();
    // DB(权威)已在版本 8;内存 session 因竞态停在陈旧的 3。
    await documentRepo.save({
      id: session.docId,
      threadId: session.threadId ?? session.sessionId,
      resourceId: "test-resource",
      title: "t",
      docState: "editing",
      docVersion: 8,
      lastSyncedVersion: 0,
      pmDoc: pm,
      createdAt: now,
      updatedAt: now,
    });
    session.docState = { kind: "editing" };
    session.legacySections = [section("正文内容")];
    session.doc = pm;
    session.docVersion = 3; // 陈旧:低于 DB 的 8

    const frames = await collectFrames(
      bridge.handleCommand({
        kind: "startSession",
        data: { mode: { kind: "existing", data: { id: session.sessionId } } },
      }),
    );

    // 修复前:重放陈旧 3 → 客户端必现冲突;修复后:重连帧与内存版本都对齐到 DB 的 8。
    const docFrame = frames.find((frame) => frame.kind === "documentSnapshotWritten");
    expect(docFrame).toMatchObject({
      kind: "documentSnapshotWritten",
      data: { doc: { version: 8 } },
    });
    expect(session.docVersion).toBe(8);
  });

  it("cached 崩溃窗口恢复精确 op 时间，并 await 持久化 DB-win 信号", async () => {
    const bridge = await loadBridge();
    const core = await import("@qingagent/core");
    const session = await createCachedSession(bridge);
    const base = legacySectionsToPm([section("v7")] as never);
    await core.documentRepo.save({
      id: session.docId,
      threadId: session.threadId ?? session.sessionId,
      resourceId: session.resourceId,
      title: "cached crash",
      docState: "editing",
      docVersion: 7,
      lastSyncedVersion: 0,
      pmDoc: base,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    const latest = legacySectionsToPm([section("v8")] as never);
    const commit = await core.commitDocumentOp({
      docId: session.docId,
      threadId: session.threadId ?? session.sessionId,
      resourceId: session.resourceId,
      expectedDocumentSnapshot: 7,
      opId: `cached-crash-v8:${session.sessionId}`,
      opKind: "replace_doc",
      actorType: "user",
      apply: () => ({ nextDoc: latest }),
    }, { now: () => "2026-06-07T08:09:10.111Z" });
    expect(commit).toMatchObject({ status: "committed", docVersion: 8 });
    session.docVersion = 3;
    session.doc = base;
    session.legacySections = [section("v7")];
    session.lastContentEditedAt = "2020-01-01T00:00:00.000Z";

    await collectFrames(
      bridge.handleCommand({
        kind: "startSession",
        data: { mode: { kind: "existing", data: { id: session.sessionId } } },
      }),
    );

    expect(session.docVersion).toBe(8);
    expect(session.lastContentEditedAt).toBe("2026-06-07T08:09:10.111Z");
    expect(core.schedulePersist).toHaveBeenCalledWith(
      session,
      "restore:cached_documents_metadata_reconcile",
    );
  });

  // 回归(Round1 评测 A#2):cached 重连 DB-win 时,基于旧版本锚点的 review/draft 态必须清空,
  // 否则 restore 会同时发 documentSnapshotWritten(新版) 与 docDiffReady(旧 base),前端拿旧锚点套新正文。
  it("cached 重连 DB-win 时清空陈旧 review/draft 态,不再发 docDiffReady", async () => {
    const bridge = await loadBridge();
    const { documentRepo } = await import("@qingagent/core");
    const session = await createCachedSession(bridge);
    const pm = legacySectionsToPm([section("正文内容")] as never);
    const now = new Date().toISOString();
    await documentRepo.save({
      id: session.docId,
      threadId: session.threadId ?? session.sessionId,
      resourceId: "test-resource",
      title: "t",
      docState: "editing",
      docVersion: 8,
      lastSyncedVersion: 0,
      pmDoc: pm,
      createdAt: now,
      updatedAt: now,
    });
    // 内存 session 停在陈旧版本 3,且带着基于旧版本的 review/draft 态
    session.docState = { kind: "editing" };
    session.legacySections = [section("正文内容")];
    session.doc = pm;
    session.docVersion = 3;
    session.suggestionBaseVersion = 3;
    session.suggestionBaseDoc = pm;
    session.docDraftBaseVersion = 3;
    session.suggestions.set("patch-stale", {
      messageId: "msg",
      toolCallId: "patch-stale",
      before: "old",
      after: "new",
      blockIndex: 0,
      suggestion: {
        id: "patch-stale",
        docId: session.docId,
        baseVersion: 3,
        baseSchemaVersion: pm.attrs.schemaVersion,
        status: "reviewing",
        anchor: { blockId: "block-stale", pmFrom: 1, pmTo: 2, quote: "old", textHash: "h" },
        patch: { kind: "prosemirror_steps", steps: [] },
        preview: { deleteText: "old", insertText: "new" },
        summary: "change",
      },
    });
    session.patchVerdicts.set("patch-stale", "accepted");
    // chatHistory 里有一条 reviewable docSuggestion 气泡(E#1:旧建议会被 step4 重放)
    session.chatHistory = [
      {
        id: "msg-sug",
        role: { kind: "agent" },
        ts: "2026-01-01T00:00:00.000Z",
        parts: [{ kind: "toolCall", data: toolCall("docSuggestion", { kind: "reviewing" }, "patch-stale") }],
        chips: null,
      },
    ];

    const frames = await collectFrames(
      bridge.handleCommand({
        kind: "startSession",
        data: { mode: { kind: "existing", data: { id: session.sessionId } } },
      }),
    );

    expect(session.docVersion).toBe(8);
    expect(session.suggestions.size).toBe(0);
    expect(session.patchVerdicts.size).toBe(0);
    expect(session.suggestionBaseVersion).toBeNull();
    expect(session.docDraftBaseVersion).toBeNull();
    expect(frames.some((frame) => frame.kind === "docDiffReady")).toBe(false);
    // E#1:chatHistory 里的 docSuggestion toolCall 被终止(不再 reviewing),重放也不再可操作
    const part0 = session.chatHistory[0]?.parts[0];
    expect(part0?.kind).toBe("toolCall");
    if (part0?.kind === "toolCall") {
      expect(part0.data.status.kind).toBe("failed");
    }
    const replayedReviewing = frames.some(
      (frame) =>
        frame.kind === "toolCallUpdated" &&
        frame.data.spec.name === "docSuggestion" &&
        frame.data.spec.status.kind === "reviewing",
    );
    expect(replayedReviewing).toBe(false);
  });

  it("恢复 pendingReview 时补发 docDiffReady 带 editedDoc", async () => {
    const bridge = await loadBridge();
    const session = await createCachedSession(bridge);
    const baseDoc = legacySectionsToPm([section("旧正文")] as never);
    const editedDoc = markedPmDoc("新正文");
    const suggestion = reviewSuggestion("restore-h1");
    session.docState = { kind: "pendingReview" };
    session.doc = baseDoc;
    session.legacySections = [section("旧正文")];
    session.docVersion = 4;
    session.suggestionBaseVersion = 4;
    session.suggestionBaseDoc = baseDoc;
    session.docDraftCandidateDoc = editedDoc;
    session.suggestions.set(suggestion.id, {
      messageId: "msg-review",
      toolCallId: suggestion.id,
      before: "旧",
      after: "新",
      blockIndex: 0,
      suggestion,
    });

    const frames = await collectFrames(
      bridge.handleCommand({
        kind: "startSession",
        data: { mode: { kind: "existing", data: { id: session.sessionId } } },
      }),
    );

    const diffFrame = frames.find((frame) => frame.kind === "docDiffReady");
    expect(diffFrame?.kind).toBe("docDiffReady");
    if (diffFrame?.kind !== "docDiffReady") throw new Error("missing docDiffReady");
    expect(diffFrame.data.previewDoc).toEqual(baseDoc);
    expect(diffFrame.data.editedDoc).toEqual(editedDoc);
  });

  it("冷恢复冲突只补发一次 draftingFailed，不生成 docDiffReady", async () => {
    const bridge = await loadBridge();
    const session = await createCachedSession(bridge);
    session.docState = { kind: "editing" };
    session._pendingDraftRecoveryFrames = [{
      kind: "stream",
      data: {
        kind: "draftingFailed",
        data: {
          streamId: `restored-pending-review:${session.sessionId}`,
          reason: "正文已变化，请重新生成本轮审阅。",
          retriable: false,
        },
      },
    }];

    const firstFrames = await collectFrames(
      bridge.handleCommand({
        kind: "startSession",
        data: { mode: { kind: "existing", data: { id: session.sessionId } } },
      }),
    );
    const secondFrames = await collectFrames(
      bridge.handleCommand({
        kind: "startSession",
        data: { mode: { kind: "existing", data: { id: session.sessionId } } },
      }),
    );

    expect(firstFrames).toContainEqual(expect.objectContaining({
      kind: "stream",
      data: expect.objectContaining({
        kind: "draftingFailed",
        data: expect.objectContaining({
          reason: "正文已变化，请重新生成本轮审阅。",
        }),
      }),
    }));
    expect(firstFrames.some((frame) => frame.kind === "docDiffReady")).toBe(false);
    expect(secondFrames.some(
      (frame) => frame.kind === "stream" && frame.data.kind === "draftingFailed",
    )).toBe(false);
  });

  // 回归(0702 桌面验收发现):重进现有会话必须先发 restoreReset,再发 sessionMeta + 还原帧。
  // 根因:直播 sendMessage 只把 agent 消息作为帧写进 FrameLog(user 消息只进 chatHistory、不发帧)。
  // 重进(startSession existing)把 emitRestoreFrames 追加到同一条 FrameLog 尾部;前端 after=0 重放时
  // 会先应用「直播残留的 agent 帧」、再应用还原帧 → ① 用户消息(只在还原里出现)排到 AI 回复之后
  // ② AI 消息重复(直播 + 还原)。前置 restoreReset 让前端清空后从 chatHistory 干净重建,顺序正确、无重复。
  it("重进现有会话先发 restoreReset,再按 chatHistory 顺序 [user, agent] 重放", async () => {
    const bridge = await loadBridge();
    const session = await createCachedSession(bridge);
    session.docState = { kind: "editing" };
    // 模拟一轮已完成对话:chatHistory 里 user 在前、agent 在后
    session.chatHistory = [
      {
        id: "u-1",
        role: { kind: "user" },
        ts: "2026-01-01T00:00:00.000Z",
        parts: [{ kind: "text", data: { body: "你好" } }],
        chips: null,
      },
      {
        id: "a-1",
        role: { kind: "agent" },
        ts: "2026-01-01T00:00:01.000Z",
        parts: [{ kind: "text", data: { body: "你好呀" } }],
        chips: null,
      },
    ];

    const frames = await collectFrames(
      bridge.handleCommand({
        kind: "startSession",
        data: { mode: { kind: "existing", data: { id: session.sessionId } } },
      }),
    );

    // restoreReset 必须存在,且排在所有 chatMessageAdded(还原帧)之前
    const resetIdx = frames.findIndex((frame) => frame.kind === "restoreReset");
    const addedIdxs = frames
      .map((frame, i) => (frame.kind === "chatMessageAdded" ? i : -1))
      .filter((i) => i >= 0);
    const completedIdx = frames.findIndex(
      (frame) => frame.kind === "sessionRestoreCompleted",
    );
    expect(resetIdx).toBeGreaterThanOrEqual(0);
    expect(addedIdxs.length).toBe(2);
    expect(resetIdx).toBeLessThan(addedIdxs[0]!);
    expect(completedIdx).toBeGreaterThan(addedIdxs.at(-1)!);

    // 还原按 chatHistory 顺序:user 在前、agent 在后(修复前只发 agent 帧,user 会被挤到后面)
    const addedRoles = frames
      .filter((frame) => frame.kind === "chatMessageAdded")
      .map((frame) => (frame.kind === "chatMessageAdded" ? frame.data.message.role.kind : null));
    expect(addedRoles).toEqual(["user", "agent"]);

    // restoreReset 载荷合法(snapshotSeq 为非负整数,前端 validator 要求)
    const resetFrame = frames[resetIdx];
    if (resetFrame?.kind !== "restoreReset") throw new Error("missing restoreReset");
    expect(Number.isInteger(resetFrame.data.snapshotSeq)).toBe(true);
    expect(resetFrame.data.snapshotSeq).toBeGreaterThanOrEqual(0);
  });

  it("同一旧消息重复恢复时派生稳定且互不冲突的消息 ID", async () => {
    const bridge = await loadBridge();
    const session = await createCachedSession(bridge);
    session.docState = { kind: "editing" };
    session.chatHistory = [];
    session.messages = [
      { role: "user", content: "第一条旧消息" },
      { role: "assistant", content: "第二条旧消息" },
    ] as never;

    const restore = async () => {
      const frames = await collectFrames(
        bridge.handleCommand({
          kind: "startSession",
          data: { mode: { kind: "existing", data: { id: session.sessionId } } },
        }),
      );
      return frames
        .filter((frame) => frame.kind === "chatMessageAdded")
        .map((frame) => frame.kind === "chatMessageAdded" ? frame.data.message.id : "");
    };

    const firstIds = await restore();
    const secondIds = await restore();

    expect(firstIds).toHaveLength(2);
    expect(new Set(firstIds).size).toBe(2);
    expect(secondIds).toEqual(firstIds);
  });

  it("恢复时同 id 的 Mastra 裸文本不能覆盖 actionCard 展示消息", async () => {
    const bridge = await loadBridge();
    const session = await createCachedSession(bridge);
    session.docState = { kind: "editing" };
    session.chatHistory = [{
      id: "m-user-action",
      role: { kind: "user" },
      ts: "2026-07-12T00:00:00.000Z",
      parts: [{
        kind: "actionCard",
        data: {
          title: "重新生成公众号稿",
          lines: [{ label: "模板", value: "产品发布" }],
        },
      }],
      chips: null,
    }];
    session.messages = [{
      id: "m-user-action",
      role: "user",
      content: "机器 query: regenerate_derivative doc_id=internal",
    } as never];
    session.streamId = "stream-active";

    const frames = await collectFrames(
      bridge.handleCommand({
        kind: "startSession",
        data: { mode: { kind: "existing", data: { id: session.sessionId } } },
      }),
    );

    const restored = frames.filter(
      (frame) => frame.kind === "chatMessageAdded" && frame.data.message.id === "m-user-action",
    );
    expect(restored).toHaveLength(1);
    expect(restored[0]?.kind === "chatMessageAdded" && restored[0].data.message.parts)
      .toEqual(session.chatHistory[0]?.parts);
  });

  // 回归(0702 review Lane A · P1「restore 后进行中消息冻结」):生成进行中触发 restore 快照
  // (gap/epoch 不匹配重连,或 startSession existing)时,该消息后续直播 chatMessageAppended 的
  // seq 延续 seqCounters 计数(如 48、49…)而非从 1 重数;前端 restoreReset 清空 appendCursor 后
  // 只应用严格连续 seq === cursor+1 的增量 → 缺基线则增量永久滞留、消息冻结,且 restoreReset
  // 广播会把同会话全部标签页一起冻住。修复:快照 chatMessageAdded 携带 appendSeq 基线。
  it("restore 重放的 chatMessageAdded 携带 seqCounters 的 appendSeq 基线(无计数则为 0)", async () => {
    const bridge = await loadBridge();
    const session = await createCachedSession(bridge);
    session.docState = { kind: "editing" };
    session.chatHistory = [
      {
        id: "u-done",
        role: { kind: "user" },
        ts: "2026-01-01T00:00:00.000Z",
        parts: [{ kind: "text", data: { body: "写一段散文" } }],
        chips: null,
      },
      {
        // 进行中的 agent 消息:parts 已被服务端合并成 1 个 text,但 append 计数已到 47。
        // (不能用 parts.length 当基线,这正是真机探针实锤过的坑。)
        id: "a-inflight",
        role: { kind: "agent" },
        ts: "2026-01-01T00:00:01.000Z",
        parts: [{ kind: "text", data: { body: "春天来了……(流式中)" } }],
        chips: null,
      },
    ];
    session.seqCounters.set("a-inflight", 47);

    const frames = await collectFrames(
      bridge.handleCommand({
        kind: "startSession",
        data: { mode: { kind: "existing", data: { id: session.sessionId } } },
      }),
    );

    const added = frames.filter((frame) => frame.kind === "chatMessageAdded");
    const inflight = added.find(
      (frame) => frame.kind === "chatMessageAdded" && frame.data.message.id === "a-inflight",
    );
    const finished = added.find(
      (frame) => frame.kind === "chatMessageAdded" && frame.data.message.id === "u-done",
    );
    if (inflight?.kind !== "chatMessageAdded") throw new Error("missing inflight added frame");
    if (finished?.kind !== "chatMessageAdded") throw new Error("missing finished added frame");
    // 进行中消息:基线 = seqCounters 真相源(47),前端以此初始化 appendCursor 后,
    // 直播 seq=48 的增量恰为 cursor+1,可继续应用。
    expect(inflight.data.appendSeq).toBe(47);
    // 无计数的消息:基线为 0(与前端 `?? 0` 默认一致)。
    expect(finished.data.appendSeq).toBe(0);
  });

  // 回归(同上 P1 的原子性半边):appendSeq 基线读取与消息内容必须同一同步 tick 捕获。
  // emitRestoreFrames 到 frameLog.append 之间存在微任务间隙(collectRestoreFrames 的
  // await / stream.ts 的 .then),活跃轮次可能继续往 chatHistory 消息 push parts + 涨计数;
  // 若快照帧持有共享引用,晚序列化的内容会多于基线 → 增量被重复应用(正文重复)。
  it("restore 快照的消息是深拷贝:快照后活跃轮次继续 push parts 不污染快照内容", async () => {
    const bridge = await loadBridge();
    const session = await createCachedSession(bridge);
    session.docState = { kind: "editing" };
    const liveMsg = {
      id: "a-live",
      role: { kind: "agent" as const },
      ts: "2026-01-01T00:00:01.000Z",
      parts: [{ kind: "text" as const, data: { body: "第一段" } }],
      chips: null,
    };
    session.chatHistory = [liveMsg];
    session.seqCounters.set("a-live", 3);

    const frames = await collectFrames(
      bridge.handleCommand({
        kind: "startSession",
        data: { mode: { kind: "existing", data: { id: session.sessionId } } },
      }),
    );
    // 模拟活跃轮次在「快照已产出、尚未落 FrameLog」的间隙继续流式:
    liveMsg.parts.push({ kind: "text", data: { body: "第二段(快照后新增)" } });
    session.seqCounters.set("a-live", 4);

    const snap = frames.find(
      (frame) => frame.kind === "chatMessageAdded" && frame.data.message.id === "a-live",
    );
    if (snap?.kind !== "chatMessageAdded") throw new Error("missing snapshot frame");
    // 快照内容停留在基线时刻:1 个 part、基线 3;共享引用会让这里变成 2 个 part。
    expect(snap.data.message).not.toBe(liveMsg);
    expect(snap.data.message.parts).toHaveLength(1);
    expect(snap.data.appendSeq).toBe(3);
  });

});
