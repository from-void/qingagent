import type {
  BridgeFrame,
  ChatMessage,
  Command,
  ExternalProposeOp,
  WriteDraftFailureDiagnostic,
} from "@qingagent/contract-ts";
import { EXTERNAL_STRUCTURAL_OP_KINDS } from "@qingagent/contract-ts";
import { findSafeRegexMatches, markTextRuns } from "@qingagent/core/doc-engine";
import {
  compileAiDocumentToPm,
  applyBlockEdits,
  aiRunMarkToPmMark,
  assertUniquePmBlockIds,
  blockToAi,
  getPmContentHash,
  markdownToPm,
  normalizePmDoc,
  pmToPlainText,
  pmToMarkdownWithLineMap,
  qingmlTagSkeleton,
  type PmBlockNode,
  type PmDoc,
  type PmNode,
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
  mastra,
  persistSessionMetadata,
  parseAiDocumentFromQingml,
  replaceDraftCandidateDoc,
  replaceTextRuns,
  settleDraftCandidate,
  transitionDocState,
  MAX_TITLE_CHARS,
  truncateTitleWithNotice,
  type SessionState,
} from "./bridgeCore";
import { documentDraftRepo, persistMappedAnnotationGroups } from "@qingagent/db";
import { bindClientTraceId } from "./commandTracing";
import type { CommandExecutionContext } from "./commandTypes";
import { USER_VERSION_WINDOW_MS } from "./docWriteConfig";
import { getOrRestoreSession } from "./sessionLifecycle";

function docWriteReason(
  clientMutationId: string,
  reason: "agent_busy" | "not_editable" | "not_found" | "validation_error",
  diagnostic?: WriteDraftFailureDiagnostic,
  validationMessage?: string,
): BridgeFrame {
  return {
    kind: "docWriteResult",
    data: {
      ok: false,
      clientMutationId,
      reason,
      ...(diagnostic ? { diagnostic } : {}),
      ...(validationMessage ? { validationMessage } : {}),
    },
  };
}

