import { afterEach, describe, expect, it } from "vitest";
import type {
  ChatMessage,
  DocSuggestion,
  ToolCallSpec,
  WorkspaceAction,
} from "./protocol";
import {
  initialWorkspaceState,
  selectOpenAskUser,
  selectPatches,
  selectSubAgents,
  workspaceReducer,
} from "./workspaceState";
import { deriveDocDimensions } from "./docDimensions";
import { canEditDocument, workspaceDataAttrs } from "./workspacePageView";
import { resources } from "../../../system/resources";
import {
  resourceMutationKey,
  workspaceMutations,
} from "./revisionedMutation";
import type { AnnotationGroup, DocumentSnapshot, FolderSource } from "@qingagent/contract-ts";
import { reconcileAssetPreview, toAssetSource } from "./sources";

function reduce(...frames: WorkspaceAction[]) {
  return frames.reduce(workspaceReducer, initialWorkspaceState);
}

/** 旧客户端缓存形态:只有 sections、无 doc。contract 已把 doc 转必填,
 * 这里显式 cast 模拟兼容窗口内的历史快照,验证 sections fallback 路径。 */
function legacyWireSnapshot(snap: Omit<DocumentSnapshot, "doc">): DocumentSnapshot {
  return snap as DocumentSnapshot;
}

const baseMessage: ChatMessage = {
  id: "m1",
  role: { kind: "agent" },
  ts: "2026-01-01T00:00:00.000Z",
  parts: [],
  chips: null,
};

const askUserToolCall: ToolCallSpec = {
  id: "tc-1",
  name: "askUser",
  render: { kind: "chatInline" },
  status: { kind: "pending" },
  body: {
    kind: "askUser",
    data: {
      id: "ask-1",
      mode: { kind: "overlay" },
      purpose: null,
      source: null,
      rationale: null,
      questions: [
        {
          id: "q-1",
          label: "选择方向",
          kind: { kind: "single" },
          options: [{ value: "a", label: "A", description: null, preview: null }],
          placeholder: null,
        },
      ],
    },
  },
  result: null,
};

const runningCommandToolCall: ToolCallSpec = {
  id: "tc-command-1",
  name: "execute_command",
  render: { kind: "chatInline" },
  status: {
    kind: "running",
    data: { progressPct: null, etaSec: null },
  },
  body: {
    kind: "generic",
    data: { argsJson: '{"cmd":"pnpm test"}' },
  },
  result: null,
};

const streamedPmDoc = {
  type: "doc" as const,
  attrs: { schemaVersion: 1 as const },
  content: [
    {
      type: "paragraph" as const,
      attrs: { blockId: "block-1" },
      content: [
        {
          type: "text" as const,
          text: "加粗正文",
          marks: [{ type: "bold" as const }],
        },
      ],
    },
  ],
};

const streamedPmNode = streamedPmDoc.content[0]!;

function reviewSuggestion(
  id: string,
  reviewBatchId = id,
  status: DocSuggestion["status"] = "reviewing",
): DocSuggestion {
  return {
    id,
    reviewBatchId,
    groupMode: "independent",
    docId: "doc-1",
    baseVersion: 1,
    baseSchemaVersion: 1,
    status,
    anchor: {
      blockId: `block-${id}`,
      pmFrom: 1,
      pmTo: 2,
      quote: "旧",
      textHash: `hash-${id}`,
    },
    patch: { kind: "prosemirror_steps", steps: [] },
    preview: { deleteText: "旧", insertText: "新" },
    summary: "修改",
  };
}

function committedPatchSpec(suggestion: DocSuggestion): ToolCallSpec {
  return patchSpec(suggestion, "committed");
}

function patchSpec(
  suggestion: DocSuggestion,
  status: "accepted" | "rejected" | "committed",
): ToolCallSpec {
  return {
    id: suggestion.id,
    name: "docSuggestion",
    render: { kind: "docInlinePatch" },
    status: { kind: status },
    body: {
      kind: "docSuggestion",
      data: {
        kind: "suggestion",
        data: { ...suggestion, status },
      },
    },
    result: null,
  };
}

function failedPatchSpec(suggestion: DocSuggestion, reason: string): ToolCallSpec {
  const spec = patchSpec(suggestion, "accepted");
  return {
    ...spec,
    status: { kind: "failed", data: { retriable: false, reason } },
  };
}

function patchSummaryReviewOutcome(message: ChatMessage | undefined): string | null {
  const part = message?.parts.find((p) => p.kind === "patchSummary");
  if (!part || part.kind !== "patchSummary") return null;
  return (part.data as typeof part.data & { reviewOutcome?: string }).reviewOutcome ?? null;
}

function patchSummaryAppliedCount(message: ChatMessage | undefined): number | null {
  const part = message?.parts.find((p) => p.kind === "patchSummary");
  if (!part || part.kind !== "patchSummary") return null;
  return part.data.appliedCount ?? null;
}

function patchSummaryConflictCount(message: ChatMessage | undefined): number | null {
  const part = message?.parts.find((p) => p.kind === "patchSummary");
  if (!part || part.kind !== "patchSummary") return null;
  return part.data.conflictCount ?? null;
}

