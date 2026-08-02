import type { BridgeFrame, Command } from "@qingagent/contract-ts";
import {
  createDerivativeDoc,
  deleteDerivativeDoc,
  getDerivativeDocument,
  getDerivativeMeta,
  listDerivativesByThread,
  loadMainDocumentByThread,
  updateParams,
} from "./bridgeCore";
import type { CommandExecutionContext } from "./commandTypes";
import { getOrRestoreSession } from "./sessionLifecycle";

type DerivativeCommand = Extract<Command, {
  kind:
    | "listDerivatives"
    | "createDerivative"
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
  _context: CommandExecutionContext,
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
