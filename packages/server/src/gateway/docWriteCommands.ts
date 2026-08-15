import type {
  BridgeFrame,
  ChatMessage,
  Command,
  ExternalProposeOp,
  WriteDraftFailureDiagnostic,
} from "@qingagent/contract-ts";
import {
  compileAiDocumentToPm,
  assertUniquePmBlockIds,
  markdownToPm,
  normalizePmDoc,
  pmToMarkdown,
  qingmlTagSkeleton,
  type PmDoc,
} from "@qingagent/pm-schema";
import crypto from "node:crypto";
import {
  AiDocumentParseError,
  advanceLastContentEditedAt,
  buildAnnotationMappingSteps,
  clonePmDoc,
  collectTopLevelTextBlocks,
  commitDocumentOp,
  currentPmDoc,
  deriveActiveOverlay,
  deriveAgentBusy,
  deriveContentState,
  deriveEditorState,
  deriveTitleFromDoc,
  emitProjectedDocState,
  ensureDraftCandidateDoc,
  findLiteralMatches,
  hasCanonicalDoc,
  invalidateDraftStateAfterCanonicalWrite,
  mapAnnotationGroupsThroughSteps,
  persistSessionMetadata,
  parseAiDocumentFromQingml,
  replaceDraftCandidateDoc,
  replaceTextRuns,
  settleDraftCandidate,
  transitionDocState,
} from "./bridgeCore";
import { persistMappedAnnotationGroups } from "@qingagent/db";
import { bindClientTraceId } from "./commandTracing";
import type { CommandExecutionContext } from "./commandTypes";
import { USER_VERSION_WINDOW_MS } from "./docWriteConfig";
import { getOrRestoreSession } from "./sessionLifecycle";

function docWriteReason(
  clientMutationId: string,
  reason: "agent_busy" | "not_editable" | "not_found" | "validation_error",
  diagnostic?: WriteDraftFailureDiagnostic,
): BridgeFrame {
  return {
    kind: "docWriteResult",
    data: {
      ok: false,
      clientMutationId,
      reason,
      ...(diagnostic ? { diagnostic } : {}),
    },
  };
}

type ExternalQingmlDraftResult =
  | { ok: true; doc: PmDoc; title: string | null }
  | { ok: false; diagnostic: WriteDraftFailureDiagnostic };

export function compileExternalQingmlDraft(
  qingml: string,
  compile: typeof compileAiDocumentToPm = compileAiDocumentToPm,
): ExternalQingmlDraftResult {
  try {
    const parsed = parseAiDocumentFromQingml(qingml);
    const compiled = compile(parsed.document);
    if (!compiled.ok || !compiled.doc) {
      return {
        ok: false,
        diagnostic: {
          failureKind: "compile_failed",
          warningKinds: [],
          tagSkeleton: qingmlTagSkeleton(qingml),
          errorLocations: [],
        },
      };
    }
    return {
      ok: true,
      doc: compiled.doc,
      title: typeof parsed.document.title === "string" && parsed.document.title.trim()
        ? parsed.document.title.trim()
        : null,
    };
  } catch (error) {
    if (error instanceof AiDocumentParseError) {
      return {
        ok: false,
        diagnostic: error.diagnostics.failureDiagnostic ?? {
          failureKind: error.diagnostics.failureKind ?? "qingml_bad_block",
          warningKinds: [],
          tagSkeleton: qingmlTagSkeleton(qingml),
          errorLocations: [],
        },
      };
    }
    return {
      ok: false,
      diagnostic: {
        failureKind: "compile_failed",
        warningKinds: [],
        tagSkeleton: qingmlTagSkeleton(qingml),
        errorLocations: [],
      },
    };
  }
}

/**
 * 对已由 ensureDraftCandidateDoc 隔离出的候选文档应用外部局部操作。
 *
 * 本函数刻意不 clone 入参，并复用未触碰节点引用；禁止传入 session.doc、
 * docDraftBaseDoc 或其它 canonical/base 文档。调用方必须先建立候选副本。
 */