describe("workspaceReducer", () => {
  afterEach(() => resources.reset());

  describe("sessionMeta", () => {
    const userMessage: ChatMessage = {
      id: "m-user-1",
      role: { kind: "user" },
      ts: "2026-01-01T00:00:00.000Z",
      parts: [{ kind: "text", data: { body: "hello" } }],
      chips: null,
    };

    it("preserves messages when the same session id is repeated", () => {
      const seeded = reduce(
        {
          kind: "sessionMeta",
          data: { sessionId: "session-A", title: "A" },
        },
        { kind: "chatMessageAdded", data: { message: userMessage } },
      );

      const next = workspaceReducer(seeded, {
        kind: "sessionMeta",
        data: { sessionId: "session-A", title: "A updated" },
      });

      expect(next.sessionId).toBe("session-A");
      expect(next.title).toBe("A updated");
      expect(next.messages).toHaveLength(1);
      expect(next.messages[0]?.id).toBe("m-user-1");
    });

    it("resets session-scoped state when the session id changes", () => {
      const seeded = reduce(
        {
          kind: "sessionMeta",
          data: { sessionId: "session-A", title: "A" },
        },
        { kind: "chatMessageAdded", data: { message: userMessage } },
        { kind: "viewingVersionSet", version: 2 },
      );

      const next = workspaceReducer(seeded, {
        kind: "sessionMeta",
        data: { sessionId: "session-B", title: "B" },
      });

      expect(next.sessionId).toBe("session-B");
      expect(next.messages).toHaveLength(0);
      expect(next.docState).toEqual({ kind: "empty" });
      expect(next.viewingVersion).toBeNull();
    });

    it("会话切换会清除忙碌态、活跃流和运行中工具", () => {
      const seeded = reduce(
        {
          kind: "sessionMeta",
          data: { sessionId: "session-A", title: "A" },
        },
        {
          kind: "stream",
          data: { kind: "start", data: { streamId: "stream-A" } },
        },
        {
          kind: "toolCallUpdated",
          data: {
            messageId: "m-agent",
            toolCallId: runningCommandToolCall.id,
            spec: runningCommandToolCall,
          },
        },
      );
      expect(seeded.agentBusy).toBe(true);

      const next = workspaceReducer(seeded, {
        kind: "sessionMeta",
        data: { sessionId: "session-B", title: "B" },
      });

      expect(next.agentBusy).toBe(false);
      expect(next.streamActive).toBe(false);
      expect(next.activeStreamIds).toEqual([]);
      expect(next.toolCalls.size).toBe(0);
    });
  });

  it("翻译生成帧按 docId 累积文本、隔离失败并在完成后清理", () => {
    const streaming = reduce(
      { kind: "derivativeGenStarted", data: { docId: "en", targetLang: "英语" } },
      { kind: "derivativeGenStarted", data: { docId: "ja", targetLang: "日语" } },
      { kind: "derivativeGenDelta", data: { docId: "en", text: "<p>Hello" } },
      { kind: "derivativeGenDelta", data: { docId: "en", text: " world</p>" } },
      { kind: "derivativeGenFailed", data: { docId: "ja", reason: "译文生成失败，请重试" } },
    );
    expect(streaming.translationGen.get("en")).toEqual({ status: "streaming", text: "<p>Hello world</p>" });
    expect(streaming.translationGen.get("ja")).toEqual({ status: "failed", text: "", reason: "译文生成失败，请重试" });

    const finished = workspaceReducer(streaming, {
      kind: "derivativeGenFinished",
      data: { docId: "en", generatedAt: "2026-07-15T00:00:00.000Z", docVersion: 1 },
    });
    expect(finished.translationGen.has("en")).toBe(false);
    expect(finished.translationGen.get("ja")?.status).toBe("failed");

    const aborted = workspaceReducer(streaming, {
      kind: "streamTerminated",
      reason: "stop",
    });
    expect(aborted.translationGen.get("en")).toEqual({
      status: "aborted",
      text: "<p>Hello world</p>",
    });
    expect(aborted.translationGen.get("ja")?.status).toBe("failed");
  });

describe("annotationGroupsReady 来源增量", () => {
  const annotation = (id: string, origin: string, status: AnnotationGroup["status"] = "reviewing"): AnnotationGroup => ({
    id,
    origin,
    status,
    summary: id,
    note: `${id}-note`,
    anchors: [{ blockId: "p-1", pmFrom: 1, pmTo: 2, quote: "甲", textHash: `${id}-hash` }],
  });

  it("同 origin 换代保留其他来源，并用同 id 权威状态回正前端乐观态", () => {
    const seeded = workspaceReducer(initialWorkspaceState, {
      kind: "annotationGroupsChanged",
      groups: [annotation("source-old", "source-check"), annotation("consistent", "consistency", "accepted")],
    });
    const next = workspaceReducer(seeded, {
      kind: "annotationGroupsReady",
      data: {
        groups: [annotation("source-new", "source-check"), annotation("consistent", "consistency")],
        replacedOrigins: ["source-check", "consistency"],
      },
    });

    expect(next.annotationGroups.map((group) => group.id).sort()).toEqual(["consistent", "source-new"]);
    expect(next.annotationGroups.find((group) => group.id === "consistent")?.status).toBe("reviewing");
  });
});

  it("folderSourcesChanged 全量替换当前会话文件夹资料库", () => {
    const source: FolderSource = {
      id: "fld_test",
      sessionId: "s1",
      provider: "desktop-local",
      name: "客户资料",
      pathLabel: "~/Documents/客户资料",
      mountName: "source_test",
      mountPath: "/sources/source_test",
      readOnly: true,
      fileCount: 14,
      fileCountCapped: false,
      status: "connected",
      error: null,
      createdAt: "2026-06-18T00:00:00.000Z",
      updatedAt: "2026-06-18T00:00:00.000Z",
    };

    const state = workspaceReducer(initialWorkspaceState, {
      kind: "sessionMeta",
      data: { sessionId: "s1", title: "s1" },
    });

    const next = workspaceReducer(state, {
      kind: "folderSourcesChanged",
      data: { sessionId: "s1", sources: [source] },
    });
    expect(next.folderSources).toEqual([source]);

    const cleared = workspaceReducer(next, {
      kind: "folderSourcesChanged",
      data: { sessionId: "s1", sources: [] },
    });
    expect(cleared.folderSources).toEqual([]);

    const ignored = workspaceReducer(cleared, {
      kind: "folderSourcesChanged",
      data: { sessionId: "s2", sources: [source] },
    });
    expect(ignored.folderSources).toEqual([]);
  });

  describe("chatMessageAppended", () => {
    it("dedupes by seq (idempotent on replay)", () => {
      const next = reduce(
        { kind: "chatMessageAdded", data: { message: baseMessage } },
        {
          kind: "chatMessageAppended",
          data: {
            messageId: "m1",
            seq: 1,
            part: { kind: "toolCall", data: askUserToolCall },
          },
        },
        {
          kind: "chatMessageAppended",
          data: {
            messageId: "m1",
            seq: 1,
            part: { kind: "toolCall", data: askUserToolCall },
          },
        },
      );
      const msg = next.messages.find((m) => m.id === "m1");
      expect(msg?.parts).toHaveLength(1);
      expect(next.appendCursor["m1"]).toBe(1);
    });

    it("buffers out-of-order appends and drains on chatMessageAdded", () => {
      const buffered = reduce({
        kind: "chatMessageAppended",
        data: {
          messageId: "m1",
          seq: 1,
          part: { kind: "toolCall", data: askUserToolCall },
        },
      });
      expect(buffered.messages).toHaveLength(0);
      expect(buffered.pendingAppends["m1"]).toHaveLength(1);

      const drained = workspaceReducer(buffered, {
        kind: "chatMessageAdded",
        data: { message: baseMessage },
      });
      expect(drained.pendingAppends["m1"]).toBeUndefined();
      const msg = drained.messages.find((m) => m.id === "m1");
      expect(msg?.parts).toHaveLength(1);
    });

    it("buffers a gap (seq=2 before seq=1) then drains in order, coalescing adjacent text parts", () => {
      const partA = { kind: "text" as const, data: { body: "first " } };
      const partB = { kind: "text" as const, data: { body: "second" } };
      const next = reduce(
        { kind: "chatMessageAdded", data: { message: baseMessage } },
        {
          kind: "chatMessageAppended",
          data: { messageId: "m1", seq: 2, part: partB },
        },
        {
          kind: "chatMessageAppended",
          data: { messageId: "m1", seq: 1, part: partA },
        },
      );
      const msg = next.messages.find((m) => m.id === "m1");
      // Per-character / multi-fragment text streams coalesce into a
      // single text part to avoid one-DOM-block-per-char rendering.
      expect(msg?.parts).toHaveLength(1);
      expect(msg?.parts[0]?.kind === "text" && msg.parts[0].data.body).toBe(
        "first second",
      );
      expect(next.appendCursor["m1"]).toBe(2);
    });

    it("a duplicate chatMessageAdded preserves applied appends", () => {
      const partA = { kind: "text" as const, data: { body: "x" } };
      const next = reduce(
        { kind: "chatMessageAdded", data: { message: baseMessage } },
        {
          kind: "chatMessageAppended",
          data: { messageId: "m1", seq: 1, part: partA },
        },
        { kind: "chatMessageAdded", data: { message: baseMessage } },
      );
      const msg = next.messages.find((m) => m.id === "m1");
      expect(msg?.parts).toHaveLength(1);
      expect(next.appendCursor["m1"]).toBe(1);
    });

    it("uses restore chatMessageAdded.appendSeq as the append cursor baseline", () => {
      const beforeRestore = reduce(
        { kind: "chatMessageAdded", data: { message: baseMessage } },
        ...Array.from({ length: 47 }, (_, index): WorkspaceAction => ({
          kind: "chatMessageAppended",
          data: {
            messageId: "m1",
            seq: index + 1,
            part: { kind: "text", data: { body: `${index + 1},` } },
          },
        })),
      );
      expect(beforeRestore.appendCursor["m1"]).toBe(47);

      const reset = workspaceReducer(beforeRestore, {
        kind: "restoreReset",
        data: { epoch: 2, snapshotSeq: 10 },
      });
      const restored = workspaceReducer(reset, {
        kind: "chatMessageAdded",
        data: {
          message: {
            ...baseMessage,
            parts: [{ kind: "text", data: { body: "snapshot-" } }],
          },
          appendSeq: 47,
        },
      });
      const next = workspaceReducer(restored, {
        kind: "chatMessageAppended",
        data: {
          messageId: "m1",
          seq: 48,
          part: { kind: "text", data: { body: "tail" } },
        },
      });

      expect(next.pendingAppends["m1"]).toBeUndefined();
      expect(next.appendCursor["m1"]).toBe(48);
      const msg = next.messages.find((m) => m.id === "m1");
      expect(msg?.parts).toEqual([{ kind: "text", data: { body: "snapshot-tail" } }]);
    });

    it("drains a post-restore append buffered before chatMessageAdded arrives", () => {
      const reset = workspaceReducer(
        reduce(
          { kind: "chatMessageAdded", data: { message: baseMessage } },
          ...Array.from({ length: 47 }, (_, index): WorkspaceAction => ({
            kind: "chatMessageAppended",
            data: {
              messageId: "m1",
              seq: index + 1,
              part: { kind: "text", data: { body: `${index + 1},` } },
            },
          })),
        ),
        { kind: "restoreReset", data: { epoch: 2, snapshotSeq: 10 } },
      );
      const buffered = workspaceReducer(reset, {
        kind: "chatMessageAppended",
        data: {
          messageId: "m1",
          seq: 48,
          part: { kind: "text", data: { body: "tail" } },
        },
      });
      expect(buffered.pendingAppends["m1"]).toHaveLength(1);

      const next = workspaceReducer(buffered, {
        kind: "chatMessageAdded",
        data: {
          message: {
            ...baseMessage,
            parts: [{ kind: "text", data: { body: "snapshot-" } }],
          },
          appendSeq: 47,
        },
      });

      expect(next.pendingAppends["m1"]).toBeUndefined();
      expect(next.appendCursor["m1"]).toBe(48);
      const msg = next.messages.find((m) => m.id === "m1");
      expect(msg?.parts).toEqual([{ kind: "text", data: { body: "snapshot-tail" } }]);
    });

    it("appended toolCall part lands in toolCalls map", () => {
      const next = reduce(
        { kind: "chatMessageAdded", data: { message: baseMessage } },
        {
          kind: "chatMessageAppended",
          data: {
            messageId: "m1",
            seq: 1,
            part: { kind: "toolCall", data: askUserToolCall },
          },
        },
      );
      expect(next.toolCalls.get("tc-1")).toEqual(askUserToolCall);
    });
  });

  describe("toolCallUpdated", () => {
    it("replaces tool-call snapshot + mirrors into message.parts", () => {
      const seeded = reduce(
        { kind: "chatMessageAdded", data: { message: baseMessage } },
        {
          kind: "chatMessageAppended",
          data: {
            messageId: "m1",
            seq: 1,
            part: { kind: "toolCall", data: askUserToolCall },
          },
        },
      );
      const updated: ToolCallSpec = {
        ...askUserToolCall,
        status: { kind: "done" },
      };
      const next = workspaceReducer(seeded, {
        kind: "toolCallUpdated",
        data: { messageId: "m1", toolCallId: "tc-1", spec: updated },
      });
      expect(next.toolCalls.get("tc-1")?.status).toEqual({ kind: "done" });
      const part = next.messages[0]?.parts[0];
      expect(part?.kind === "toolCall" && part.data.status).toEqual({
        kind: "done",
      });
    });

    it("is idempotent on replay (same snapshot is no-op-ish)", () => {
      const seeded = reduce(
        { kind: "chatMessageAdded", data: { message: baseMessage } },
        {
          kind: "chatMessageAppended",
          data: {
            messageId: "m1",
            seq: 1,
            part: { kind: "toolCall", data: askUserToolCall },
          },
        },
      );
      const next = workspaceReducer(seeded, {
        kind: "toolCallUpdated",
        data: { messageId: "m1", toolCallId: "tc-1", spec: askUserToolCall },
      });
      expect(next.toolCalls.get("tc-1")).toEqual(askUserToolCall);
    });

    it("只更新已有 toolCall part,不会在 message 中反向新建 part", () => {
      const seeded = reduce({
        kind: "chatMessageAdded",
        data: { message: { ...baseMessage, parts: [{ kind: "text", data: { body: "agent text" } }] } },
      });
      const updated: ToolCallSpec = {
        ...askUserToolCall,
        status: { kind: "running", data: { progressPct: 0.5, etaSec: null } },
      };

      const next = workspaceReducer(seeded, {
        kind: "toolCallUpdated",
        data: { messageId: "m1", toolCallId: "tc-1", spec: updated },
      });

      expect(next.toolCalls.get("tc-1")).toEqual(updated);
      expect(next.messages[0]?.parts).toEqual([
        { kind: "text", data: { body: "agent text" } },
      ]);
    });

    it("乐观清 askUser overlay:open(pending)→done 的当前卡被作答才清", () => {
      // 后端先发 docStateChanged(activeOverlay=askUser),前端把当前 pending 卡作答后翻 done。
      const seeded = reduce(
        {
          kind: "docStateChanged",
          data: {
            state: { kind: "editing" },
            activeOverlay: "askUser",
            agentBusy: false,
          },
        },
        { kind: "chatMessageAdded", data: { message: baseMessage } },
        {
          kind: "chatMessageAppended",
          data: {
            messageId: "m1",
            seq: 1,
            part: { kind: "toolCall", data: askUserToolCall },
          },
        },
      );
      expect(seeded.activeOverlay).toBe("askUser");
      const answered: ToolCallSpec = { ...askUserToolCall, status: { kind: "done" } };
      const next = workspaceReducer(seeded, {
        kind: "toolCallUpdated",
        data: { messageId: "m1", toolCallId: "tc-1", spec: answered },
      });
      expect(next.activeOverlay).toBeNull();
    });

    it("冷恢复死锁回归:重放历史已终态 askUser 卡不得清掉属于另一张活跃卡的 overlay", () => {
      // 复现冷恢复死锁:重放里先来 docStateChanged(activeOverlay=askUser,
      // owner 指向仍 pending 的新反问卡),随后 chatHistory 重放历史上早已 done/failed 的旧 askUser
      // toolCallUpdated。旧实现对任何 done/failed askUser 都乐观清 overlay → 把活跃卡的 overlay 误清,
      // 前端不显示卡、不锁输入框,后端 hasActiveSuspension 仍 true → 发消息被拒"请先完成问卷"。
      // 修复:只有【已知 open 的卡】翻终态才清;首次见到就已是终态(prevSpec===undefined)不清。
      const oldDoneAskUser: ToolCallSpec = {
        ...askUserToolCall,
        id: "tc-old-done",
        status: { kind: "done" },
      };
      const oldFailedAskUser: ToolCallSpec = {
        ...askUserToolCall,
        id: "tc-old-failed",
        status: { kind: "failed", data: { retriable: false, reason: "上次的确认已结束，请重新发起。" } },
      };
      const seeded = reduce({
        kind: "docStateChanged",
        data: {
          state: { kind: "editing" },
          activeOverlay: "askUser",
          agentBusy: false,
        },
      });
      expect(seeded.activeOverlay).toBe("askUser");
      // 重放旧 done 卡(首次见到即终态)——不得清 overlay。
      const afterDone = workspaceReducer(seeded, {
        kind: "toolCallUpdated",
        data: { messageId: "m-old", toolCallId: "tc-old-done", spec: oldDoneAskUser },
      });
      expect(afterDone.activeOverlay).toBe("askUser");
      // 重放旧 failed 卡——同样不得清 overlay。
      const afterFailed = workspaceReducer(afterDone, {
        kind: "toolCallUpdated",
        data: { messageId: "m-old", toolCallId: "tc-old-failed", spec: oldFailedAskUser },
      });
      expect(afterFailed.activeOverlay).toBe("askUser");
    });
  });

  describe("documentSnapshotWritten", () => {
    it("converts wire DocumentSnapshot → view shape", () => {
      const next = workspaceReducer(initialWorkspaceState, {
        kind: "documentSnapshotWritten",
        data: {
          doc: legacyWireSnapshot({
            version: 13,
            ts: "2026-05-08T00:00:00Z",
            sections: [
              { kind: "h1", data: { text: "Title" } },
              { kind: "p", data: { text: "Body." } },
            ],
          }),
        },
      });
      expect(next.doc?.version).toBe(13);
      expect(next.doc?.sections[0]).toEqual({ kind: "h1", text: "Title" });
      const para = next.doc?.sections[1];
      expect(para?.kind === "p" && para.spans).toEqual([
        { kind: "text", text: "Body." },
      ]);
    });

    it("恢复正文到达时把残留 empty 收敛为 editing", () => {
      const next = workspaceReducer(initialWorkspaceState, {
        kind: "documentSnapshotWritten",
        data: {
          doc: legacyWireSnapshot({
            version: 14,
            ts: "2026-07-30T00:00:00Z",
            sections: [{ kind: "p", data: { text: "已恢复正文" } }],
          }),
        },
      });

      expect(next.docState).toEqual({ kind: "editing" });
      expect(next.doc?.version).toBe(14);
    });

    it("重开已完成文档时 restoreReset 清掉旧 busy，canonical 快照直接恢复 editing", () => {
      const stale = reduce(
        {
          kind: "sessionMeta",
          data: { sessionId: "reopen-finished", title: "已完成文档" },
        },
        {
          kind: "stream",
          data: { kind: "start", data: { streamId: "stale-stream" } },
        },
      );
      const restoreFrames: WorkspaceAction[] = [
        { kind: "restoreReset", data: { epoch: 2, snapshotSeq: 20 } },
        {
          kind: "docStateChanged",
          data: {
            state: { kind: "empty" },
            activeOverlay: null,
            agentBusy: false,
          },
        },
        {
          kind: "documentSnapshotWritten",
          data: {
            doc: legacyWireSnapshot({
              version: 15,
              ts: "2026-08-01T00:00:00Z",
              sections: [{ kind: "p", data: { text: "重开后的正文" } }],
            }),
          },
        },
      ];
      const reopened = restoreFrames.reduce(workspaceReducer, stale);

      expect(reopened.streamActive).toBe(false);
      expect(reopened.activeStreamIds).toEqual([]);
      expect(reopened.agentBusy).toBe(false);
      expect(reopened.docState).toEqual({ kind: "editing" });
      const dimensions = deriveDocDimensions(reopened);
      expect(dimensions.editor).toBe("editable");
      expect(canEditDocument(dimensions, null)).toBe(true);
    });
  });

  describe("docGenerationEvent", () => {
    it("canonical 终稿到达时把残留 empty 收敛为 editing", () => {
      const finished = workspaceReducer(initialWorkspaceState, {
        kind: "docGenerationEvent",
        data: {
          kind: "generation_finished",
          data: {
            generationId: "generation-canonical",
            seq: 1,
            prevSeq: null,
            doc: streamedPmDoc,
            finalVersion: 1,
            contentHash: "pmv1-canonical",
          },
        },
      });

      expect(finished.docState).toEqual({ kind: "editing" });
      expect(deriveDocDimensions(finished).editor).toBe("editable");
    });

    it("assembles block/run events into a non-canonical generation draft with marks", () => {
      const state = reduce(
        {
          kind: "docGenerationEvent",
          data: {
            kind: "generation_started",
            data: {
              generationId: "g1",
              seq: 1,
              prevSeq: null,
              sessionId: "session-1",
              baseVersion: 0,
            },
          },
        },
        {
          kind: "docGenerationEvent",
          data: {
            kind: "block_started",
            data: {
              generationId: "g1",
              seq: 2,
              prevSeq: 1,
              blockId: "block-1",
              index: 0,
              blockType: "paragraph",
            },
          },
        },
        {
          kind: "docGenerationEvent",
          data: {
            kind: "inline_appended",
            data: {
              generationId: "g1",
              seq: 3,
              prevSeq: 2,
              blockId: "block-1",
              index: 0,
              appendOffset: 0,
              run: { text: "加粗正文", marks: [{ type: "bold" }] },
            },
          },
        },
      );

      expect(state.doc).toBeNull();
      expect(state.generationDraft?.doc.pmDoc?.content[0]).toMatchObject({
        type: "paragraph",
        content: [{ text: "加粗正文", marks: [{ type: "bold" }] }],
      });
    });

    it("is idempotent by generation seq and does not append duplicate runs", () => {
      const started = reduce({
        kind: "docGenerationEvent",
        data: {
          kind: "generation_started",
          data: { generationId: "g1", seq: 1, prevSeq: null, sessionId: "session-1", baseVersion: 0 },
        },
      });
      const runFrame: WorkspaceAction = {
        kind: "docGenerationEvent",
        data: {
          kind: "inline_appended",
          data: {
            generationId: "g1",
            seq: 2,
            prevSeq: 1,
            blockId: "block-1",
            index: 0,
            appendOffset: 0,
            run: { text: "只追加一次" },
          },
        },
      };

      const once = workspaceReducer(started, runFrame);
      const twice = workspaceReducer(once, runFrame);
      const paragraph = twice.generationDraft?.doc.pmDoc?.content[0];
      const firstInline = paragraph?.type === "paragraph" ? paragraph.content?.[0] : null;

      expect(paragraph?.type).toBe("paragraph");
      expect(firstInline?.type === "text" ? firstInline.text : null).toBe("只追加一次");
      expect(twice.generationDraft?.lastSeq).toBe(2);
    });

    it("stops local draft application on seq gap and accepts final canonical doc", () => {
      const started = reduce({
        kind: "docGenerationEvent",
        data: {
          kind: "generation_started",
          data: { generationId: "g1", seq: 1, prevSeq: null, sessionId: "session-1", baseVersion: 0 },
        },
      });
      const gapped = workspaceReducer(started, {
        kind: "docGenerationEvent",
        data: {
          kind: "inline_appended",
          data: {
            generationId: "g1",
            seq: 3,
            prevSeq: 2,
            blockId: "block-1",
            index: 0,
            appendOffset: 0,
            run: { text: "不应显示" },
          },
        },
      });

      expect(gapped.generationDraft?.gapDetected).toBe(true);
      expect(gapped.generationDraft?.doc.pmDoc?.content).toEqual([]);

      const finished = workspaceReducer(gapped, {
        kind: "docGenerationEvent",
        data: {
          kind: "generation_finished",
          data: {
            generationId: "g1",
            seq: 4,
            prevSeq: 3,
            doc: streamedPmDoc,
            finalVersion: 1,
            contentHash: "pmv1-final",
          },
        },
      });

      expect(finished.generationDraft).toBeNull();
      expect(finished.doc?.version).toBe(1);
      expect(finished.doc?.pmDoc?.content[0]).toEqual(streamedPmNode);
    });

    it("candidate_snapshot 立即替换非 canonical 投影且不提前推进正式版本", () => {
      const started = reduce({
        kind: "docGenerationEvent",
        data: {
          kind: "generation_started",
          data: {
            generationId: "g-candidate",
            seq: 1,
            prevSeq: null,
            sessionId: "session-1",
            baseVersion: 3,
          },
        },
      });

      const projected = workspaceReducer(started, {
        kind: "docGenerationEvent",
        data: {
          kind: "candidate_snapshot",
          data: {
            generationId: "g-candidate",
            seq: 2,
            prevSeq: 1,
            doc: streamedPmDoc,
            baseVersion: 3,
            contentHash: "pmv1-candidate",
          },
        },
      });

      expect(projected.generationDraft?.doc.pmDoc?.content[0]).toEqual(streamedPmNode);
      expect(projected.generationDraft?.lastSeq).toBe(2);
      expect(projected.generationDraft?.baseVersion).toBe(3);
      expect(projected.version).toBe(initialWorkspaceState.version);
      expect(projected.doc).toBeNull();
    });

    it("generation_finished 后仍有活跃流和运行中工具时保持忙碌与编辑锁", () => {
      const busy = reduce(
        {
          kind: "docStateChanged",
          data: { state: { kind: "drafting" }, activeOverlay: null, agentBusy: true },
        },
        {
          kind: "stream",
          data: { kind: "start", data: { streamId: "s1" } },
        },
        {
          kind: "toolCallUpdated",
          data: {
            messageId: "m-agent",
            toolCallId: runningCommandToolCall.id,
            spec: runningCommandToolCall,
          },
        },
      );
      expect(busy.agentBusy).toBe(true);
      expect(busy.streamActive).toBe(true);

      const finished = workspaceReducer(busy, {
        kind: "docGenerationEvent",
        data: {
          kind: "generation_finished",
          data: {
            generationId: "g1",
            seq: 2,
            prevSeq: 1,
            doc: streamedPmDoc,
            finalVersion: 1,
            contentHash: "pmv1-final",
          },
        },
      });

      expect(finished.doc?.pmDoc?.content[0]).toEqual(streamedPmNode);
      expect(finished.generationDraft).toBeNull();
      expect(finished.agentBusy).toBe(true);
      expect(finished.streamActive).toBe(true);
      expect(finished.activeStreamIds).toEqual(["s1"]);
      const dimensions = deriveDocDimensions(finished);
      expect(dimensions.editor).toBe("locked");
      expect(workspaceDataAttrs(dimensions).tool).toBe("agentBusy");
      expect(canEditDocument(dimensions, null)).toBe(false);
    });

    it("后端 busy=false 但工具仍在运行时继续保持呼吸提示与编辑锁", () => {
      const running = reduce({
        kind: "toolCallUpdated",
        data: {
          messageId: "m-agent",
          toolCallId: runningCommandToolCall.id,
          spec: runningCommandToolCall,
        },
      });
      const projectedIdle = workspaceReducer(running, {
        kind: "docStateChanged",
        data: {
          state: { kind: "editing" },
          activeOverlay: null,
          agentBusy: false,
        },
      });

      expect(projectedIdle.streamActive).toBe(false);
      expect(projectedIdle.agentBusy).toBe(true);
      const dimensions = deriveDocDimensions(projectedIdle);
      expect(dimensions.editor).toBe("locked");
      expect(workspaceDataAttrs(dimensions).tool).toBe("agentBusy");
      expect(canEditDocument(dimensions, null)).toBe(false);
    });
  });

  describe("docDiffReady", () => {
    it("stores the final diff payload for the review/apply stage", () => {
      const next = workspaceReducer(initialWorkspaceState, {
        kind: "docDiffReady",
        data: {
          baseVersion: 4,
          suggestions: [
            {
              id: "h1",
              docId: "doc-1",
              baseVersion: 4,
              baseSchemaVersion: 1,
              status: "reviewing",
              anchor: {
                blockId: "block-1",
                pmFrom: 1,
                pmTo: 2,
                quote: "旧",
                textHash: "test",
              },
              patch: { kind: "prosemirror_steps", steps: [] },
              preview: { deleteText: "旧", insertText: "新" },
              summary: "修改",
            },
          ],
        },
      });

      expect(next.docDiff?.baseVersion).toBe(4);
      expect(next.docDiff?.suggestions[0]?.preview.insertText).toBe("新");
    });

    it("clears stale diff payload when a doc version is written", () => {
      const withDiff = workspaceReducer(initialWorkspaceState, {
        kind: "docDiffReady",
        data: { baseVersion: 1, suggestions: [] },
      });
      const next = workspaceReducer(withDiff, {
        kind: "documentSnapshotWritten",
        data: {
          doc: legacyWireSnapshot({
            version: 2,
            ts: "2026-05-08T00:00:00Z",
            sections: [{ kind: "p", data: { text: "正文" } }],
          }),
        },
      });

      expect(next.docDiff).toBeNull();
    });

    it("committed tool-call removes the resolved review batch from docDiff precisely", () => {
      const first = reviewSuggestion("h1", "batch-1");
      const secondSameBatch = reviewSuggestion("h2", "batch-1");
      const thirdOtherBatch = reviewSuggestion("h3", "batch-2");
      const withDiff = reduce(
        {
          kind: "docStateChanged",
          data: { state: { kind: "pendingReview" }, activeOverlay: null, agentBusy: false },
        },
        {
          kind: "docDiffReady",
          data: {
            baseVersion: 1,
            suggestions: [first, secondSameBatch, thirdOtherBatch],
          },
        },
      );

      const next = workspaceReducer(withDiff, {
        kind: "toolCallUpdated",
        data: {
          messageId: "m-review",
          toolCallId: first.id,
          spec: committedPatchSpec(first),
        },
      });

      expect(next.docDiff?.suggestions.map((suggestion) => suggestion.id)).toEqual(["h3"]);
      expect(selectPatches(next).map((patch) => patch.id)).toEqual(["h3"]);
    });

    it("successful no-op commit frame clears stale rejected docDiff and unlocks review", () => {
      const withStaleRejectedDiff = reduce(
        {
          kind: "documentSnapshotWritten",
          data: {
            doc: legacyWireSnapshot({
              version: 1,
              ts: "2026-05-08T00:00:00Z",
              sections: [{ kind: "p", data: { text: "正文" } }],
            }),
          },
        },
        {
          kind: "docDiffReady",
          data: {
            baseVersion: 1,
            suggestions: [reviewSuggestion("resolved", "resolved-batch", "rejected")],
          },
        },
        {
          kind: "docStateChanged",
          data: { state: { kind: "pendingReview" }, activeOverlay: null, agentBusy: false },
        },
      );

      const next = workspaceReducer(withStaleRejectedDiff, {
        kind: "docStateChanged",
        data: { state: { kind: "editing" }, activeOverlay: null, agentBusy: false },
      });

      expect(next.docState).toEqual({ kind: "editing" });
      expect(next.docDiff).toBeNull();
      expect(selectPatches(next)).toEqual([]);
    });

    it("全拒绝候选收尾时给历史 patchSummary 标记已放弃", () => {
      const first = reviewSuggestion("h1", "batch-1");
      const second = reviewSuggestion("h2", "batch-2");
      const reviewMessage: ChatMessage = {
        ...baseMessage,
        id: "m-review",
        parts: [{ kind: "patchSummary", data: { count: 2, hunkIds: ["h1", "h2"] } }],
      };
      const rejected = reduce(
        { kind: "chatMessageAdded", data: { message: reviewMessage } },
        {
          kind: "docDiffReady",
          data: { baseVersion: 1, suggestions: [first, second] },
        },
        {
          kind: "toolCallUpdated",
          data: { messageId: "m-review", toolCallId: "h1", spec: patchSpec(first, "rejected") },
        },
        {
          kind: "toolCallUpdated",
          data: { messageId: "m-review", toolCallId: "h2", spec: patchSpec(second, "rejected") },
        },
      );

      const committed = workspaceReducer(rejected, {
        kind: "toolCallUpdated",
        data: { messageId: "m-review", toolCallId: "h1", spec: committedPatchSpec(first) },
      });

      expect(patchSummaryReviewOutcome(committed.messages[0])).toBe("abandoned");
    });

    it("接受路径不会把 patchSummary 标记成已放弃", () => {
      const first = reviewSuggestion("h1", "batch-1");
      const second = reviewSuggestion("h2", "batch-2");
      const reviewMessage: ChatMessage = {
        ...baseMessage,
        id: "m-review",
        parts: [{ kind: "patchSummary", data: { count: 2, hunkIds: ["h1", "h2"] } }],
      };
      const accepted = reduce(
        { kind: "chatMessageAdded", data: { message: reviewMessage } },
        {
          kind: "docDiffReady",
          data: { baseVersion: 1, suggestions: [first, second] },
        },
        {
          kind: "toolCallUpdated",
          data: { messageId: "m-review", toolCallId: "h1", spec: patchSpec(first, "accepted") },
        },
        {
          kind: "toolCallUpdated",
          data: { messageId: "m-review", toolCallId: "h2", spec: patchSpec(second, "accepted") },
        },
      );

      const committed = workspaceReducer(accepted, {
        kind: "toolCallUpdated",
        data: { messageId: "m-review", toolCallId: "h1", spec: committedPatchSpec(first) },
      });

      expect(patchSummaryReviewOutcome(committed.messages[0])).toBeNull();
    });

    it("单项 failed 先到后，部分成功 docCommitted 会纠正摘要并保留冲突计数", () => {
      const suggestion = reviewSuggestion("h-partial", "batch-partial");
      const reviewMessage: ChatMessage = {
        ...baseMessage,
        id: "m-partial-count",
        parts: [{ kind: "patchSummary", data: { count: 2, hunkIds: [suggestion.id, "h-applied"] } }],
      };
      const next = reduce(
        { kind: "chatMessageAdded", data: { message: reviewMessage } },
        {
          kind: "toolCallUpdated",
          data: {
            messageId: reviewMessage.id,
            toolCallId: suggestion.id,
            spec: failedPatchSpec(suggestion, "1 处已写入，1 处因文档变化失效。"),
          },
        },
        {
          kind: "docCommitted",
          data: { sessionId: "s-1", version: 2, appliedCount: 1, conflictCount: 1 },
        },
      );

      expect(patchSummaryReviewOutcome(next.messages[0])).toBe("committed");
      expect(patchSummaryAppliedCount(next.messages[0])).toBe(1);
      expect(patchSummaryConflictCount(next.messages[0])).toBe(1);
    });
  });

  describe("docWriteResult", () => {
    it("documentSnapshotWritten 成功终态会清除残留 streamError", () => {
      const failed = workspaceReducer(initialWorkspaceState, {
        kind: "stream",
        data: {
          kind: "draftingFailed",
          data: {
            streamId: "s",
            reason: "模型服务连接失败，请重试。",
            retriable: true,
          },
        },
      });

      const next = workspaceReducer(failed, {
        kind: "documentSnapshotWritten",
        data: {
          doc: legacyWireSnapshot({
            version: 1,
            ts: "2026-05-08T00:00:00Z",
            sections: [{ kind: "p", data: { text: "生成成功正文" } }],
          }),
        },
      });

      expect(next.streamError).toBeNull();
      expect(next.doc?.version).toBe(1);
    });

    // 注:doc 内容同步不再由 docWriteResult 帧承担,而是页面层在 ok 后补发
    // manualDocSaved 本地动作(见 p01 修复)。本用例守的是帧本身仍只动版本号。
    it("updates the baseline version without replacing doc content on ok", () => {
      const seeded = workspaceReducer(initialWorkspaceState, {
        kind: "documentSnapshotWritten",
        data: {
          doc: legacyWireSnapshot({
            version: 1,
            ts: "2026-05-08T00:00:00Z",
            sections: [{ kind: "p", data: { text: "本地正文" } }],
          }),
        },
      });

      const next = workspaceReducer(seeded, {
        kind: "docWriteResult",
        data: { ok: true, clientMutationId: "mutation-1", docVersion: 2 },
      });

      expect(next.version).toBe(2);
      expect(next.doc?.version).toBe(1);
      const para = next.doc?.sections[0];
      expect(para?.kind === "p" && para.spans[0]).toEqual({
        kind: "text",
        text: "本地正文",
      });
    });

    it("surfaces doc write conflicts as reloadable stream errors", () => {
      const next = workspaceReducer(initialWorkspaceState, {
        kind: "docWriteResult",
        data: {
          ok: false,
          clientMutationId: "mutation-1",
          conflict: { expectedDocumentSnapshot: 1, actualDocumentSnapshot: 3 },
        },
      });

      expect(next.streamError).toEqual({
        kind: "docWriteConflict",
        reason: "文档已被更新，请重载后继续编辑。",
        retriable: true,
        actualDocumentSnapshot: 3,
      });
    });

    it("pendingReview 已观测到审阅推进版本时忽略迟到 docWriteConflict,不误弹重载", () => {
      const reviewing = reduce(
        {
          kind: "documentSnapshotWritten",
          data: {
            doc: legacyWireSnapshot({
              version: 3,
              ts: "2026-05-08T00:00:00Z",
              sections: [{ kind: "p", data: { text: "审阅基线" } }],
            }),
          },
        },
        {
          kind: "docStateChanged",
          data: { state: { kind: "pendingReview" }, activeOverlay: null, agentBusy: false },
        },
      );

      const next = workspaceReducer(reviewing, {
        kind: "docWriteResult",
        data: {
          ok: false,
          clientMutationId: "stale-edit-save",
          conflict: { expectedDocumentSnapshot: 2, actualDocumentSnapshot: 3 },
        },
      });

      expect(next.docState.kind).toBe("pendingReview");
      expect(next.version).toBe(3);
      expect(next.streamError).toBeNull();
    });

    it("pendingReview 遇到尚未观测的更高外部版本时仍保留重载提示", () => {
      const reviewing = reduce(
        {
          kind: "documentSnapshotWritten",
          data: {
            doc: legacyWireSnapshot({
              version: 3,
              ts: "2026-05-08T00:00:00Z",
              sections: [{ kind: "p", data: { text: "审阅基线" } }],
            }),
          },
        },
        {
          kind: "docStateChanged",
          data: { state: { kind: "pendingReview" }, activeOverlay: null, agentBusy: false },
        },
      );

      const next = workspaceReducer(reviewing, {
        kind: "docWriteResult",
        data: {
          ok: false,
          clientMutationId: "external-conflict",
          conflict: { expectedDocumentSnapshot: 3, actualDocumentSnapshot: 4 },
        },
      });

      expect(next.streamError).toMatchObject({
        kind: "docWriteConflict",
        actualDocumentSnapshot: 4,
      });
    });
  });

  describe("history snapshot", () => {
    it("keeps snapshot viewing orthogonal to canonical doc", () => {
      const seeded = workspaceReducer(initialWorkspaceState, {
        kind: "documentSnapshotWritten",
        data: {
          doc: legacyWireSnapshot({
            version: 3,
            ts: "2026-05-08T00:00:00Z",
            sections: [{ kind: "p", data: { text: "当前正文" } }],
          }),
        },
      });
      const snapshotDoc = {
        version: 1,
        ts: "2026-05-07T00:00:00Z",
        sections: [{ kind: "p" as const, spans: [{ kind: "text" as const, text: "历史正文" }] }],
      };

      const viewing = workspaceReducer(
        workspaceReducer(seeded, {
          kind: "viewingVersionSet",
          version: 1,
          versionId: "version-1",
        }),
        { kind: "historySnapshotSet", doc: snapshotDoc },
      );

      expect(viewing.doc).toBe(seeded.doc);
      expect(viewing.viewingVersion).toBe(1);
      expect(viewing.viewingVersionId).toBe("version-1");
      expect(viewing.viewingSnapshotDoc).toEqual(snapshotDoc);

      const cleared = workspaceReducer(viewing, { kind: "viewingVersionSet", version: null });
      expect(cleared.doc).toBe(seeded.doc);
      expect(cleared.viewingSnapshotDoc).toBeNull();
    });
  });

  describe("resource sync", () => {
    it("resourceUpserted seeds the registry + tracks ref", () => {
      const next = workspaceReducer(initialWorkspaceState, {
        kind: "resourceUpserted",
        data: {
          resource: {
            resourceRef: { id: "f-1", domain: { kind: "file" } },
            displayName: "doc.pdf",
            summary: "12 pages",
            mime: "application/pdf",
            byteLen: 100,
            createdAt: "2026-05-08T00:00:00Z",
            metadata: null,
          },
        },
      });
      expect(next.resourceRefs).toHaveLength(1);
      expect(resources.summary({ id: "f-1", domain: { kind: "file" } })).toBe(
        "12 pages",
      );
    });

    it("resourceUpdated merges summary into registry", () => {
      const next = reduce(
        {
          kind: "resourceUpserted",
          data: {
            resource: {
              resourceRef: { id: "f-1", domain: { kind: "file" } },
              displayName: "x",
              summary: "old",
              mime: null,
              byteLen: null,
              createdAt: "2026-05-08T00:00:00Z",
              metadata: null,
            },
          },
        },
        {
          kind: "resourceUpdated",
          data: {
            resourceRef: { id: "f-1", domain: { kind: "file" } },
            summary: "new",
            metadata: null,
          },
        },
      );
      expect(resources.summary(next.resourceRefs[0]!)).toBe("new");
    });

    it("resourceUpdated summary null clears the registry summary", () => {
      const next = reduce(
        {
          kind: "resourceUpserted",
          data: {
            resource: {
              resourceRef: { id: "f-1", domain: { kind: "file" } },
              displayName: "x",
              summary: "old",
              mime: null,
              byteLen: null,
              createdAt: "2026-05-08T00:00:00Z",
              metadata: null,
            },
          },
        },
        {
          kind: "resourceUpdated",
          data: {
            resourceRef: { id: "f-1", domain: { kind: "file" } },
            summary: null,
            metadata: null,
          },
        },
      );
      expect(resources.summary(next.resourceRefs[0]!)).toBe("");
    });

    it("resourceRemoved drops the ref + clears registry", () => {
      const ref = { id: "f-1", domain: { kind: "file" } as const };
      const next = reduce(
        {
          kind: "resourceUpserted",
          data: {
            resource: {
              resourceRef: ref,
              displayName: "x",
              summary: "s",
              mime: null,
              byteLen: null,
              createdAt: "2026-05-08T00:00:00Z",
              metadata: null,
            },
          },
        },
        {
          kind: "resourceRemoved",
          data: { resourceRef: ref },
        },
      );
      expect(next.resourceRefs).toHaveLength(0);
      expect(resources.get(ref)).toBeNull();
    });

    it("远端删除会使同素材摘要 mutation 失效，迟到失败不得复活素材", async () => {
      const ref = { id: "race-material", domain: { kind: "file" } as const };
      const original = {
        resourceRef: ref,
        displayName: "race.pdf",
        summary: "旧摘要",
        mime: "application/pdf",
        byteLen: 100,
        createdAt: "2026-05-08T00:00:00Z",
        metadata: null,
      };
      const seeded = workspaceReducer(initialWorkspaceState, {
        kind: "resourceUpserted",
        data: { resource: original },
      });
      let rejectUpdate!: (reason: Error) => void;
      const update = workspaceMutations.tryRun(
        resourceMutationKey(ref.domain.kind, ref.id),
        {
          capture: () => original,
          applyOptimistic: () => resources.applyUpdate(ref, "乐观摘要"),
          commit: () => new Promise<void>((_resolve, reject) => {
            rejectUpdate = reject;
          }),
          rollback: (previous) => {
            if (resources.get(ref)) resources.upsert(previous);
          },
        },
      );
      expect(update).not.toBeNull();
      expect(resources.list({ kind: "file" })).toHaveLength(1);
      await Promise.resolve();

      const removed = workspaceReducer(seeded, {
        kind: "resourceRemoved",
        data: { resourceRef: ref },
      });
      rejectUpdate(new Error("Material not found"));
      await expect(update!.promise).rejects.toThrow("Material not found");

      expect(removed.resourceRefs).toEqual([]);
      expect(resources.list({ kind: "file" })).toEqual([]);
      expect(resources.get(ref)).toBeNull();
      expect(reconcileAssetPreview(toAssetSource(original), resources.list({ kind: "file" })))
        .toBeNull();
    });
  });

  describe("stream lifecycle", () => {
    it("restoreReset clears session-scoped state but keeps current session id", () => {
      const withSession = workspaceReducer(initialWorkspaceState, {
        kind: "sessionMeta",
        data: { sessionId: "s-1", title: "草稿" },
      });
      const withMessage = workspaceReducer(withSession, {
        kind: "chatMessageAdded",
        data: {
          message: {
            id: "m-1",
            role: { kind: "agent" },
            ts: "2026-01-01T00:00:00.000Z",
            parts: [{ kind: "text", data: { body: "旧消息" } }],
            chips: null,
          },
        },
      });
      const started = workspaceReducer(withMessage, {
        kind: "stream",
        data: { kind: "start", data: { streamId: "stream-1" } },
      });

      const reset = workspaceReducer(started, {
        kind: "restoreReset",
        data: { epoch: 2, snapshotSeq: 10 },
      });

      expect(reset.sessionId).toBe("s-1");
      expect(reset.messages).toHaveLength(0);
      expect(reset.agentBusy).toBe(false);
      expect(reset.streamActive).toBe(false);
      expect(reset.activeStreamIds).toEqual([]);
    });

    it("tracks streamActive from start to normal end", () => {
      const started = workspaceReducer(initialWorkspaceState, {
        kind: "stream",
        data: {
          kind: "start",
          data: { streamId: "s" },
        },
      });
      expect(started.streamActive).toBe(true);
      expect(started.agentBusy).toBe(true);

      const ended = workspaceReducer(started, {
        kind: "stream",
        data: {
          kind: "end",
          data: { streamId: "s", reason: { kind: "done" } },
        },
      });
      expect(ended.streamActive).toBe(false);
      expect(ended.agentBusy).toBe(false);
    });

    it("交错流只结束其中一条时保持忙碌，最后一条结束才解锁", () => {
      const started = reduce(
        {
          kind: "stream",
          data: { kind: "start", data: { streamId: "s-1" } },
        },
        {
          kind: "stream",
          data: { kind: "start", data: { streamId: "s-2" } },
        },
      );

      const oneRemaining = workspaceReducer(started, {
        kind: "stream",
        data: {
          kind: "end",
          data: { streamId: "s-1", reason: { kind: "done" } },
        },
      });
      expect(oneRemaining.activeStreamIds).toEqual(["s-2"]);
      expect(oneRemaining.agentBusy).toBe(true);

      const ended = workspaceReducer(oneRemaining, {
        kind: "stream",
        data: {
          kind: "end",
          data: { streamId: "s-2", reason: { kind: "done" } },
        },
      });
      expect(ended.activeStreamIds).toEqual([]);
      expect(ended.agentBusy).toBe(false);
    });

    it.each(["stop", "abort", "error", "completed"] as const)(
      "local %s termination clears stream and agent busy",
      (reason) => {
        const started = reduce(
          {
            kind: "docStateChanged",
            data: {
              state: { kind: "editing" },
              activeOverlay: null,
              agentBusy: true,
            },
          },
          {
            kind: "stream",
            data: {
              kind: "start",
              data: { streamId: "s" },
            },
          },
          {
            kind: "toolCallUpdated",
            data: {
              messageId: "m-agent",
              toolCallId: runningCommandToolCall.id,
              spec: runningCommandToolCall,
            },
          },
        );

        const stopped = workspaceReducer(started, {
          kind: "streamTerminated",
          reason,
        });

        expect(stopped.streamActive).toBe(false);
        expect(stopped.activeStreamIds).toEqual([]);
        expect(stopped.agentBusy).toBe(false);
        expect(stopped.toolCalls.get(runningCommandToolCall.id)?.status.kind).toBe(
          reason === "completed" ? "running" : reason === "error" ? "failed" : "aborted",
        );
      },
    );

    it("wire cancelled end 同时收敛 pending/running 工具缓存与消息帧", () => {
      const running = {
        ...runningCommandToolCall,
        id: "running-on-cancel",
      };
      const pending: ToolCallSpec = {
        id: "pending-on-cancel",
        name: "fetchArticle",
        render: { kind: "chatInline" },
        status: { kind: "pending" },
        body: { kind: "generic", data: { argsJson: "{}" } },
        result: null,
      };
      const started = reduce(
        {
          kind: "chatMessageAdded",
          data: {
            message: {
              ...baseMessage,
              id: "cancel-tools",
              parts: [
                { kind: "toolCall", data: running },
                { kind: "toolCall", data: pending },
              ],
            },
          },
        },
        {
          kind: "toolCallUpdated",
          data: { messageId: "cancel-tools", toolCallId: running.id, spec: running },
        },
        {
          kind: "toolCallUpdated",
          data: { messageId: "cancel-tools", toolCallId: pending.id, spec: pending },
        },
        {
          kind: "stream",
          data: { kind: "start", data: { streamId: "cancel-stream" } },
        },
      );

      const cancelled = workspaceReducer(started, {
        kind: "stream",
        data: {
          kind: "end",
          data: { streamId: "cancel-stream", reason: { kind: "cancelled" } },
        },
      });

      expect([...cancelled.toolCalls.values()].map((spec) => spec.status.kind))
        .toEqual(["aborted", "aborted"]);
      const messageStatuses = cancelled.messages[0]?.parts
        .filter((part) => part.kind === "toolCall")
        .map((part) => part.data.status.kind);
      expect(messageStatuses).toEqual(["aborted", "aborted"]);
    });

    it("R2-22 stop 终止流时立即清除 agentBusy，按钮可恢复为发送", () => {
      const busy = workspaceReducer(initialWorkspaceState, {
        kind: "docStateChanged",
        data: { state: { kind: "editing" }, activeOverlay: null, agentBusy: true },
      });
      const started = workspaceReducer(busy, {
        kind: "stream",
        data: {
          kind: "start",
          data: { streamId: "s" },
        },
      });

      const stopped = workspaceReducer(started, {
        kind: "streamTerminated",
        reason: "stop",
      });

      expect(stopped.streamActive).toBe(false);
      expect(stopped.agentBusy).toBe(false);
    });

    it.each([
      { kind: "done" } as const,
      { kind: "cancelled" } as const,
      { kind: "error", data: "boom" } as const,
    ])("wire stream end $kind clears agent busy", (reason) => {
      const started = reduce(
        {
          kind: "docStateChanged",
          data: {
            state: { kind: "editing" },
            activeOverlay: null,
            agentBusy: true,
          },
        },
        {
          kind: "stream",
          data: { kind: "start", data: { streamId: "s" } },
        },
      );

      const ended = workspaceReducer(started, {
        kind: "stream",
        data: { kind: "end", data: { streamId: "s", reason } },
      });

      expect(ended.streamActive).toBe(false);
      expect(ended.agentBusy).toBe(false);
    });

    it("terminal + canonical 吸收两帧间迟到的 running 卡并最终清除 agentBusy", () => {
      const started = reduce(
        {
          kind: "stream",
          data: { kind: "start", data: { streamId: "terminal-stream" } },
        },
        {
          kind: "toolCallUpdated",
          data: {
            messageId: "m-agent",
            toolCallId: runningCommandToolCall.id,
            spec: runningCommandToolCall,
          },
        },
      );
      const terminalized = workspaceReducer(started, {
        kind: "stream",
        data: {
          kind: "end",
          data: { streamId: "terminal-stream", reason: { kind: "done" } },
        },
      });
      const lateRunning = workspaceReducer(terminalized, {
        kind: "toolCallUpdated",
        data: {
          messageId: "m-agent",
          toolCallId: runningCommandToolCall.id,
          spec: runningCommandToolCall,
        },
      });
      expect(lateRunning.streamActive).toBe(false);
      expect(lateRunning.agentBusy).toBe(true);

      const converged = workspaceReducer(lateRunning, {
        kind: "docGenerationEvent",
        data: {
          kind: "generation_finished",
          data: {
            generationId: "terminal-terminal-stream",
            seq: 1,
            prevSeq: null,
            doc: streamedPmDoc,
            finalVersion: 2,
            contentHash: "pmv1-terminal",
          },
        },
      });

      expect(converged.streamActive).toBe(false);
      expect(converged.activeStreamIds).toEqual([]);
      expect(converged.agentBusy).toBe(false);
      expect(converged.docState).toEqual({ kind: "editing" });
      expect(deriveDocDimensions(converged).editor).toBe("editable");
    });

    it("直接 dispatch 未拆分的 stream end.finalDocument 视为契约违规", () => {
      const started = reduce(
        {
          kind: "docStateChanged",
          data: {
            state: { kind: "drafting" },
            activeOverlay: null,
            agentBusy: true,
          },
        },
        {
          kind: "stream",
          data: { kind: "start", data: { streamId: "receipt-stream" } },
        },
        {
          kind: "toolCallUpdated",
          data: {
            messageId: "m-agent",
            toolCallId: runningCommandToolCall.id,
            spec: runningCommandToolCall,
          },
        },
      );

      expect(() =>
        workspaceReducer(started, {
          kind: "stream",
          data: {
            kind: "end",
            data: {
              streamId: "receipt-stream",
              reason: { kind: "done" },
              finalDocument: {
                version: 9,
                contentHash: "pmv1-receipt",
                doc: streamedPmDoc,
              },
            },
          },
        }),
      ).toThrow(/stream end\.finalDocument 必须先经 splitStreamEndFinalDocument 拆分/);
    });

    it("clears streamActive on stream end error", () => {
      const started = workspaceReducer(initialWorkspaceState, {
        kind: "stream",
        data: {
          kind: "start",
          data: { streamId: "s" },
        },
      });

      const failed = workspaceReducer(started, {
        kind: "stream",
        data: {
          kind: "end",
          data: { streamId: "s", reason: { kind: "error", data: "boom" } },
        },
      });

      expect(failed.streamActive).toBe(false);
      expect(failed.streamError).toEqual({ kind: "failed", reason: "boom" });
    });

    it("clears streamActive on draftingFailed", () => {
      const started = workspaceReducer(initialWorkspaceState, {
        kind: "stream",
        data: {
          kind: "start",
          data: { streamId: "s" },
        },
      });

      const failed = workspaceReducer(started, {
        kind: "stream",
        data: {
          kind: "draftingFailed",
          data: {
            streamId: "s",
            reason: "timeout",
            retriable: true,
          },
        },
      });

      expect(failed.streamActive).toBe(false);
      expect(failed.agentBusy).toBe(false);
    });

    it("draftingFailed sets retriable streamError", () => {
      const next = workspaceReducer(initialWorkspaceState, {
        kind: "stream",
        data: {
          kind: "draftingFailed",
          data: {
            streamId: "s",
            reason: "timeout",
            retriable: true,
          },
        },
      });
      expect(next.streamError).toEqual({
        kind: "draftingFailed",
        reason: "timeout",
        retriable: true,
      });
    });

    it("draftingFailed 保留 402 结构化错误字段并使用 userMessage", () => {
      const next = workspaceReducer(initialWorkspaceState, {
        kind: "stream",
        data: {
          kind: "draftingFailed",
          data: {
            streamId: "s",
            reason: "Payment required",
            retriable: false,
            statusCode: 402,
            category: "quota",
            userMessage: "模型余额或调用额度不足，请检查模型设置或账户余额。",
            action: "check_balance",
          },
        },
      });

      expect(next.streamError).toEqual({
        kind: "draftingFailed",
        reason: "模型余额或调用额度不足，请检查模型设置或账户余额。",
        retriable: false,
        statusCode: 402,
        category: "quota",
        userMessage: "模型余额或调用额度不足，请检查模型设置或账户余额。",
        action: "check_balance",
      });
    });

    it("retryDrafting clears streamError", () => {
      const failed = workspaceReducer(initialWorkspaceState, {
        kind: "stream",
        data: {
          kind: "draftingFailed",
          data: { streamId: "s", reason: "x", retriable: true },
        },
      });
      const retried = workspaceReducer(failed, {
        kind: "retryDrafting",
        streamId: "s",
      });
      expect(retried.streamError).toBeNull();
    });
  });

  describe("docStateChanged", () => {
    it("transitions through states", () => {
      const next = reduce(
        {
          kind: "docStateChanged",
          data: { state: { kind: "drafting" }, activeOverlay: null, agentBusy: true },
        },
        {
          kind: "docStateChanged",
          data: { state: { kind: "draft" }, activeOverlay: null, agentBusy: false },
        },
      );
      expect(next.docState).toEqual({ kind: "editing" });
      expect(next.activeOverlay).toBeNull();
      expect(next.agentBusy).toBe(false);
    });

    it("forceUnlockReview leaves pendingReview when no server patch command can run", () => {
      const pending = reduce(
        {
          kind: "documentSnapshotWritten",
          data: {
            doc: legacyWireSnapshot({
              version: 13,
              ts: "2026-05-08T00:00:00Z",
              sections: [{ kind: "p", data: { text: "Body." } }],
            }),
          },
        },
        {
          kind: "docStateChanged",
          data: { state: { kind: "pendingReview" }, activeOverlay: null, agentBusy: false },
        },
        {
          kind: "docDiffReady",
          data: {
            baseVersion: 13,
            suggestions: [reviewSuggestion("resolved", "resolved-batch", "rejected")],
          },
        },
      );

      const next = workspaceReducer(pending, { kind: "forceUnlockReview" });

      expect(next.docState).toEqual({ kind: "editing" });
      expect(next.docDiff).toBeNull();
      expect(selectPatches(next)).toEqual([]);
      expect(next.activeOverlay).toBeNull();
      expect(next.agentBusy).toBe(false);
    });

    it("离开 pendingReview 时收敛残留 docSuggestion toolCall 并同步 message part", () => {
      const suggestion = reviewSuggestion("h1", "batch-1", "rejected");
      const reviewCall = patchSpec(suggestion, "rejected");
      const reviewMessage: ChatMessage = {
        ...baseMessage,
        id: "m-review",
      };
      const pending = reduce(
        {
          kind: "docStateChanged",
          data: { state: { kind: "pendingReview" }, activeOverlay: null, agentBusy: false },
        },
        { kind: "chatMessageAdded", data: { message: reviewMessage } },
        {
          kind: "chatMessageAppended",
          data: {
            messageId: "m-review",
            seq: 1,
            part: { kind: "toolCall", data: reviewCall },
          },
        },
      );

      expect(selectPatches(pending).map((patch) => patch.id)).toEqual(["h1"]);

      const next = workspaceReducer(pending, {
        kind: "docStateChanged",
        data: { state: { kind: "editing" }, activeOverlay: null, agentBusy: false },
      });
      const part = next.messages[0]?.parts[0];

      expect(next.toolCalls.get("h1")?.status.kind).toBe("committed");
      expect(part?.kind === "toolCall" ? part.data.status.kind : null).toBe("committed");
      expect(selectPatches(next)).toEqual([]);
    });

    it("全拒清理后下一轮 docDiffReady 不串上一轮候选", () => {
      const oldSuggestion = reviewSuggestion("old-hunk", "old-batch", "rejected");
      const newSuggestion = reviewSuggestion("new-hunk", "new-batch");
      const pending = reduce(
        {
          kind: "docStateChanged",
          data: { state: { kind: "pendingReview" }, activeOverlay: null, agentBusy: false },
        },
        {
          kind: "toolCallUpdated",
          data: { messageId: "m-review", toolCallId: "old-hunk", spec: patchSpec(oldSuggestion, "rejected") },
        },
      );
      const cleared = workspaceReducer(pending, { kind: "forceUnlockReview" });
      const nextRound = ([
        {
          kind: "docStateChanged",
          data: { state: { kind: "pendingReview" }, activeOverlay: null, agentBusy: false },
        },
        {
          kind: "docDiffReady",
          data: { baseVersion: 2, suggestions: [newSuggestion] },
        },
      ] satisfies WorkspaceAction[]).reduce(workspaceReducer, cleared);

      expect(cleared.toolCalls.get("old-hunk")?.status.kind).toBe("committed");
      expect(selectPatches(nextRound).map((patch) => patch.id)).toEqual(["new-hunk"]);
    });
  });
});

