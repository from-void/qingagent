import type { BridgeFrame, Command } from "@qingagent/contract-ts";
import {
  commitPatches as commitPatchesBridge,
  commitReviewGroups,
  updatePatchVerdict,
} from "./bridgeCore";
import { bindClientTraceId, normalizeClientTraceId } from "./commandTracing";
import type { CommandExecutionContext } from "./commandTypes";
import { findSessionByPatch, findSessionByReviewBatchId } from "./sessionLifecycle";

type ReviewCommand = Extract<Command, {
  kind: "acceptPatch" | "rejectPatch" | "commitPatches";
}>;

export async function* handleReviewCommand(
  command: ReviewCommand,
  context: CommandExecutionContext,
): AsyncGenerator<BridgeFrame> {
  const { clientTraceId, origin, modelOverrides } = context;
  switch (command.kind) {
    case "acceptPatch": {
      if (!command.data.id && !command.data.reviewBatchId) {
        throw new Error("AcceptPatch.data must include id or reviewBatchId for session routing");
      }
      const session =
        (command.data.id ? findSessionByPatch(command.data.id) : undefined) ??
        (command.data.reviewBatchId
          ? findSessionByReviewBatchId(command.data.reviewBatchId)
          : undefined);
      if (!session) {
        throw new Error(
          `No session owns patchId/reviewBatchId: ${command.data.id ?? command.data.reviewBatchId}`,
        );
      }
      // 这些命令按 patch 反查会话，入口无 sessionId；这里按真实会话重新归一化
      // clientTraceId（兜底用本会话 traceId）后绑定。
      bindClientTraceId(session, normalizeClientTraceId(clientTraceId, session.sessionId), origin, modelOverrides);
      yield* updatePatchVerdict(session, command.data.id, "accepted", command.data.reviewBatchId);
      return;
    }

    case "rejectPatch": {
      if (!command.data.id && !command.data.reviewBatchId) {
        throw new Error("RejectPatch.data must include id or reviewBatchId for session routing");
      }
      const session =
        (command.data.id ? findSessionByPatch(command.data.id) : undefined) ??
        (command.data.reviewBatchId
          ? findSessionByReviewBatchId(command.data.reviewBatchId)
          : undefined);
      if (!session) {
        throw new Error(
          `No session owns patchId/reviewBatchId: ${command.data.id ?? command.data.reviewBatchId}`,
        );
      }
      bindClientTraceId(session, normalizeClientTraceId(clientTraceId, session.sessionId), origin, modelOverrides);
      yield* updatePatchVerdict(session, command.data.id, "rejected", command.data.reviewBatchId);
      return;
    }

    case "commitPatches": {
      const firstId = command.data.ids[0];
      const firstReviewBatchId = command.data.reviewBatchIds?.[0];
      if (!firstId && !firstReviewBatchId) {
        throw new Error("CommitPatches.data must include ids or reviewBatchIds");
      }
      const session =
        (firstId ? findSessionByPatch(firstId) : undefined) ??
        (firstReviewBatchId ? findSessionByReviewBatchId(firstReviewBatchId) : undefined);
      if (!session) {
        throw new Error(`No session owns patchId/reviewBatchId: ${firstId ?? firstReviewBatchId}`);
      }
      bindClientTraceId(session, normalizeClientTraceId(clientTraceId, session.sessionId), origin, modelOverrides);
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
  }
}
