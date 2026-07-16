import type { BridgeFrame, Command } from "@qingagent/contract-ts";
import crypto from "node:crypto";
import {
  MASTRA_THREAD_ID_KEY,
  RequestContext,
} from "@mastra/core/request-context";
import {
  createDerivativeDoc,
  deleteDerivativeDoc,
  generateTranslations,
  getDerivativeDocument,
  getDerivativeMeta,
  listDerivativesByThread,
  loadMainDocumentByThread,
  updateParams,
} from "./bridgeCore";
import { bindClientTraceId } from "./commandTracing";
import type { CommandExecutionContext } from "./commandTypes";
import { getOrRestoreSession } from "./sessionLifecycle";

type DerivativeCommand = Extract<Command, {
  kind:
    | "listDerivatives"
    | "createDerivative"
    | "generateTranslations"
    | "updateDerivativeParams"
    | "deleteDerivative"
    | "getDerivativeDoc";
}>;

async function requireSession(sessionId: string) {
  const session = await getOrRestoreSession(sessionId);
  if (!session) throw new Error(`Session not found: ${sessionId}`);
  return session;
}

export async function* handleDerivativeCommand(
  command: DerivativeCommand,
  context: CommandExecutionContext,
): AsyncGenerator<BridgeFrame> {
  switch (command.kind) {
    case "listDerivatives": {
      await requireSession(command.data.sessionId);
      const items = await listDerivativesByThread(command.data.sessionId);
      yield { kind: "derivativesListed", data: { items, requestId: command.data.requestId } };
      return;
    }
    case "createDerivative": {
      await requireSession(command.data.sessionId);
      const source = await loadMainDocumentByThread(command.data.sessionId);
      if (!source || source.threadId !== command.data.sessionId) {
        throw new Error("当前会话主文档不存在");
      }
      const existing = (await listDerivativesByThread(command.data.sessionId)).find(
        (item) => item.dtype === command.data.dtype &&
          (command.data.dtype !== "translate" || item.targetLang === command.data.targetLang),
      );
      const item = existing ?? await createDerivativeDoc({
        threadId: command.data.sessionId,
        sourceDocId: source.id,
        dtype: command.data.dtype,
        templateId: command.data.templateId,
        writingStyleId: command.data.writingStyleId,
        layoutStyleId: command.data.layoutStyleId,
        targetLang: command.data.targetLang,
        privatePrompt: command.data.privatePrompt,
      });
      const writingStyleId = command.data.writingStyleId ?? command.data.templateId;
      const layoutStyleId = command.data.layoutStyleId ?? existing?.layoutStyleId;
      if (
        existing &&
        (existing.writingStyleId !== writingStyleId ||
          existing.layoutStyleId !== layoutStyleId ||
          existing.privatePrompt !== command.data.privatePrompt)
      ) {
        await updateParams(
          existing.docId,
          writingStyleId,
          command.data.privatePrompt,
          layoutStyleId,
        );
      }
      yield {
        kind: "derivativeCreated",
        data: { item: (await getDerivativeMeta(item.docId))!, requestId: command.data.requestId },
      };
      return;
    }
    case "generateTranslations": {
      const session = await requireSession(command.data.sessionId);
      bindClientTraceId(
        session,
        context.resolvedClientTraceId,
        context.origin,
        context.modelOverrides,
      );
      const metas = await Promise.all(
        command.data.docIds.map((docId) => getDerivativeMeta(docId)),
      );
      const targets = metas.map((meta, index) => {
        if (
          !meta ||
          meta.docId !== command.data.docIds[index] ||
          meta.threadId !== session.sessionId ||
          meta.dtype !== "translate" ||
          !meta.targetLang
        ) {
          throw new Error("翻译稿不存在或不属于当前会话");
        }
        return { docId: meta.docId, targetLang: meta.targetLang };
      });
      const abortSignal = context.commandAbortSignal ?? new AbortController().signal;
      const requestContext = new RequestContext([
        [MASTRA_THREAD_ID_KEY, session.threadId ?? session.sessionId],
        ["sessionId", session.sessionId],
        ["runId", `translate-derivative:${crypto.randomUUID()}`],
        ["clientTraceId", session.clientTraceId ?? null],
        ["origin", session.origin ?? "manual"],
        ["docVersion", session.docVersion],
        ["doc", session.doc],
        ["legacySections", session.legacySections],
        ["modelOverrides", session.modelOverrides],
        ["abortSignal", abortSignal],
      ] as never);
      yield* generateTranslations({
        sessionId: session.sessionId,
        targets,
        requestContext,
        abortSignal,
      });
      return;
    }
    case "updateDerivativeParams": {
      await requireSession(command.data.sessionId);
      const meta = await getDerivativeMeta(command.data.docId);
      if (!meta || meta.threadId !== command.data.sessionId) {
        throw new Error("衍生稿不存在或不属于当前会话");
      }
      await updateParams(
        meta.docId,
        command.data.writingStyleId ?? meta.writingStyleId,
        command.data.privatePrompt ?? meta.privatePrompt,
        command.data.layoutStyleId ?? meta.layoutStyleId,
        command.data.coverTemplate,
      );
      yield {
        kind: "derivativeParamsUpdated",
        data: { item: (await getDerivativeMeta(meta.docId))!, requestId: command.data.requestId },
      };
      return;
    }
    case "deleteDerivative": {
      await requireSession(command.data.sessionId);
      const deleted = await deleteDerivativeDoc(
        command.data.sessionId,
        command.data.docId,
      );
      if (!deleted) throw new Error("衍生稿不存在或不属于当前会话");
      yield { kind: "derivativeDeleted", data: { docId: command.data.docId, requestId: command.data.requestId } };
      return;
    }
    case "getDerivativeDoc": {
      await requireSession(command.data.sessionId);
      const meta = await getDerivativeMeta(command.data.docId);
      if (!meta || meta.threadId !== command.data.sessionId) {
        throw new Error("衍生稿不存在或不属于当前会话");
      }
      const document = await getDerivativeDocument(command.data.docId);
      if (!document) throw new Error("衍生稿文档不存在");
      yield {
        kind: "derivativeDocLoaded",
        data: {
          requestId: command.data.requestId,
          meta,
          docPm: document.docPm,
          docVersion: document.docVersion,
          title: document.title,
        },
      };
      return;
    }
  }
}