describe("selectors", () => {
  afterEach(() => resources.reset());

  it("selectOpenAskUser returns the open askUser tool-call", () => {
    const state = reduce(
      {
        kind: "docStateChanged",
        data: { state: { kind: "editing" }, activeOverlay: "askUser", agentBusy: false },
      },
      { kind: "chatMessageAdded", data: { message: baseMessage } },
      {
        kind: "chatMessageAppended",
        data: {
          messageId: "m1",
          seq: 1,
          part: { kind: "toolCall", data: askUserToolCall },
        },
      },
    );
    expect(selectOpenAskUser(state)?.id).toBe("tc-1");
  });

  const emptyAskUser: ToolCallSpec = {
    ...askUserToolCall,
    id: "ask-empty-tc",
    body: {
      kind: "askUser",
      data: {
        id: "ask-1",
        mode: { kind: "overlay" },
        purpose: null,
        source: null,
        rationale: null,
        questions: [],
      },
    },
  };

  it("selectOpenAskUser returns an empty-questions card while overlay is askUser (skeleton loading)", () => {
    // 活跃挂起(后端 activeOverlay==="askUser",仅在 owner.runId 匹配的活跃挂起或 running 时
    // 才置)即使 questions 暂空(刷新恢复中/流式刚起),也要返回卡 → 浮层渲染骨架 loading,
    // 而非凭空消失。旧残留无 owner → 后端 activeOverlay 不会是 askUser,天然被下面那条排除。
    const state = reduce(
      {
        kind: "docStateChanged",
        data: { state: { kind: "editing" }, activeOverlay: "askUser", agentBusy: false },
      },
      { kind: "chatMessageAdded", data: { message: baseMessage } },
      {
        kind: "chatMessageAppended",
        data: {
          messageId: "m1",
          seq: 1,
          part: { kind: "toolCall", data: emptyAskUser },
        },
      },
    );

    expect(selectOpenAskUser(state)?.id).toBe("ask-empty-tc");
  });

  it("selectOpenAskUser ignores an empty askUser card when overlay is NOT askUser (旧残留)", () => {
    // activeOverlay 为 null(无活跃挂起 owner)时,chatHistory 里残留的空 askUser 不得重开浮层。
    const state = reduce(
      {
        kind: "docStateChanged",
        data: { state: { kind: "editing" }, activeOverlay: null, agentBusy: false },
      },
      { kind: "chatMessageAdded", data: { message: baseMessage } },
      {
        kind: "chatMessageAppended",
        data: {
          messageId: "m1",
          seq: 1,
          part: { kind: "toolCall", data: emptyAskUser },
        },
      },
    );

    expect(selectOpenAskUser(state)).toBeNull();
  });

  it("selectPatches filters docSuggestion tool-calls", () => {
    const suggestionCall: ToolCallSpec = {
      id: "tc-p",
      name: "docSuggestion",
      render: { kind: "docInlinePatch" },
      status: { kind: "reviewing" },
      body: {
        kind: "docSuggestion",
        data: {
          kind: "suggestion",
          data: {
            id: "tc-p",
            docId: "doc-1",
            baseVersion: 1,
            baseSchemaVersion: 1,
            status: "reviewing",
            anchor: {
              blockId: "block-1",
              pmFrom: 1,
              pmTo: 4,
              quote: "old",
              textHash: "hash",
            },
            patch: {
              kind: "prosemirror_steps",
              steps: [{ stepType: "replace", from: 1, to: 4, slice: { content: [], openStart: 0, openEnd: 0 } }],
            },
            preview: { deleteText: "old", insertText: "new" },
            summary: "tighten",
          },
        },
      },
      result: null,
    };
    const state = reduce(
      {
        kind: "docStateChanged",
        data: { state: { kind: "pendingReview" }, activeOverlay: null, agentBusy: false },
      },
      { kind: "chatMessageAdded", data: { message: baseMessage } },
      {
        kind: "chatMessageAppended",
        data: {
          messageId: "m1",
          seq: 1,
          part: { kind: "toolCall", data: suggestionCall },
        },
      },
    );
    expect(selectPatches(state)).toHaveLength(1);
  });

  it("selectPatches exposes docDiffReady suggestions as reviewable patch calls", () => {
    const state = reduce(
      {
        kind: "docStateChanged",
        data: { state: { kind: "pendingReview" }, activeOverlay: null, agentBusy: false },
      },
      {
        kind: "docDiffReady",
        data: {
          baseVersion: 1,
          suggestions: [
            {
              id: "diff-hunk-1",
              docId: "doc-1",
              baseVersion: 1,
              baseSchemaVersion: 1,
              status: "reviewing",
              anchor: {
                blockId: "block-1",
                pmFrom: 1,
                pmTo: 2,
                quote: "树",
                textHash: "hash",
              },
              patch: {
                kind: "prosemirror_steps",
                steps: [{ stepType: "addMark", from: 1, to: 2 }],
              },
              preview: { deleteText: "树", insertText: "树" },
              summary: "添加标记 bold",
              diffHunk: {
                hunkId: "diff-hunk-1",
                reviewBatchId: "diff-hunk-1",
                groupMode: "independent",
                op: "markAdd",
                blockPath: [0],
                anchor: {
                  blockId: "block-1",
                  quoteBefore: "树",
                  quoteAfter: "树",
                  pmFrom: 1,
                  pmTo: 2,
                  anchorKind: "range",
                },
                before: null,
                after: null,
                marks: [{ type: "bold" }],
                summary: "添加标记 bold",
                beforeText: "树",
                afterText: "树",
              },
            },
          ],
        },
      },
    );

    const patches = selectPatches(state);
    expect(patches).toHaveLength(1);
    expect(patches[0]).toMatchObject({
      id: "diff-hunk-1",
      name: "docSuggestion",
      status: { kind: "reviewing" },
      body: { kind: "docSuggestion" },
    });
  });

  it("selectSubAgents derives from spawnSubAgent tool-calls", () => {
    const spawn: ToolCallSpec = {
      id: "tc-sa",
      name: "spawnSubAgent",
      render: { kind: "chatInline" },
      status: { kind: "running", data: { progressPct: null, etaSec: null } },
      body: {
        kind: "spawnSubAgent",
        data: {
          subAgentId: "sa-1",
          name: "researcher",
          description: "looking",
          rootTaskId: "t1",
        },
      },
      result: null,
    };
    const state = reduce(
      { kind: "chatMessageAdded", data: { message: baseMessage } },
      {
        kind: "chatMessageAppended",
        data: {
          messageId: "m1",
          seq: 1,
          part: { kind: "toolCall", data: spawn },
        },
      },
    );
    const subs = selectSubAgents(state);
    expect(subs).toHaveLength(1);
    expect(subs[0]?.status).toBe("running");
    expect(subs[0]?.spawnedBy).toBe("tc-sa");
  });

  it("selectSubAgents throws on patch-only status applied to a spawnSubAgent", () => {
    const malformed: ToolCallSpec = {
      id: "tc-sa",
      name: "spawnSubAgent",
      render: { kind: "chatInline" },
      status: { kind: "reviewing" },
      body: {
        kind: "spawnSubAgent",
        data: {
          subAgentId: "sa-1",
          name: "n",
          description: "d",
          rootTaskId: "t",
        },
      },
      result: null,
    };
    const state = reduce(
      { kind: "chatMessageAdded", data: { message: baseMessage } },
      {
        kind: "chatMessageAppended",
        data: {
          messageId: "m1",
          seq: 1,
          part: { kind: "toolCall", data: malformed },
        },
      },
    );
    expect(() => selectSubAgents(state)).toThrow(/patch-only/);
  });
});

  describe("p01 回归:手动编辑的事实来源同步", () => {
    it("manualDocSaved 把已保存 PM 文档同步进 state.doc", () => {
      const pmDoc = {
        type: "doc" as const,
        attrs: { schemaVersion: 1 },
        content: [
          {
            type: "paragraph" as const,
            attrs: { blockId: "blk-manual" },
            content: [{ type: "text" as const, text: "手动补的第三段" }],
          },
        ],
      };
      const next = workspaceReducer(initialWorkspaceState, {
        kind: "manualDocSaved",
        pmDoc: pmDoc as never,
        version: 5,
      });

      expect(next.version).toBe(5);
      expect(next.doc?.pmDoc).toEqual(pmDoc);
      const para = next.doc?.sections[0];
      expect(para?.kind === "p" && para.spans[0]).toEqual({
        kind: "text",
        text: "手动补的第三段",
      });
    });

    it("manualDocSaved 在 empty 首写但 overlay/忙态挂起时,不本地翻转也不清浮层(review #1 状态分叉)", () => {
      const pmDoc = {
        type: "doc" as const,
        attrs: { schemaVersion: 1 },
        content: [
          {
            type: "heading" as const,
            attrs: { blockId: "blk-title", level: 1 },
            content: [{ type: "text" as const, text: "新文档" }],
          },
          {
            type: "paragraph" as const,
            attrs: { blockId: "blk-body" },
            content: [],
          },
        ],
      };
      const next = workspaceReducer(
        {
          ...initialWorkspaceState,
          activeOverlay: "askUser",
          agentBusy: true,
        },
        { kind: "manualDocSaved", pmDoc: pmDoc as never, version: 1 },
      );

      expect(next.version).toBe(1);
      // overlay 挂起中:不本地翻 editing、不清 overlay/忙态(服务端 suspension 仍在,以后端投影为准)
      expect(next.docState).toEqual({ kind: "empty" });
      expect(next.activeOverlay).toBe("askUser");
      expect(next.agentBusy).toBe(true);
      expect(next.doc?.pmDoc).toEqual(pmDoc);
    });

    it("manualDocSaved 在 empty 首写且静默态(无 overlay、不忙)时本地进入 editing", () => {
      const pmDoc = {
        type: "doc" as const,
        attrs: { schemaVersion: 1 },
        content: [
          {
            type: "paragraph" as const,
            attrs: { blockId: "blk-quiet" },
            content: [],
          },
        ],
      };
      const next = workspaceReducer(initialWorkspaceState, {
        kind: "manualDocSaved",
        pmDoc: pmDoc as never,
        version: 0,
      });

      expect(next.docState).toEqual({ kind: "editing" });
      expect(next.activeOverlay).toBeNull();
      expect(next.agentBusy).toBe(false);
    });

    it("manualDocSaved 保存已有 doc 时只同步内容和版本,不改 docState 或忙态", () => {
      const oldPmDoc = {
        type: "doc" as const,
        attrs: { schemaVersion: 1 },
        content: [
          {
            type: "paragraph" as const,
            attrs: { blockId: "blk-old" },
            content: [{ type: "text" as const, text: "旧内容" }],
          },
        ],
      };
      const newPmDoc = {
        type: "doc" as const,
        attrs: { schemaVersion: 1 },
        content: [
          {
            type: "paragraph" as const,
            attrs: { blockId: "blk-new" },
            content: [{ type: "text" as const, text: "新内容" }],
          },
        ],
      };
      const seeded = {
        ...workspaceReducer(initialWorkspaceState, {
          kind: "manualDocSaved",
          pmDoc: oldPmDoc as never,
          version: 4,
        }),
        activeOverlay: "askUser" as const,
        agentBusy: true,
      };
      const next = workspaceReducer(seeded, {
        kind: "manualDocSaved",
        pmDoc: newPmDoc as never,
        version: 5,
      });

      expect(next.version).toBe(5);
      expect(next.doc?.pmDoc).toEqual(newPmDoc);
      expect(next.docState).toEqual({ kind: "editing" });
      expect(next.activeOverlay).toBe("askUser");
      expect(next.agentBusy).toBe(true);
    });

    it("docDiffReady 携带 previewDoc 时用它对齐审阅基线(此前被忽略)", () => {
      const seeded = workspaceReducer(initialWorkspaceState, {
        kind: "documentSnapshotWritten",
        data: {
          doc: legacyWireSnapshot({
            version: 1,
            ts: "2026-05-08T00:00:00Z",
            sections: [{ kind: "p", data: { text: "陈旧基线" } }],
          }),
        },
      });
      const previewDoc = {
        type: "doc" as const,
        attrs: { schemaVersion: 1 },
        content: [
          {
            type: "paragraph" as const,
            attrs: { blockId: "blk-srv" },
            content: [{ type: "text" as const, text: "服务端真实基线(含手动内容)" }],
          },
        ],
      };
      const next = workspaceReducer(seeded, {
        kind: "docDiffReady",
        data: { baseVersion: 3, suggestions: [], previewDoc: previewDoc as never },
      });

      expect(next.doc?.pmDoc).toEqual(previewDoc);
      expect(next.version).toBe(3);
      expect(next.docDiff).not.toBeNull();
    });
  });

  // 回归:提交问卷后,卡片(用 fullpageAsk)已消失但 activeOverlay 仍是 "askUser",
  // 导致输入框一直锁在「请先完成右侧问卷」、视图保持 locked(即便右侧已在生成草稿)。
  describe("toolCallUpdated · askUser 作答乐观清 overlay", () => {
    it("askUser → done 时清掉 askUser overlay(先见 pending 的当前卡被作答)", () => {
      // 真实直播序:卡先以 pending 进 toolCalls(流式产题/挂起),再翻 done(作答)。
      const seeded = reduce(
        {
          kind: "docStateChanged",
          data: { state: { kind: "drafting" }, activeOverlay: "askUser", agentBusy: true },
        },
        {
          kind: "toolCallUpdated",
          data: {
            messageId: "m-1",
            toolCallId: askUserToolCall.id,
            spec: { ...askUserToolCall, status: { kind: "pending" } },
          },
        },
      );
      expect(seeded.activeOverlay).toBe("askUser");
      const next = workspaceReducer(seeded, {
        kind: "toolCallUpdated",
        data: {
          messageId: "m-1",
          toolCallId: askUserToolCall.id,
          spec: { ...askUserToolCall, status: { kind: "done" } },
        },
      });
      expect(next.activeOverlay).toBeNull();
    });

    it("askUser 仍 pending 时不动 overlay", () => {
      const seeded = reduce({
        kind: "docStateChanged",
        data: { state: { kind: "drafting" }, activeOverlay: "askUser", agentBusy: true },
      });
      const next = workspaceReducer(seeded, {
        kind: "toolCallUpdated",
        data: {
          messageId: "m-1",
          toolCallId: askUserToolCall.id,
          spec: { ...askUserToolCall, status: { kind: "pending" } },
        },
      });
      expect(next.activeOverlay).toBe("askUser");
    });

    it("提交失败后 restoreAskUser 恢复原问卷和 askUser overlay", () => {
      const message: ChatMessage = {
        ...baseMessage,
        id: "m-ask",
        parts: [{ kind: "toolCall", data: askUserToolCall }],
      };
      const seeded = reduce(
        {
          kind: "docStateChanged",
          data: { state: { kind: "drafting" }, activeOverlay: "askUser", agentBusy: true },
        },
        { kind: "chatMessageAdded", data: { message } },
      );
      const answers = {
        "q-1": { chosen: ["a"], freeText: null },
      };
      const optimistic = workspaceReducer(seeded, {
        kind: "toolCallUpdated",
        data: {
          messageId: "m-ask",
          toolCallId: askUserToolCall.id,
          spec: {
            ...askUserToolCall,
            status: { kind: "done" },
            result: { kind: "askUserAnswers", data: answers },
          },
        },
      });
      expect(optimistic.activeOverlay).toBeNull();

      const restored = workspaceReducer(optimistic, {
        kind: "restoreAskUser",
        messageId: "m-ask",
        toolCall: askUserToolCall,
        overlay: "askUser",
        docState: { kind: "editing" },
        agentBusy: false,
      });

      expect(restored.toolCalls.get(askUserToolCall.id)).toEqual(askUserToolCall);
      expect(restored.messages[0]?.parts[0]).toEqual({
        kind: "toolCall",
        data: askUserToolCall,
      });
      expect(restored.activeOverlay).toBe("askUser");
      expect(restored.docState).toEqual({ kind: "editing" });
      expect(restored.agentBusy).toBe(false);
      expect(selectOpenAskUser(restored)?.id).toBe(askUserToolCall.id);
    });
  });
