import type { BridgeFrame, Command } from "@qingagent/contract-ts";
import type { ModelOverrides } from "./bridgeCore";
import { registerBridgeCommandHandler } from "./commandRuntime";
import {
  getFailureFromFrame,
  normalizeClientTraceId,
  recordCommandSpan,
  resolveCommandSessionId,
  type Origin,
} from "./commandTracing";
import type { CommandExecutionContext } from "./commandTypes";
import type { ExternalLeaseOwner, TurnPreemptionReason } from "./sessionActor";
import { getSession } from "./sessionRegistry";
import { handleTurnCommand } from "./turnOrchestration";

export async function* handleCommand(
  command: Command,
  clientTraceId?: string,
  origin: Origin = "manual",
  modelOverrides?: ModelOverrides,
  client?: string,
  routedSessionId?: string,
  commandAbortSignal?: AbortSignal,
  preemptionReason?: TurnPreemptionReason,
  externalLeaseOwner?: ExternalLeaseOwner,
): AsyncGenerator<BridgeFrame> {
  // Actor 的 keyed route 是权威 sessionId。commitReviewGroups 本身不携带 sessionId，
  // /commit 冷恢复必须沿用 REST body 的路由键，不能依赖重启后不存在的 patch 内存索引。
  const cmdSessionId = routedSessionId ?? resolveCommandSessionId(command);
  const resolvedClientTraceId = normalizeClientTraceId(clientTraceId, cmdSessionId);
  console.info(formatAcceptedTurnLog(cmdSessionId ?? "unknown", command.kind));
  const existingSession = cmdSessionId ? getSession(cmdSessionId) : undefined;
  if (existingSession) {
    existingSession.origin = origin;
    if (modelOverrides) existingSession.modelOverrides = modelOverrides;
  }
  const commandSpan = recordCommandSpan(command, cmdSessionId, resolvedClientTraceId, origin);
  const context: CommandExecutionContext = {
    sessionId: cmdSessionId,
    clientTraceId,
    resolvedClientTraceId,
    origin,
    modelOverrides,
    client,
    commandAbortSignal,
    preemptionReason,
    externalLeaseOwner,
  };

  let failure: { reason: string; failureKind: string } | null = null;
  let completed = false;
  try {
    for await (const frame of routeCommand(command, context)) {
      failure ??= getFailureFromFrame(frame);
      yield frame;
    }
    if (failure) {
      commandSpan.endError(failure.reason, { failureKind: failure.failureKind });
    } else {
      commandSpan.endOk({ accepted: true });
    }
    completed = true;
  } catch (err) {
    commandSpan.endError(err, { failureKind: "throw" });
    throw err;
  } finally {
    if (!completed) {
      commandSpan.endError("stream aborted before command completed", {
        failureKind: "streamAborted",
      });
    }
  }
}

registerBridgeCommandHandler(handleCommand);

async function* routeCommand(
  command: Command,
  context: CommandExecutionContext,
): AsyncGenerator<BridgeFrame> {
  switch (command.kind) {
    case "updateAskMore": {
      const { handleAskMoreCommand } = await import("./askMoreCommands");
      yield* handleAskMoreCommand(command, context);
      return;
    }
    case "startSession":
    case "renameSession": {
      const { handleSessionCommand } = await import("./sessionCommands");
      yield* handleSessionCommand(command, context);
      return;
    }
    case "sendMessage":
    case "submitReviewOutcome":
    case "resumeAskUser":
    case "cancelAskUser":
    case "cancelStream": {
      yield* handleTurnCommand(command, context);
      return;
    }
    case "updateDoc":
    case "externalPropose": {
      const { handleDocWriteCommand } = await import("./docWriteCommands");
      yield* handleDocWriteCommand(command, context);
      return;
    }
    case "updateMaterialSummary":
    case "removeMaterial":
    case "reparseMaterial": {
      const { handleMaterialCommand } = await import("./materialCommands");
      yield* handleMaterialCommand(command, context);
      return;
    }
    case "attachFolder":
    case "detachFolder": {
      const { handleFolderSourceCommand } = await import("./folderSourceCommands");
      yield* handleFolderSourceCommand(command, context);
      return;
    }
    case "acceptPatch":
    case "rejectPatch":
    case "commitPatches":
    case "commitReviewGroups": {
      const { handleReviewCommand } = await import("./reviewCommands");
      yield* handleReviewCommand(command, context);
      return;
    }
    case "ignoreAnnotationGroups": {
      const { handleReviewCommand } = await import("./reviewCommands");
      yield* handleReviewCommand(command, context);
      return;
    }
    case "draftTemplate":
    case "listLexicons":
    case "setEnabledLexicons":
    case "listLexiconEntries":
    case "listStyleTemplates":
    case "getStyleTemplate":
    case "saveStyleTemplate":
    case "deleteStyleTemplate":
    case "listReviewTemplates":
    case "saveReviewTemplate":
    case "deleteReviewTemplate":
    case "selectReviewTemplate":
    case "getReviewSupplement":
    case "upsertReviewSupplement": {
      const { handleTemplateCommand } = await import("./templateCommands");
      yield* handleTemplateCommand(command, context);
      return;
    }
    case "listDerivatives":
    case "createDerivative":
    case "updateDerivativeParams":
    case "deleteDerivative":
    case "getDerivativeDoc": {
      const { handleDerivativeCommand } = await import("./derivativeCommands");
      yield* handleDerivativeCommand(command, context);
      return;
    }
  }
}

function formatAcceptedTurnLog(sessionId: string, commandKind: string): string {
  return `[turn] evt=accepted session=${safeTurnLogValue(sessionId)} cmd=${safeTurnLogValue(commandKind)}`;
}

function safeTurnLogValue(value: string): string {
  return value.replace(/\s+/g, "_");
}
