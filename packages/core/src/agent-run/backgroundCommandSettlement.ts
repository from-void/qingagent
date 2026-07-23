import type {
  CommandTerminalKind,
  ToolCallSpec,
} from "@qingagent/contract-ts";
import type { SessionState } from "../session/sessionState.js";
import { isPersistentBackgroundCommand } from "../session/backgroundCommand.js";
import { alignCommandCardWithStatus } from "./toolCards.js";

export { isPersistentBackgroundCommand } from "../session/backgroundCommand.js";

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

function terminalReason(terminal: BackgroundCommandTerminal): string {
  switch (terminal.kind) {
    case "succeeded":
      return "已完成";
    case "failed":
      return `运行失败（退出码 ${terminal.exitCode}）`;
    case "timedOut":
      return "执行超时";
    case "killed":
      return `已终止（${terminal.signal}）`;
    case "aborted":
      return "已中止，结果可能未知；进程状态未确认";
  }
}

/**
 * 后台命令 owner 卡的唯一退出收口。
 * 只允许更新仍在运行的同 PID owner；迟到退出事件不得覆盖 killed/aborted/failed 等既有终态。
 */
export function settleBackgroundCommand(
  state: SessionState,
  pid: string,
  terminal: BackgroundCommandTerminal,
): BackgroundCommandSettlement | null {
  for (const message of state.chatHistory) {
    for (let index = 0; index < message.parts.length; index += 1) {
      const part = message.parts[index]!;
      if (
        part.kind !== "toolCall" ||
        !isPersistentBackgroundCommand(part.data) ||
        part.data.body.kind !== "commandCard" ||
        part.data.body.data.pid !== pid
      ) {
        continue;
      }

      const reason = terminalReason(terminal);
      const terminalKind: CommandTerminalKind = terminal.kind;
      const succeeded = terminal.kind === "succeeded";
      const exitCode = terminal.exitCode ?? (
        succeeded ? 0 : part.data.body.data.exitCode === 0 ? -1 : part.data.body.data.exitCode
      );
      const spec = alignCommandCardWithStatus({
        ...part.data,
        status: succeeded
          ? { kind: "done" }
          : { kind: "failed", data: { retriable: false, reason } },
        body: {
          kind: "commandCard",
          data: {
            ...part.data.body.data,
            exitCode,
            terminalKind,
            ...(terminal.kind === "killed" ? { signal: terminal.signal } : {}),
          },
        },
        result: part.data.result ?? { kind: "genericText", data: reason },
      });
      message.parts[index] = { kind: "toolCall", data: spec };
      return { messageId: message.id, toolCallId: spec.id, spec };
    }
  }
  return null;
}
