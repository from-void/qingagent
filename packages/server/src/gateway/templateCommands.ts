import type { BridgeFrame, Command, ReviewType } from "@qingagent/contract-ts";
import crypto from "node:crypto";
import {
  MASTRA_THREAD_ID_KEY,
  RequestContext,
} from "@mastra/core/request-context";
import { StyleTemplateInUseError } from "@qingagent/db";
import {
  deleteReviewTemplate,
  deleteStyleTemplate,
  draftTemplate,
  getReviewDocSupplement,
  getReviewTemplate,
  getSelectedReviewTemplate,
  getStyleTemplate,
  listLexiconEntries,
  listLexicons,
  listReviewTemplates,
  listStyleTemplates,
  saveReviewTemplate,
  saveStyleTemplate,
  selectReviewTemplate,
  setEnabledLexicons,
  upsertReviewDocSupplement,
} from "./bridgeCore";
import type { CommandExecutionContext } from "./commandTypes";
import { getOrRestoreSession } from "./sessionLifecycle";

type TemplateCommand = Extract<Command, {
  kind:
    | "draftTemplate"
    | "listLexicons"
    | "setEnabledLexicons"
    | "listLexiconEntries"
    | "listStyleTemplates"
    | "getStyleTemplate"
    | "saveStyleTemplate"
    | "deleteStyleTemplate"
    | "listReviewTemplates"
    | "saveReviewTemplate"
    | "deleteReviewTemplate"
    | "selectReviewTemplate"
    | "getReviewSupplement"
    | "upsertReviewSupplement";
}>;

async function requireSession(sessionId: string) {
  const session = await getOrRestoreSession(sessionId);
  if (!session) throw new Error(`Session not found: ${sessionId}`);
  return session;
}

async function resolveReviewSupplementTemplateId(
  type: ReviewType,
  templateId?: string,
): Promise<string> {
  const template = templateId
    ? await getReviewTemplate(templateId)
    : await getSelectedReviewTemplate(type);
  if (templateId && (!template || template.type !== type)) {
    throw new Error("审查模板不存在或类型不匹配");
  }
  return template?.id ?? "";
}