export function applyExternalProposalOps(
  candidateDoc: PmDoc,
  ops: ExternalProposeOp[],
): { ok: true; doc: PmDoc } | { ok: false; error: string } {
  let workingDoc = candidateDoc;
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
      workingDoc = {
        ...workingDoc,
        content: [...workingDoc.content, ...insertDoc.content],
      };
      continue;
    }
    if (op.kind === "insertAfterLine") {
      const insertDoc = normalizePmDoc(markdownToPm(op.markdown));
      const index = blockIndexForMarkdownLine(workingDoc, op.line);
      if (index < 0) return { ok: false, error: "行号超出范围" };
      workingDoc = {
        ...workingDoc,
        content: [
          ...workingDoc.content.slice(0, index + 1),
          ...insertDoc.content,
          ...workingDoc.content.slice(index + 1),
        ],
      };
      continue;
    }
    if (op.kind === "setTitle") continue;
    return { ok: false, error: "已有文档不允许 fullDraft" };
  }
  try {
    assertUniquePmBlockIds(workingDoc);
  } catch {
    return { ok: false, error: "追加内容与已有文档产生重复块身份" };
  }
  return { ok: true, doc: workingDoc };
}

function blockIndexForMarkdownLine(doc: PmDoc, line: number): number {
  if (!hasCanonicalDoc({ doc })) return -1;
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
      const previousDoc = currentPmDoc(session);
      type PendingAnnotationMapping = {
        mapped: ReturnType<typeof mapAnnotationGroupsThroughSteps>;
        replacedOrigins: string[];
      };
      const transactionAnnotationMapping = { current: null as PendingAnnotationMapping | null };
      const commitInput = {
        docId: session.docId ?? session.sessionId,
        threadId: session.threadId ?? session.sessionId,
        resourceId: session.resourceId,
        expectedDocumentSnapshot: command.data.expectedDocumentSnapshot,
        baseContentHash: command.data.baseContentHash,
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
      } as const;
      const commitOptions: Parameters<typeof commitDocumentOp>[1] =
        session.annotationGroups.length > 0
          ? {
              transactionalEffect: async ({ client: transactionClient, result: committed }) => {
                // 幂等回放若落后于当前内存版本，不得用旧文档反向映射当前锚点。
                if (committed.docVersion < previousDocVersion) return;
                const replacedOrigins = [
                  ...new Set(session.annotationGroups.map((group) => group.origin)),
                ];
                const mapped = mapAnnotationGroupsThroughSteps(
                  session.annotationGroups,
                  buildAnnotationMappingSteps(previousDoc, committed.doc),
                  committed.doc,
                );
                await persistMappedAnnotationGroups(
                  session.docId,
                  mapped.groups,
                  mapped.survivingAnchorIndexes,
                  transactionClient,
                );
                transactionAnnotationMapping.current = { mapped, replacedOrigins };
              },
            }
          : undefined;
      const result = await commitDocumentOp(
        commitInput,
        ...(commitOptions ? [commitOptions] as const : []),
      );

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
      // 单调防回退:并发/乱序写入下不让 session.docVersion 退到更低版本——否则重连会重放陈旧版本、
      // 客户端发过期 expectedDocumentSnapshot 触发必现文档冲突(配合重连时的 DB reconcile 兜底)。
      if (result.docVersion >= session.docVersion) {
        session.doc = result.doc;
        session.docVersion = result.docVersion;
        if (transactionAnnotationMapping.current) {
          session.annotationGroups = transactionAnnotationMapping.current.mapped.groups;
        }
        await invalidateDraftStateAfterCanonicalWrite(session);
        session._directionChangeAskedSinceLastWrite = false;
        transitionDocState(session, deriveContentState(session), "user_doc_write", {
          mode: "normalize",
        });
        const nextTitle = session.titlePinned
          ? null
          : deriveTitleFromDoc(session.doc);
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

      if (transactionAnnotationMapping.current) {
        yield {
          kind: "annotationGroupsReady",
          data: {
            groups: transactionAnnotationMapping.current.mapped.groups,
            replacedOrigins: transactionAnnotationMapping.current.replacedOrigins,
            ...(transactionAnnotationMapping.current.mapped.invalidatedAnchorCount > 0
              ? {
                  invalidatedAnchorCount:
                    transactionAnnotationMapping.current.mapped.invalidatedAnchorCount,
                }
              : {}),
          },
        };
      }

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

      const firstOp = command.data.ops[0];
      const fullDraftOp = firstOp?.kind === "fullDraft" ? firstOp : null;
      const qingmlDraftOp = firstOp?.kind === "qingmlDraft" ? firstOp : null;
      const titleOp = command.data.ops.find((op) => op.kind === "setTitle");
      const qingmlDraft = qingmlDraftOp
        ? compileExternalQingmlDraft(qingmlDraftOp.qingml)
        : null;
      if (qingmlDraft && !qingmlDraft.ok) {
        yield docWriteReason(clientMutationId, "validation_error", qingmlDraft.diagnostic);
        return;
      }
      const contentOps = command.data.ops.filter((op) => op.kind !== "setTitle");
      if (contentOps.length === 0) {
        if (!titleOp) {
          yield docWriteReason(clientMutationId, "validation_error");
          return;
        }
        const titleChanged = titleOp.title !== session.title;
        const pinChanged = !session.titlePinned;
        if (titleChanged) {
          session.title = titleOp.title;
          yield { kind: "sessionMeta", data: { sessionId: session.sessionId, title: session.title } };
        }
        session.titlePinned = true;
        if (titleChanged || pinChanged) {
          await persistSessionMetadata(session);
        }
        // 同标题重放也按幂等成功返回；标题不进入正文审阅，也不推进 docVersion。
        yield {
          kind: "docWriteResult",
          data: { ok: true, clientMutationId, docVersion: session.docVersion },
        };
        return;
      }
      if (contentState.kind === "empty") {
        if ((!fullDraftOp && !qingmlDraft) || command.data.ops.length !== 1) {
          yield docWriteReason(clientMutationId, "validation_error");
          return;
        }
        const submittedDoc = qingmlDraft
          ? qingmlDraft.doc
          : normalizePmDoc(markdownToPm(fullDraftOp!.markdown));
        const submittedTitle = qingmlDraft?.title ?? null;
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
            title: submittedTitle ?? session.title,
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
        session.docVersion = result.docVersion;
        session._directionChangeAskedSinceLastWrite = false;
        transitionDocState(session, deriveContentState(session), "user_doc_write", { mode: "normalize" });
        const nextTitle = session.titlePinned
          ? null
          : submittedTitle ?? deriveTitleFromDoc(session.doc);
        if (nextTitle && nextTitle !== session.title) {
          session.title = nextTitle;
          yield { kind: "sessionMeta", data: { sessionId: session.sessionId, title: session.title } };
        }
        await persistSessionMetadata(session);
        yield* emitProjectedDocState(session, qingmlDraft ? "external_qingml_draft" : "external_full_draft");
        yield { kind: "docWriteResult", data: { ok: true, clientMutationId, docVersion: session.docVersion } };
        return;
      }

      if (fullDraftOp) {
        yield docWriteReason(clientMutationId, "validation_error");
        return;
      }

      const baseCandidate = ensureDraftCandidateDoc(session);
      let workingDoc: PmDoc;
      if (qingmlDraft) {
        workingDoc = clonePmDoc(qingmlDraft.doc);
      } else {
        workingDoc = baseCandidate;
        const applied = applyExternalProposalOps(workingDoc, contentOps);
        if (!applied.ok) {
          yield docWriteReason(clientMutationId, "validation_error");
          return;
        }
        workingDoc = applied.doc;
      }
      replaceDraftCandidateDoc(
        session,
        workingDoc,
        undefined,
        undefined,
        { preserveExistingNodes: qingmlDraft === null },
      );

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

      if (titleOp) {
        const titleChanged = titleOp.title !== session.title;
        const pinChanged = !session.titlePinned;
        if (titleChanged) {
          session.title = titleOp.title;
          yield { kind: "sessionMeta", data: { sessionId: session.sessionId, title: session.title } };
        }
        session.titlePinned = true;
        if (titleChanged || pinChanged) await persistSessionMetadata(session);
      }
      const settled = yield* settleDraftCandidate({
        state: session,
        agentMessageId,
        streamId,
        runId,
        wholeDocument: qingmlDraft !== null,
        ignoreBlockIdentityOnlyReplacements: true,
      });
      if (settled.hunkCount <= 0) {
        yield docWriteReason(clientMutationId, "validation_error");
        return;
      }
      if (qingmlDraft && !session.titlePinned) {
        const nextTitle = qingmlDraft.title ?? deriveTitleFromDoc(qingmlDraft.doc);
        if (nextTitle && nextTitle !== session.title) {
          session.title = nextTitle;
          yield { kind: "sessionMeta", data: { sessionId: session.sessionId, title: session.title } };
          await persistSessionMetadata(session);
        }
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