type ExternalQingmlDraftResult =
  | { ok: true; doc: PmDoc; title: string | null; titleTruncated: boolean }
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
    const titleResult = truncateTitleWithNotice(
      typeof parsed.document.title === "string" && parsed.document.title.trim()
        ? parsed.document.title
        : null,
    );
    return {
      ok: true,
      doc: compiled.doc,
      title: titleResult.title,
      titleTruncated: titleResult.truncated,
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
export async function applyExternalProposalOps(
  candidateDoc: PmDoc,
  ops: ExternalProposeOp[],
): Promise<{ ok: true; doc: PmDoc } | { ok: false; error: string }> {
  let workingDoc = candidateDoc;
  const insertCursorByAnchor = new Map<string, string>();
  for (const op of ops) {
    if (op.kind === "markText") {
      try {
        const allBlocks = collectTopLevelTextBlocks(workingDoc, op.withinRef);
        const hasCodeBlock = allBlocks.some((block) => block.node.type === "codeBlock");
        const blocks = allBlocks.filter((block) => block.node.type !== "codeBlock");
        const regexResult = op.isRegex
          ? await findSafeRegexMatches(blocks, op.find, op.all === true)
          : null;
        if (regexResult && !regexResult.ok) {
          return { ok: false, error: regexResult.error };
        }
        const matches = regexResult
          ? regexResult.matches
          : findLiteralMatches(blocks, op.find, op.all === true);
        if (matches.length === 0) {
          return {
            ok: false,
            error: `文本未命中或未唯一命中,请缩小 withinRef 或设 all:true${
              hasCodeBlock ? "；注:代码块内文本不参与行内标记" : ""
            }`,
          };
        }
        const markedDoc = markTextRuns(
          workingDoc,
          matches,
          aiRunMarkToPmMark(op.mark),
          op.op,
        );
        if (markedDoc === workingDoc) {
          return {
            ok: false,
            error: op.op === "add"
              ? "标记已存在，无需重复添加；同类型不同属性可直接 add 替换"
              : "标记不存在，无需重复移除；请检查 mark 后重试",
          };
        }
        workingDoc = markedDoc;
      } catch (error) {
        mastra.getLogger().warn("[external-proposal] markText failed", {
          markType: op.mark.type,
          operation: op.op,
          error: error instanceof Error ? error.message : String(error),
        });
        return {
          ok: false,
          error: "操作失败:行内标记应用异常,请重新读取文档后重试",
        };
      }
      continue;
    }
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
      const location = blockIndexForMarkdownLine(workingDoc, op.line);
      if (!location.ok) return location;
      workingDoc = {
        ...workingDoc,
        content: [
          ...workingDoc.content.slice(0, location.index + 1),
          ...insertDoc.content,
          ...workingDoc.content.slice(location.index + 1),
        ],
      };
      continue;
    }
    if (op.kind === "insertAfterBlock") {
      const anchor = findInsertAfterBlockAnchor(workingDoc, op.blockId);
      if (anchor.kind === "missing") {
        const existedBeforeBatch = findInsertAfterBlockAnchor(candidateDoc, op.blockId).kind !== "missing";
        return {
          ok: false,
          error: existedBeforeBatch
            ? "锚点块已被同批前序操作删除"
            : `锚点块 ${op.blockId} 不存在，请重新读取文档并使用最新 blockId`,
        };
      }
      if (anchor.kind === "tableCell") {
        return { ok: false, error: "暂不支持表格内锚点" };
      }
      if (anchor.kind === "unsupported") {
        return { ok: false, error: "blockId 必须指向列表项或顶层块" };
      }

      const insertDoc = normalizePmDoc(markdownToPm(op.markdown));
      if (insertDoc.content.length === 0) {
        return { ok: false, error: "insertAfterBlock 的 markdown 不能为空" };
      }
      if (hasEmptyTaskItem(insertDoc)) {
        return { ok: false, error: "insertAfterBlock 的 taskItem 内容不能为空" };
      }
      const cursorRef = insertCursorByAnchor.get(op.blockId) ?? op.blockId;
      if (anchor.kind === "listItem") {
        const listBlock = insertDoc.content[0];
        if (
          insertDoc.content.length !== 1 ||
          !listBlock ||
          listBlock.type !== anchor.parentList.type ||
          listBlock.content.length !== 1
        ) {
          return {
            ok: false,
            error: "列表项锚点的 markdown 必须恰好包含 1 条同类列表项",
          };
        }
        const listItem = listBlock.content[0]!;
        const firstBlock = listItem.content[0];
        if (
          !firstBlock ||
          pmToPlainText({
            type: "doc",
            attrs: { schemaVersion: workingDoc.attrs.schemaVersion },
            content: [firstBlock],
          }).trim().length === 0
        ) {
          return { ok: false, error: "insertAfterBlock 的列表项内容不能为空" };
        }
        const aiList = blockToAi(listBlock);
        if (
          (aiList.type !== "bulletList" && aiList.type !== "orderedList" && aiList.type !== "taskList") ||
          aiList.items.length !== 1
        ) {
          return { ok: false, error: "列表项 markdown 编译失败" };
        }
        const edited = applyBlockEdits(workingDoc, [{
          action: "insertListItem",
          parentRef: anchor.parentList.attrs.blockId,
          at: "after",
          ref: cursorRef,
          item: aiList.items[0]!,
        }]);
        if (!edited.ok || !edited.doc) {
          return { ok: false, error: edited.error ?? "列表项插入失败" };
        }
        const insertedRef = edited.applied.at(-1);
        if (insertedRef) insertCursorByAnchor.set(op.blockId, insertedRef);
        workingDoc = edited.doc;
        continue;
      }

      const edited = applyBlockEdits(workingDoc, [{
        action: "insertBlock",
        position: "after",
        ref: cursorRef,
        blocks: insertDoc.content.map(blockToAi),
      }]);
      if (!edited.ok || !edited.doc) {
        return { ok: false, error: edited.error ?? "顶层块插入失败" };
      }
      if (edited.skippedDuplicateInserts > 0) {
        return { ok: false, error: "插入内容与锚点后相邻块重复" };
      }
      const insertedRef = edited.applied.at(-1);
      if (insertedRef) insertCursorByAnchor.set(op.blockId, insertedRef);
      workingDoc = edited.doc;
      continue;
    }
    if (op.kind === "deleteBlock" || op.kind === "deleteListItem") {
      const edited = applyBlockEdits(workingDoc, [{
        action: op.kind,
        ref: op.blockId,
      }]);
      if (!edited.ok || !edited.doc) {
        return {
          ok: false,
          error: edited.error ?? `结构操作 ${op.kind} 失败`,
        };
      }
      workingDoc = edited.doc;
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

type ExternalListBlock = Extract<PmBlockNode, { type: "bulletList" | "orderedList" | "taskList" }>;

type InsertAfterBlockAnchor =
  | { kind: "topLevel" }
  | { kind: "listItem"; parentList: ExternalListBlock }
  | { kind: "tableCell" }
  | { kind: "unsupported" }
  | { kind: "missing" };

function findInsertAfterBlockAnchor(doc: PmDoc, blockId: string): InsertAfterBlockAnchor {
  for (const block of doc.content) {
    if (block.attrs.blockId === blockId) return { kind: "topLevel" };
    const nested = findNestedInsertAfterBlockAnchor(block, blockId, false, null);
    if (nested.kind !== "missing") return nested;
  }
  return { kind: "missing" };
}

function findNestedInsertAfterBlockAnchor(
  node: PmNode,
  blockId: string,
  insideTableCell: boolean,
  parentList: ExternalListBlock | null,
): InsertAfterBlockAnchor {
  const nextInsideTableCell =
    insideTableCell || node.type === "tableCell" || node.type === "tableHeader";
  const attrs = "attrs" in node ? node.attrs as { blockId?: unknown } : null;
  if (attrs?.blockId === blockId) {
    if (nextInsideTableCell) return { kind: "tableCell" };
    if ((node.type === "listItem" || node.type === "taskItem") && parentList) {
      return { kind: "listItem", parentList };
    }
    return { kind: "unsupported" };
  }

  if (!("content" in node) || !Array.isArray(node.content)) return { kind: "missing" };
  const childParentList = isExternalListBlock(node) ? node : null;
  for (const child of node.content) {
    const nested = findNestedInsertAfterBlockAnchor(
      child as PmNode,
      blockId,
      nextInsideTableCell,
      childParentList,
    );
    if (nested.kind !== "missing") return nested;
  }
  return { kind: "missing" };
}

function isExternalListBlock(node: PmNode): node is ExternalListBlock {
  return node.type === "bulletList" || node.type === "orderedList" || node.type === "taskList";
}

function hasEmptyTaskItem(doc: PmDoc): boolean {
  const visit = (node: PmNode): boolean => {
    if (node.type === "taskItem") {
      const firstBlock = node.content[0];
      if (
        !firstBlock ||
        pmToPlainText({
          type: "doc",
          attrs: { schemaVersion: doc.attrs.schemaVersion },
          content: [firstBlock],
        }).trim().length === 0
      ) {
        return true;
      }
    }
    return "content" in node && Array.isArray(node.content) &&
      node.content.some((child) => visit(child as PmNode));
  };
  return doc.content.some(visit);
}

function blockIndexForMarkdownLine(
  doc: PmDoc,
  line: number,
): { ok: true; index: number } | { ok: false; error: string } {
  const staleHint = "同批前序操作会使后续行号过期；请重读文档后拆批提交";
  if (!hasCanonicalDoc({ doc })) return { ok: false, error: `文档为空，无法定位行号；${staleHint}` };
  const serialized = pmToMarkdownWithLineMap(doc);
  const span = serialized.blocks.find((item) => line >= item.startLine && line <= item.endLine);
  if (!span) {
    return { ok: false, error: `第 ${line} 行超出当前 Markdown 正文范围；${staleHint}` };
  }
  if (span.contentEndLine > span.startLine && line < span.contentEndLine) {
    return {
      ok: false,
      error: `第 ${line} 行位于多行 ${span.blockType} 块 ${span.blockId} 内部，不能使用 insertAfterLine；请改用 insertAfterBlock 并传入 blockId。${staleHint}`,
    };
  }
  return { ok: true, index: span.blockIndex };
}

const EXTERNAL_OP_SOURCE_PREFIX = "external-op:";
const MAX_EXTERNAL_STRUCTURAL_OP_RECORDS = 64;

interface ExternalStructuralOpIdentity {
  opId: string;
  digest: string;
  source: string;
}

export function hasExternalStructuralOp(ops: readonly ExternalProposeOp[]): boolean {
  return EXTERNAL_STRUCTURAL_OP_KINDS.some((kind) =>
    ops.some((op) => op.kind === kind)
  );
}

function externalStructuralOpIdentity(
  data: Extract<Command, { kind: "externalPropose" }>["data"],
): ExternalStructuralOpIdentity | null {
  const hasStructuralOp = hasExternalStructuralOp(data.ops);
  if (!hasStructuralOp || !data.opId) return null;
  const digest = crypto
    .createHash("sha256")
    .update(JSON.stringify({ expectedDocVersion: data.expectedDocVersion, ops: data.ops }))
    .digest("hex");
  return {
    opId: data.opId,
    digest,
    source: `${EXTERNAL_OP_SOURCE_PREFIX}${encodeURIComponent(data.opId)}:${digest}`,
  };
}

function externalOpSourcePrefix(opId: string): string {
  return `${EXTERNAL_OP_SOURCE_PREFIX}${encodeURIComponent(opId)}:`;
}

function rememberExternalStructuralOp(
  records: Map<string, string>,
  identity: ExternalStructuralOpIdentity,
): void {
  records.delete(identity.opId);
  while (records.size >= MAX_EXTERNAL_STRUCTURAL_OP_RECORDS) {
    const oldest = records.keys().next().value as string | undefined;
    if (!oldest) break;
    records.delete(oldest);
  }
  records.set(identity.opId, identity.digest);
}

type DocWriteCommand = Extract<Command, { kind: "updateDoc" | "externalPropose" }>;

export function isExternalBusyLeaseHolder(
  session: SessionState,
  owner: CommandExecutionContext["externalLeaseOwner"],
  now = Date.now(),
): boolean {
  const lease = session.externalBusyLease;
  return owner !== undefined
    && lease !== null
    && lease.expiresAt > now
    && lease.principalId === owner.principalId
    && lease.turnId === owner.turnId;
}

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
          // 必须从单调块执行后的 session canonical 取值；stale 回放的 result 属于旧版本。
          contentHash: getPmContentHash(currentPmDoc(session)),
          createdNewVersion: result.createdNewVersion,
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
      const structuralOpIdentity = externalStructuralOpIdentity(command.data);
      const structuralOpSource = structuralOpIdentity?.source ?? null;
      const firstOp = command.data.ops[0];
      const fullDraftOp = firstOp?.kind === "fullDraft" ? firstOp : null;
      const qingmlDraftOp = firstOp?.kind === "qingmlDraft" ? firstOp : null;
      const titleOp = command.data.ops.find((op) => op.kind === "setTitle");
      const titleResult = truncateTitleWithNotice(titleOp?.title ?? null);

      const holderOwnsOnlyBusyLease = session.streamId === null
        && isExternalBusyLeaseHolder(session, context.externalLeaseOwner);
      if (
        (deriveAgentBusy(session) && !holderOwnsOnlyBusyLease)
        || deriveActiveOverlay(session) !== null
      ) {
        yield docWriteReason(clientMutationId, "agent_busy");
        return;
      }
      const contentState = deriveContentState(session);
      if (structuralOpIdentity) {
        const recordedDigest = session.externalStructuralOpDigests.get(
          structuralOpIdentity.opId,
        );
        if (recordedDigest && recordedDigest !== structuralOpIdentity.digest) {
          yield docWriteReason(
            clientMutationId,
            "validation_error",
            undefined,
            "opId 已用于另一份操作内容；请为新操作生成新的 opId",
          );
          return;
        }
        if (recordedDigest === structuralOpIdentity.digest && contentState.kind !== "pendingReview") {
          yield docWriteReason(
            clientMutationId,
            "validation_error",
            undefined,
            "该 opId 对应的操作已结束审阅，不能重放；如需再次操作，请重读文档并生成新的 opId",
          );
          return;
        }
      }
      if (contentState.kind === "pendingReview") {
        if (structuralOpIdentity) {
          const pending = await documentDraftRepo.load(session.docId).catch(() => null);
          if (pending?.sourceToolCallId === structuralOpSource && session.suggestions.size > 0) {
            if (titleResult.truncated) {
              yield {
                kind: "sessionMeta",
                data: {
                  sessionId: session.sessionId,
                  title: session.title,
                  notice: { kind: "title_truncated", maxChars: MAX_TITLE_CHARS },
                },
              };
            }
            yield {
              kind: "docDiffReady",
              data: {
                baseVersion: session.suggestionBaseVersion ?? session.docVersion,
                suggestions: Array.from(session.suggestions.values(), (record) => record.suggestion),
                previewDoc: session.suggestionBaseDoc ?? session.doc ?? undefined,
                editedDoc: pending.draftPmDoc,
              },
            };
            return;
          }
          const recordedDigest = session.externalStructuralOpDigests.get(
            structuralOpIdentity.opId,
          );
          if (recordedDigest === structuralOpIdentity.digest) {
            yield docWriteReason(
              clientMutationId,
              "validation_error",
              undefined,
              "该 opId 对应的操作已结束审阅，不能重放；如需再次操作，请重读文档并生成新的 opId",
            );
            return;
          }
          if (pending?.sourceToolCallId?.startsWith(externalOpSourcePrefix(structuralOpIdentity.opId))) {
            yield docWriteReason(
              clientMutationId,
              "validation_error",
              undefined,
              "opId 已用于另一份操作内容；请为新操作生成新的 opId",
            );
            return;
          }
        }
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
        const nextTitle = titleResult.title!;
        const titleChanged = nextTitle !== session.title;
        const pinChanged = !session.titlePinned;
        if (titleChanged) {
          session.title = nextTitle;
        }
        if (titleChanged || titleResult.truncated) {
          yield {
            kind: "sessionMeta",
            data: {
              sessionId: session.sessionId,
              title: session.title,
              ...(titleResult.truncated
                ? { notice: { kind: "title_truncated" as const, maxChars: MAX_TITLE_CHARS } }
                : {}),
            },
          };
        }
        session.titlePinned = true;
        if (titleChanged || pinChanged) {
          await persistSessionMetadata(session);
        }
        // 同标题重放也按幂等成功返回；标题不进入正文审阅，也不推进 docVersion。
        yield {
          kind: "docWriteResult",
          data: {
            ok: true,
            clientMutationId,
            docVersion: session.docVersion,
            contentHash: getPmContentHash(currentPmDoc(session)),
            createdNewVersion: false,
          },
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
        if (nextTitle && (nextTitle !== session.title || qingmlDraft?.titleTruncated)) {
          session.title = nextTitle;
          yield {
            kind: "sessionMeta",
            data: {
              sessionId: session.sessionId,
              title: session.title,
              ...(qingmlDraft?.titleTruncated
                ? { notice: { kind: "title_truncated" as const, maxChars: MAX_TITLE_CHARS } }
                : {}),
            },
          };
        }
        await persistSessionMetadata(session);
        yield* emitProjectedDocState(session, qingmlDraft ? "external_qingml_draft" : "external_full_draft");
        yield {
          kind: "docWriteResult",
          data: {
            ok: true,
            clientMutationId,
            docVersion: session.docVersion,
            contentHash: getPmContentHash(currentPmDoc(session)),
            createdNewVersion: result.createdNewVersion,
          },
        };
        return;
      }

      if (fullDraftOp) {
        yield docWriteReason(clientMutationId, "validation_error");
        return;
      }

      // 先在会话外纯计算整批；任一 op 失败时不能连空候选壳都留进 session。
      const baseCandidate = session.docDraftCandidateDoc ?? clonePmDoc(currentPmDoc(session));
      let workingDoc: PmDoc;
      if (qingmlDraft) {
        workingDoc = clonePmDoc(qingmlDraft.doc);
      } else {
        workingDoc = baseCandidate;
        const applied = await applyExternalProposalOps(workingDoc, contentOps);
        if (!applied.ok) {
          yield docWriteReason(clientMutationId, "validation_error", undefined, applied.error);
          return;
        }
        workingDoc = applied.doc;
      }
      ensureDraftCandidateDoc(session);
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

      const settled = yield* settleDraftCandidate({
        state: session,
        agentMessageId,
        streamId,
        runId,
        wholeDocument: qingmlDraft !== null,
        ignoreBlockIdentityOnlyReplacements: true,
        sourceToolCallId: structuralOpSource,
      });
      if (settled.hunkCount <= 0) {
        yield docWriteReason(clientMutationId, "validation_error");
        return;
      }
      let metadataChanged = false;
      if (structuralOpIdentity) {
        rememberExternalStructuralOp(session.externalStructuralOpDigests, structuralOpIdentity);
        metadataChanged = true;
      }
      if (titleOp) {
        const nextTitle = titleResult.title!;
        const titleChanged = nextTitle !== session.title;
        const pinChanged = !session.titlePinned;
        if (titleChanged) {
          session.title = nextTitle;
        }
        if (titleChanged || titleResult.truncated) {
          yield {
            kind: "sessionMeta",
            data: {
              sessionId: session.sessionId,
              title: session.title,
              ...(titleResult.truncated
                ? { notice: { kind: "title_truncated" as const, maxChars: MAX_TITLE_CHARS } }
                : {}),
            },
          };
        }
        session.titlePinned = true;
        metadataChanged ||= titleChanged || pinChanged;
      }
      if (qingmlDraft && !session.titlePinned) {
        const nextTitle = qingmlDraft.title ?? deriveTitleFromDoc(qingmlDraft.doc);
        if (nextTitle && (nextTitle !== session.title || qingmlDraft.titleTruncated)) {
          session.title = nextTitle;
          yield {
            kind: "sessionMeta",
            data: {
              sessionId: session.sessionId,
              title: session.title,
              ...(qingmlDraft.titleTruncated
                ? { notice: { kind: "title_truncated" as const, maxChars: MAX_TITLE_CHARS } }
                : {}),
            },
          };
          metadataChanged = true;
        }
      }
      if (metadataChanged) await persistSessionMetadata(session);
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
