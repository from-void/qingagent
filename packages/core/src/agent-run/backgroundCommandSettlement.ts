import type {
  CommandTerminalKind,
  ToolCallSpec,
} from "@qingagent/contract-ts";
import { mastra } from "../mastra.js";
import type { SessionState } from "../session/sessionState.js";
import {
  backgroundCommandOwnerToolCallId,
  forgetBackgroundCommandOwner,
} from "../session/backgroundCommand.js";
import { alignCommandCardWithStatus } from "./toolCards.js";

export { isPersistentBackgroundCommand } from "../session/backgroundCommand.js";

const logger = mastra.getLogger();

export type BackgroundCommandTerminal =
  | { kind: "succeeded"; exitCode?: 0 }
  | { kind: "failed"; exitCode: number }
  | { kind: "timedOut"; exitCode?: number }
  | { kind: "killed"; signal: string; exitCode?: number }
  | { kind: "aborted"; exitCode?: number };

export interface BackgroundCommandSettlement {
  messageId: string;
  toolCallId: string;
  spec: ToolCallSpec;
}

export interface BackgroundCommandSettlementSource {
  eventToolCallId?: string | null;
  sourceToolName?: string | null;
  eventPid?: string | null;
  argumentPid?: string | null;
}

interface CommandCardCandidate {
  messageId: string;
  index: number;
  spec: ToolCallSpec;
  predicates: {
    background: boolean;
    pidNonEmpty: boolean;
    pidMatches: boolean;
    ownerMatchesSpec: boolean;
    nonTerminal: boolean;
    statusAcceptsLifecycleUpdate: boolean;
  };
}

function terminalReason(terminal: BackgroundCommandTerminal): string {
  switch (terminal.kind) {
    case "succeeded":
      return "已完成";
    case "failed":
      // 是命令自己退出返回的失败，不是我们把它掐了；措辞必须能区分这两件事。
      return `命令自身返回失败（退出码 ${terminal.exitCode}）`;
    case "timedOut":
      return "已达最长运行时限，被系统终止";
    case "killed":
      return `已终止（${terminal.signal}）`;
    case "aborted":
      return "已中止，结果可能未知；进程状态未确认";
  }
}

function commandCardCandidates(
  state: SessionState,
  pid: string,
): CommandCardCandidate[] {
  const candidates: CommandCardCandidate[] = [];
  for (const message of state.chatHistory) {
    for (let index = 0; index < message.parts.length; index += 1) {
      const part = message.parts[index]!;
      if (part.kind !== "toolCall" || part.data.body.kind !== "commandCard") continue;
      const body = part.data.body.data;
      if (
        body.background !== true &&
        !(typeof body.pid === "string" && body.pid.length > 0) &&
        !(typeof body.ownerToolCallId === "string" && body.ownerToolCallId.length > 0)
      ) {
        continue;
      }
      candidates.push({
        messageId: message.id,
        index,
        spec: part.data,
        predicates: {
          background: body.background === true,
          pidNonEmpty: typeof body.pid === "string" && body.pid.length > 0,
          pidMatches: body.pid === pid,
          ownerMatchesSpec: body.ownerToolCallId === part.data.id,
          nonTerminal: body.terminalKind === undefined,
          statusAcceptsLifecycleUpdate:
            part.data.status.kind === "pending" ||
            part.data.status.kind === "running" ||
            part.data.status.kind === "done",
        },
      });
    }
  }
  return candidates;
}

function canSettleIndexedCandidate(candidate: CommandCardCandidate): boolean {
  return (
    candidate.predicates.nonTerminal &&
    candidate.predicates.statusAcceptsLifecycleUpdate
  );
}

function canRecoverByScanning(candidate: CommandCardCandidate): boolean {
  return (
    candidate.predicates.background &&
    candidate.predicates.pidNonEmpty &&
    candidate.predicates.pidMatches &&
    candidate.predicates.ownerMatchesSpec &&
    candidate.predicates.nonTerminal &&
    candidate.predicates.statusAcceptsLifecycleUpdate
  );
}

/**
 * 后台命令 owner 卡的唯一退出收口。
 * 正常路径优先使用 spawn 时建立的 PID→owner 索引；持久化恢复后才回退到完整卡体谓词扫描。
 * 已有终态始终不可覆盖，因此迟到退出事件不会改写 killed/aborted/failed。
 */
export function settleBackgroundCommand(
  state: SessionState,
  pid: string,
  terminal: BackgroundCommandTerminal,
  source: BackgroundCommandSettlementSource = {},
): BackgroundCommandSettlement | null {
  const candidates = commandCardCandidates(state, pid);
  const indexedOwnerToolCallId = backgroundCommandOwnerToolCallId(state, pid);
  const indexedCandidate = indexedOwnerToolCallId
    ? candidates.find((candidate) => candidate.spec.id === indexedOwnerToolCallId)
    : undefined;
  const candidate = indexedCandidate && canSettleIndexedCandidate(indexedCandidate)
    ? indexedCandidate
    : candidates.find(canRecoverByScanning);
  const matchMode = candidate
    ? candidate === indexedCandidate ? "indexed" : "scan"
    : null;

  let settlement: BackgroundCommandSettlement | null = null;
  if (candidate && candidate.spec.body.kind === "commandCard") {
    const message = state.chatHistory.find((item) => item.id === candidate.messageId);
    const reason = terminalReason(terminal);
    const terminalKind: CommandTerminalKind = terminal.kind;
    const succeeded = terminal.kind === "succeeded";
    const exitCode = terminal.exitCode ?? (
      succeeded
        ? 0
        : candidate.spec.body.data.exitCode === 0
          ? -1
          : candidate.spec.body.data.exitCode
    );
    const spec = alignCommandCardWithStatus({
      ...candidate.spec,
      status: succeeded
        ? { kind: "done" }
        : { kind: "failed", data: { retriable: false, reason } },
      body: {
        kind: "commandCard",
        data: {
          ...candidate.spec.body.data,
          exitCode,
          terminalKind,
          ...(terminal.kind === "killed" ? { signal: terminal.signal } : {}),
        },
      },
      result: candidate.spec.result ?? { kind: "genericText", data: reason },
    });
    if (message) {
      message.parts[candidate.index] = { kind: "toolCall", data: spec };
      forgetBackgroundCommandOwner(state, pid);
      settlement = { messageId: message.id, toolCallId: spec.id, spec };
    }
  }

  logger.info("Background command settlement evaluated", {
    pid,
    eventToolCallId: source.eventToolCallId ?? null,
    sourceToolName: source.sourceToolName ?? null,
    eventPid: source.eventPid ?? null,
    argumentPid: source.argumentPid ?? null,
    candidateCount: candidates.length,
    indexedOwnerToolCallId,
    candidates: candidates.map((candidateItem) => ({
      toolCallId: candidateItem.spec.id,
      ...candidateItem.predicates,
    })),
    matchMode,
    settled: settlement?.toolCallId ?? null,
  });
  return settlement;
}
