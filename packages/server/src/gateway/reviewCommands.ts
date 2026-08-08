import type { BridgeFrame, Command } from "@qingagent/contract-ts";
import crypto from "node:crypto";
import {
  MASTRA_THREAD_ID_KEY,
  RequestContext,
} from "@mastra/core/request-context";
import {
  commitPatches as commitPatchesBridge,
  commitReviewGroups,
  expandReviewIds,
  ignoreAnnotationGroups,
  rewriteReviewSupplementsForIgnoredGroups,
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

function overlappingReviewGroupsFrame(): BridgeFrame {
  return {
    kind: "stream",
    data: {
      kind: "draftingFailed",
      data: {
        streamId: "error",
        reason: "审阅分组不能同时接受和拒绝，请刷新后重试",
        retriable: true,
      },
    },
  };
}

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
      for await (const frame of updatePatchVerdict(
        session,
        command.data.id,
        "accepted",
        command.data.reviewBatchId,
      )) {
        yield frame;
      }
      return;
    }

    case "rejectPatch": {
      if (!command.data.id && !command.data.reviewBatchId) {
        throw new Error("RejectPatch.data must include id or reviewBatchId for session routing");
      }
      const session = await restoreReviewSession(command, context);
      bindClientTraceId(session, resolvedClientTraceId, origin, modelOverrides);
      for await (const frame of updatePatchVerdict(
        session,
        command.data.id,
        "rejected",
        command.data.reviewBatchId,
      )) {
        yield frame;
      }
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
      const batchPatchIds = expandReviewIds(
        session,
        [],
        command.data.reviewBatchIds ?? [],
        { command: "commit", skipped: "acceptReviewBatchId" },
      );
      for (const id of batchPatchIds) {
        if (session.patchVerdicts.get(id) !== "accepted") {
          for await (const frame of updatePatchVerdict(
            session,
            id,
            "accepted",
          )) {
            yield frame;
          }
        }
      }
      const commitIds = [...new Set([
        ...command.data.ids,
        ...batchPatchIds.filter(
          (id) => session.patchVerdicts.get(id) === "accepted",
        ),
      ])];
      for await (const frame of commitPatchesBridge(session, commitIds)) {
        yield frame;
      }
      return;
    }

    case "commitReviewGroups": {
      const session = await restoreReviewSession(command, context);
      bindClientTraceId(session, resolvedClientTraceId, origin, modelOverrides);
      try {
        yield* commitReviewGroups(session, command.data);
      } catch (error) {
        if (
          error instanceof Error &&
          error.message.startsWith("Review batch cannot be both accepted and rejected:")
        ) {
          yield overlappingReviewGroupsFrame();
          return;
        }
        throw error;
      }
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
      // groupIds 缺省是“一键清理全部”及换页/发消息等批量清屏，不沉淀审查记忆。
      if (groupIds) {
        const abortSignal = context.commandAbortSignal ?? new AbortController().signal;
        const requestContext = new RequestContext([
          [MASTRA_THREAD_ID_KEY, session.threadId ?? session.sessionId],
          ["sessionId", session.sessionId],
          ["runId", `rewrite-review-supplement:${crypto.randomUUID()}`],
          ["clientTraceId", session.clientTraceId ?? null],
          ["origin", session.origin ?? "manual"],
          ["docVersion", session.docVersion],
          ["doc", session.doc],
          ["modelOverrides", session.modelOverrides],
          ["abortSignal", abortSignal],
        ] as never);
        await rewriteReviewSupplementsForIgnoredGroups({
          docId: session.docId,
          groups: selectedGroups,
          requestContext,
        });
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
