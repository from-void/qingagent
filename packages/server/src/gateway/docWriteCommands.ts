import type {
  BridgeFrame,
  ChatMessage,
  Command,
  ExternalProposeOp,
  LegacySection,
} from "@qingagent/contract-ts";
import { markdownToPm, normalizePmDoc, pmToLegacySections, pmToMarkdown, type PmDoc } from "@qingagent/pm-schema";
import crypto from "node:crypto";
import {
  advanceLastContentEditedAt,
  clonePmDoc,
  collectTopLevelTextBlocks,
  commitDocumentOp,
  deriveActiveOverlay,
  deriveAgentBusy,
  deriveContentState,
  deriveEditorState,
  deriveTitleFromSections,
  emitProjectedDocState,
  ensureDraftCandidateDoc,
  findLiteralMatches,
  invalidateDraftStateAfterCanonicalWrite,
  persistSessionMetadata,
  replaceDraftCandidateDoc,
  replaceTextRuns,
  settleDraftCandidate,
  transitionDocState,
} from "./bridgeCore";
import { bindClientTraceId } from "./commandTracing";
import type { CommandExecutionContext } from "./commandTypes";
import { USER_VERSION_WINDOW_MS } from "./docWriteConfig";
import { getOrRestoreSession } from "./sessionLifecycle";

function docWriteReason(
  clientMutationId: string,
  reason: "agent_busy" | "not_editable" | "not_found" | "validation_error",
): BridgeFrame {
  return {
    kind: "docWriteResult",
    data: {
      ok: false,
      clientMutationId,
      reason,
    },
  };
}

function applyExternalProposalOps(
  doc: PmDoc,
  ops: ExternalProposeOp[],
): { ok: true; doc: PmDoc } | { ok: false; error: string } {
  let workingDoc = clonePmDoc(doc);
  for (const op of ops) {
    if (op.kind === "strReplace") {
      const blocks = collectTopLevelTextBlocks(workingDoc);
      const matches = op.nth
        ? findLiteralMatches(blocks, op.old, true).slice(op.nth - 1, op.nth)
        : findLiteralMatches(blocks, op.old, false);
      if (matches.length === 0) return { ok: false, error: "文本未命中或未唯一命中" };
      workingDoc = replaceTextRuns(workingDoc, matches, op.new);
      continue;
    }
    if (op.kind === "appendSection") {
      const insertDoc = normalizePmDoc(markdownToPm(op.markdown));
      workingDoc = normalizePmDoc({
        ...workingDoc,
        content: [...workingDoc.content, ...insertDoc.content],
      });
      continue;
    }
    if (op.kind === "insertAfterLine") {
      const insertDoc = normalizePmDoc(markdownToPm(op.markdown));
      const index = blockIndexForMarkdownLine(workingDoc, op.line);
      if (index < 0) return { ok: false, error: "行号超出范围" };
      workingDoc = normalizePmDoc({
        ...workingDoc,
        content: [
          ...workingDoc.content.slice(0, index + 1),
          ...insertDoc.content,
          ...workingDoc.content.slice(index + 1),
        ],
      });
      continue;
    }
    return { ok: false, error: "已有文档不允许 fullDraft" };
  }
  return { ok: true, doc: workingDoc };
}

function blockIndexForMarkdownLine(doc: PmDoc, line: number): number {
  if (doc.content.length === 0) return -1;
  let consumedLines = 0;
  for (let index = 0; index < doc.content.length; index += 1) {
    const blockDoc = normalizePmDoc({ ...doc, content: [doc.content[index]!] });
    const blockLineCount = countMarkdownLines(pmToMarkdown(blockDoc));
    const trailingBlankLineCount = index < doc.content.length - 1 ? 1 : 0;
    const blockEndLine = consumedLines + blockLineCount + trailingBlankLineCount;
    if (line <= blockEndLine) return index;
    consumedLines = blockEndLine;
  }
  return line <= consumedLines + 1 ? doc.content.length - 1 : -1;
}

function countMarkdownLines(markdown: string): number {
  if (markdown.length === 0) return 1;
  return markdown.split(/\r?\n/).length;
}

type DocWriteCommand = Extract<Command, { kind: "updateDoc" | "externalPropose" }>;