export async function* handleTemplateCommand(
  command: TemplateCommand,
  context: CommandExecutionContext,
): AsyncGenerator<BridgeFrame> {
  switch (command.kind) {
    case "draftTemplate": {
      const session = await requireSession(command.data.sessionId);
      const abortSignal = context.commandAbortSignal ?? new AbortController().signal;
      const requestContext = new RequestContext([
        [MASTRA_THREAD_ID_KEY, session.threadId ?? session.sessionId],
        ["sessionId", session.sessionId],
        ["runId", `draft-template:${crypto.randomUUID()}`],
        ["clientTraceId", session.clientTraceId ?? null],
        ["origin", session.origin ?? "manual"],
        ["docVersion", session.docVersion],
        ["doc", session.doc],
        ["legacySections", session.legacySections],
        ["modelOverrides", session.modelOverrides],
        ["abortSignal", abortSignal],
      ] as never);
      const result = await draftTemplate(session, {
        scene: command.data.scene,
        intent: command.data.intent,
      }, requestContext);
      yield { kind: "templateDrafted", data: { ...result, requestId: command.data.requestId } };
      return;
    }
    case "listLexicons": {
      await requireSession(command.data.sessionId);
      yield { kind: "lexiconsListed", data: { lexicons: await listLexicons() } };
      return;
    }
    case "setEnabledLexicons": {
      await requireSession(command.data.sessionId);
      yield {
        kind: "enabledLexiconsSet",
        data: {
          requestId: command.data.requestId,
          lexicons: await setEnabledLexicons(command.data.enabledLexiconIds),
        },
      };
      return;
    }
    case "listLexiconEntries": {
      await requireSession(command.data.sessionId);
      const entries = await listLexiconEntries([command.data.resourceId]);
      yield {
        kind: "lexiconEntriesListed",
        data: {
          resourceId: command.data.resourceId,
          entries: entries.map(({ word, replacement, note }) => ({
            word,
            replacement,
            note,
          })),
        },
      };
      return;
    }
    case "listStyleTemplates": {
      await requireSession(command.data.sessionId);
      const items = await listStyleTemplates({
        dtype: command.data.dtype,
        slot: command.data.slot,
      });
      yield { kind: "styleTemplatesListed", data: { items, requestId: command.data.requestId } };
      return;
    }
    case "getStyleTemplate": {
      await requireSession(command.data.sessionId);
      const item = await getStyleTemplate(command.data.id);
      if (!item) throw new Error("模板不存在");
      yield { kind: "styleTemplateLoaded", data: { item, requestId: command.data.requestId } };
      return;
    }
    case "saveStyleTemplate": {
      await requireSession(command.data.sessionId);
      const item = await saveStyleTemplate(command.data);
      yield { kind: "styleTemplateSaved", data: { item, requestId: command.data.requestId } };
      return;
    }
    case "deleteStyleTemplate": {
      await requireSession(command.data.sessionId);
      try {
        if (!await deleteStyleTemplate(command.data.id)) throw new Error("模板不存在");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (
          message !== "每类至少保留一个模板" &&
          message !== "内置模板不可删除" &&
          !(error instanceof StyleTemplateInUseError)
        ) throw error;
        yield { kind: "styleTemplateDeleted", data: { id: command.data.id, error: message, requestId: command.data.requestId } };
        return;
      }
      yield { kind: "styleTemplateDeleted", data: { id: command.data.id, requestId: command.data.requestId } };
      return;
    }
    case "listReviewTemplates": {
      await requireSession(command.data.sessionId);
      const [items, selected] = await Promise.all([
        listReviewTemplates(command.data.type),
        getSelectedReviewTemplate(command.data.type),
      ]);
      yield {
        kind: "reviewTemplatesListed",
        data: { items, selectedTemplateId: selected?.id ?? null, requestId: command.data.requestId },
      };
      return;
    }
    case "saveReviewTemplate": {
      await requireSession(command.data.sessionId);
      const item = await saveReviewTemplate(command.data);
      yield { kind: "reviewTemplateSaved", data: { item, requestId: command.data.requestId } };
      return;
    }
    case "deleteReviewTemplate": {
      await requireSession(command.data.sessionId);
      const existing = await getReviewTemplate(command.data.id);
      const type = existing?.type;
      try {
        if (!await deleteReviewTemplate(command.data.id)) {
          throw new Error("审查模板不存在");
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (
          message !== "每类至少保留一个模板" &&
          message !== "内置审查模板不能删除"
        ) throw error;
        const selected = type ? await getSelectedReviewTemplate(type) : null;
        yield {
          kind: "reviewTemplateDeleted",
          data: {
            id: command.data.id,
            selectedTemplateId: selected?.id ?? null,
            error: message,
            requestId: command.data.requestId,
          },
        };
        return;
      }
      const selected = type ? await getSelectedReviewTemplate(type) : null;
      yield {
        kind: "reviewTemplateDeleted",
        data: { id: command.data.id, selectedTemplateId: selected?.id ?? null, requestId: command.data.requestId },
      };
      return;
    }
    case "selectReviewTemplate": {
      await requireSession(command.data.sessionId);
      await selectReviewTemplate(command.data.type, command.data.templateId);
      yield {
        kind: "reviewTemplateSelected",
        data: { type: command.data.type, templateId: command.data.templateId, requestId: command.data.requestId },
      };
      return;
    }
    case "getReviewSupplement": {
      const session = await requireSession(command.data.sessionId);
      const templateId = await resolveReviewSupplementTemplateId(
        command.data.type,
        command.data.templateId,
      );
      const supplement = await getReviewDocSupplement(
        session.docId,
        command.data.type,
        templateId,
      );
      yield {
        kind: "reviewSupplementLoaded",
        data: {
          type: command.data.type,
          ...(templateId ? { templateId } : {}),
          supplement,
          requestId: command.data.requestId,
        },
      };
      return;
    }
    case "upsertReviewSupplement": {
      const session = await requireSession(command.data.sessionId);
      const templateId = await resolveReviewSupplementTemplateId(
        command.data.type,
        command.data.templateId,
      );
      const supplement = await upsertReviewDocSupplement(
        session.docId,
        command.data.type,
        command.data.supplement,
        templateId,
      );
      yield {
        kind: "reviewSupplementSaved",
        data: {
          type: command.data.type,
          ...(templateId ? { templateId } : {}),
          supplement,
          requestId: command.data.requestId,
        },
      };
      return;
    }
  }
}
