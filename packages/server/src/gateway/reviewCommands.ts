import type { BridgeFrame, Command } from "@qingagent/contract-ts";
import {
  commitPatches as commitPatchesBridge,
  commitReviewGroups,
  ignoreAnnotationGroups,
  insertReviewDismissalSignal,
  updatePatchVerdict,
} from "./bridgeCore";
import { bindClientTraceId } from "./commandTracing";
import type { CommandExecutionContext } from "./commandTypes";
import {
  findSessionByPatch,
  findSessionByReviewBatchId,
  getOrRestoreSession,
} from "./sessionLifecycle";

type ReviewCommand = Extract<Command, {
  kind:
    | "acceptPatch"
    | "rejectPatch"
    | "commitPatches"
    | "commitReviewGroups"
    | "ignoreAnnotationGroups";
}>;

function inMemoryReviewSessionId(command: ReviewCommand): string | undefined {
  switch (command.kind) {
    case "acceptPatch":
    case "rejectPatch":
      return (
        (command.data.id ? findSessionByPatch(command.data.id)?.sessionId : undefined) ??
        (command.data.reviewBatchId
          ? findSessionByReviewBatchId(command.data.reviewBatchId)?.sessionId
          : undefined)
      );
    case "commitPatches":
      return (
        (command.data.ids[0] ? findSessionByPatch(command.data.ids[0])?.sessionId : undefined) ??
        (command.data.reviewBatchIds?.[0]
          ? findSessionByReviewBatchId(command.data.reviewBatchIds[0])?.sessionId
          : undefined)
      );
    case "commitReviewGroups":
    case "ignoreAnnotationGroups":
      return undefined;
  }
}

async function restoreReviewSession(
  command: ReviewCommand,
  context: CommandExecutionContext,
) {
  const sessionId = context.sessionId ?? inMemoryReviewSessionId(command);
  if (!sessionId) {
    throw new Error(`Unable to route ${command.kind} to a session`);
  }
  const session = await getOrRestoreSession(sessionId);
  if (!session) throw new Error(`Session not found: ${sessionId}`);
  return session;
}

export async function* handleReviewCommand(
  command: ReviewCommand,
  context: CommandExecutionContext,
): AsyncGenerator<BridgeFrame> {
  const { resolvedClientTraceId, origin, modelOverrides } = context;
  switch (command.kind) {
    case "acceptPatch": {
      if (!command.data.id && !command.data.reviewBatchId) {
        throw new Error("AcceptPatch.data must include id or reviewBatchId for session routing");
      }
      const session = await restoreReviewSession(command, context);
      bindClientTraceId(session, resolvedClientTraceId, origin, modelOverrides);
      yield* updatePatchVerdict(session, command.data.id, "accepted", command.data.reviewBatchId);
      return;
    }

    case "rejectPatch": {
      if (!command.data.id && !command.data.reviewBatchId) {
        throw new Error("RejectPatch.data must include id or reviewBatchId for session routing");
      }
      const session = await restoreReviewSession(command, context);
      bindClientTraceId(session, resolvedClientTraceId, origin, modelOverrides);
      yield* updatePatchVerdict(session, command.data.id, "rejected", command.data.reviewBatchId);
      return;
    }

    case "commitPatches": {
      const firstId = command.data.ids[0];
      const firstReviewBatchId = command.data.reviewBatchIds?.[0];
      if (!firstId && !firstReviewBatchId) {
        throw new Error("CommitPatches.data must include ids or reviewBatchIds");
      }
      const session = await restoreReviewSession(command, context);
      bindClientTraceId(session, resolvedClientTraceId, origin, modelOverrides);
      if (command.data.reviewBatchIds && command.data.reviewBatchIds.length > 0) {
        for await (const frame of commitReviewGroups(session, {
          acceptReviewBatchIds: command.data.reviewBatchIds,
          keepPendingReviewBatchIds: [],
        })) {
          yield frame;
        }
        return;
      }
      for await (const frame of commitPatchesBridge(session, command.data.ids)) {
        yield frame;
      }
      return;
    }

    case "commitReviewGroups": {
      const session = await restoreReviewSession(command, context);
      bindClientTraceId(session, resolvedClientTraceId, origin, modelOverrides);
      yield* commitReviewGroups(session, command.data);
      return;
    }

    case "ignoreAnnotationGroups": {
      const session = await restoreReviewSession(command, context);
      bindClientTraceId(session, resolvedClientTraceId, origin, modelOverrides);
      const groupIds = command.data.groupIds;
      const selectedIds = new Set(groupIds ?? []);
      const selectedGroups = groupIds
        ? session.annotationGroups.filter((group) => selectedIds.has(group.id))
        : session.annotationGroups;
      if (command.data.rememberDismissal) {
        await Promise.all(selectedGroups.map((group) => insertReviewDismissalSignal({
          docId: session.docId,
          origin: group.origin,
          summary: group.summary,
          quote: group.anchors[0]?.quote ?? "",
        })));
      }
      await ignoreAnnotationGroups(session.docId, groupIds);
      session.annotationGroups = groupIds
        ? session.annotationGroups.map((group) => selectedIds.has(group.id)
          ? { ...group, status: "ignored" as const }
          : group)
        : [];
      yield {
        kind: "annotationGroupsReady",
        data: { groups: session.annotationGroups },
      };
      return;
    }
  }
}