export async function* handleDocWriteCommand(
  command: DocWriteCommand,
  context: CommandExecutionContext,
): AsyncGenerator<BridgeFrame> {
  const { resolvedClientTraceId, origin, modelOverrides, client } = context;
  switch (command.kind) {
    case "updateDoc": {
      const session = await getOrRestoreSession(command.data.sessionId);
      if (!session) {
        throw new Error(`Session not found: ${command.data.sessionId}`);
      }
      bindClientTraceId(session, resolvedClientTraceId, origin, modelOverrides);

      if (session.runId) {
        yield docWriteReason(command.data.clientMutationId, "agent_busy");
        return;
      }

      const editorState = deriveEditorState(
        deriveContentState(session),
        deriveAgentBusy(session),
        deriveActiveOverlay(session),
      );
      // "先写后聊/模板填充":空文档(empty,非 agent 占用/overlay 锁定)允许首次写入,从空白起稿落库;
      // 仍拒 locked(agent 在跑/overlay)与 pendingReview(审核态)。
      if (editorState !== "editable" && editorState !== "empty") {
        yield docWriteReason(command.data.clientMutationId, "not_editable");
        return;
      }

      const submittedDoc = command.data.doc
        ? normalizePmDoc(command.data.doc)
        : null;

      if (!submittedDoc) {
        yield docWriteReason(command.data.clientMutationId, "validation_error");
        return;
      }

      const previousDocVersion = session.docVersion;
      const result = await commitDocumentOp({
        docId: session.docId ?? session.sessionId,
        threadId: session.threadId ?? session.sessionId,
        resourceId: session.resourceId,
        expectedDocumentSnapshot: command.data.expectedDocumentSnapshot,
        clientMutationId: command.data.clientMutationId,
        opKind: "replace_doc",
        actorType: "user",
        // 空文档首写(先写后聊/模板填充):此前无 canonical doc,需 createIfMissing 创建首版(要求 expectedDocumentSnapshot===0)。
        // 首写不进合并窗口(无前序 op 可合并);已有 doc 的常规编辑才走 coalesce。
        ...(editorState === "empty"
          ? {
              createIfMissing: {
                title: session.title,
                docState: "editing",
                lastSyncedVersion: 0,
              },
            }
          : { coalesce: { windowMs: USER_VERSION_WINDOW_MS } }),
        summary: "用户编辑保存",
        apply: () => ({ nextDoc: submittedDoc }),
      });

      if (result.status === "not_found") {
        yield docWriteReason(command.data.clientMutationId, "not_found");
        return;
      }
      if (result.status === "validation_error") {
        yield docWriteReason(command.data.clientMutationId, "validation_error");
        return;
      }
      if (result.status === "patch_conflict") {
        yield docWriteReason(command.data.clientMutationId, "validation_error");
        return;
      }
      if (result.status === "conflict") {
        yield {
          kind: "docWriteResult",
          data: {
            ok: false,
            clientMutationId: command.data.clientMutationId,
            conflict: {
              expectedDocumentSnapshot: command.data.expectedDocumentSnapshot,
              actualDocumentSnapshot: result.currentVersion,
            },
          },
        };
        return;
      }

      advanceLastContentEditedAt(session, result, previousDocVersion);
      const legacySections = pmToLegacySections(result.doc) as unknown as LegacySection[];
      // 单调防回退:并发/乱序写入下不让 session.docVersion 退到更低版本——否则重连会重放陈旧版本、
      // 客户端发过期 expectedDocumentSnapshot 触发必现文档冲突(配合重连时的 DB reconcile 兜底)。
      if (result.docVersion >= session.docVersion) {
        session.doc = result.doc;
        session.legacySections = legacySections;
        session.docVersion = result.docVersion;
        await invalidateDraftStateAfterCanonicalWrite(session);
        session._directionChangeAskedSinceLastWrite = false;
        transitionDocState(session, deriveContentState(session), "user_doc_write", {
          mode: "normalize",
        });
        const nextTitle = session.titlePinned
          ? null
          : deriveTitleFromSections(session.legacySections);
        if (nextTitle && nextTitle !== session.title) {
          session.title = nextTitle;
          yield {
            kind: "sessionMeta",
            data: { sessionId: session.sessionId, title: session.title },
          };
        }
      }
      await persistSessionMetadata(session);

      // 空文档首写(先写后聊/模板填充):此前 docState=empty,doc 落库后必须广播 editing,
      // 否则前端停在 empty 态、把新文档渲染成只读静态视图无法编辑。emitProjectedDocState 从
      // doc 派生并幂等去重,常规编辑(已 editing)重复调用会被去重、无副作用。
      yield* emitProjectedDocState(session, "user_doc_write");

      yield {
        kind: "docWriteResult",
        data: {
          ok: true,
          clientMutationId: command.data.clientMutationId,
          // 单调:stale 幂等回放(result.docVersion < 内存版本)时不向客户端确认低版本,
          // 否则客户端会把本地 snapshot 退回、下一次编辑继续冲突。
          docVersion: Math.max(result.docVersion, session.docVersion),
        },
      };
      return;
    }

    case "externalPropose": {
      const session = await getOrRestoreSession(command.data.sessionId);
      const clientMutationId = command.data.clientMutationId ?? crypto.randomUUID();
      if (!session) {
        yield docWriteReason(clientMutationId, "not_found");
        return;
      }
      bindClientTraceId(session, resolvedClientTraceId, origin, modelOverrides);

      if (deriveAgentBusy(session) || deriveActiveOverlay(session) !== null) {
        yield docWriteReason(clientMutationId, "agent_busy");
        return;
      }
      const contentState = deriveContentState(session);
      if (contentState.kind === "pendingReview") {
        yield docWriteReason(clientMutationId, "not_editable");
        return;
      }
      if (session.docVersion !== command.data.expectedDocVersion) {
        yield {
          kind: "docWriteResult",
          data: {
            ok: false,
            clientMutationId,
            conflict: {
              expectedDocumentSnapshot: command.data.expectedDocVersion,
              actualDocumentSnapshot: session.docVersion,
            },
          },
        };
        return;
      }

      const fullDraftOp = command.data.ops[0]?.kind === "fullDraft" ? command.data.ops[0] : null;
      if (contentState.kind === "empty") {
        if (!fullDraftOp || command.data.ops.length !== 1) {
          yield docWriteReason(clientMutationId, "validation_error");
          return;
        }
        const submittedDoc = normalizePmDoc(markdownToPm(fullDraftOp.markdown));
        const previousDocVersion = session.docVersion;
        const result = await commitDocumentOp({
          docId: session.docId ?? session.sessionId,
          threadId: session.threadId ?? session.sessionId,
          resourceId: session.resourceId,
          expectedDocumentSnapshot: command.data.expectedDocVersion,
          clientMutationId,
          opKind: "replace_doc",
          actorType: "agent",
          createIfMissing: {
            title: session.title,
            docState: "editing",
            lastSyncedVersion: 0,
          },
          summary: "外部工具首写文档",
          apply: () => ({ nextDoc: submittedDoc }),
        });
        if (result.status === "conflict") {
          yield {
            kind: "docWriteResult",
            data: {
              ok: false,
              clientMutationId,
              conflict: {
                expectedDocumentSnapshot: command.data.expectedDocVersion,
                actualDocumentSnapshot: result.currentVersion,
              },
            },
          };
          return;
        }
        if (result.status !== "committed") {
          yield docWriteReason(clientMutationId, result.status === "not_found" ? "not_found" : "validation_error");
          return;
        }
        advanceLastContentEditedAt(session, result, previousDocVersion);
        session.doc = result.doc;
        session.legacySections = pmToLegacySections(result.doc) as unknown as LegacySection[];
        session.docVersion = result.docVersion;
        session._directionChangeAskedSinceLastWrite = false;
        transitionDocState(session, deriveContentState(session), "user_doc_write", { mode: "normalize" });
        const nextTitle = session.titlePinned
          ? null
          : deriveTitleFromSections(session.legacySections);
        if (nextTitle && nextTitle !== session.title) {
          session.title = nextTitle;
          yield { kind: "sessionMeta", data: { sessionId: session.sessionId, title: session.title } };
        }
        await persistSessionMetadata(session);
        yield* emitProjectedDocState(session, "external_full_draft");
        yield { kind: "docWriteResult", data: { ok: true, clientMutationId, docVersion: session.docVersion } };
        return;
      }

      if (fullDraftOp) {
        yield docWriteReason(clientMutationId, "validation_error");
        return;
      }

      const baseCandidate = ensureDraftCandidateDoc(session);
      let workingDoc = clonePmDoc(baseCandidate);
      const applied = applyExternalProposalOps(workingDoc, command.data.ops);
      if (!applied.ok) {
        yield docWriteReason(clientMutationId, "validation_error");
        return;
      }
      workingDoc = applied.doc;
      replaceDraftCandidateDoc(session, workingDoc);

      const externalId = `external-${client ?? "agent"}-${crypto.randomUUID()}`;
      const agentMessageId = externalId;
      const streamId = externalId;
      const runId = externalId;
      const agentMessage: ChatMessage = {
        id: agentMessageId,
        role: { kind: "agent" },
        ts: new Date().toISOString(),
        parts: [],
        chips: null,
      };

      const settled = yield* settleDraftCandidate({
        state: session,
        agentMessageId,
        streamId,
        runId,
        wholeDocument: false,
      });
      if (settled.hunkCount <= 0) {
        yield docWriteReason(clientMutationId, "validation_error");
        return;
      }
      agentMessage.parts.push({
        kind: "patchSummary",
        data: { count: settled.hunkCount, hunkIds: Array.from(session.suggestions.keys()) },
      });
      session.chatHistory.push(agentMessage);
      yield { kind: "chatMessageAdded", data: { message: agentMessage } };
      return;
    }
  }
}
