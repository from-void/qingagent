import type {
  CommandResult,
  ProcessHandle,
  Workspace,
} from "@mastra/core/workspace";
import { acquireQingagentSessionWorkspace } from "../agents/qingagent.js";
import {
  forgetBackgroundCommandOwner,
  recordBackgroundCommandTombstone,
} from "../session/backgroundCommand.js";
import type { SessionState } from "../session/sessionState.js";
import {
  settleBackgroundCommand,
  type BackgroundCommandSettlement,
  type BackgroundCommandTerminal,
} from "./backgroundCommandSettlement.js";

export type BackgroundCommandStopReason = "userStop" | "sessionClosed";

export interface TerminateSessionBackgroundCommandsOptions {
  getWorkspaceLease?: () => Promise<{
    workspace: Workspace;
    release: () => void;
  }>;
}

function terminalFromNaturalExit(result: CommandResult): BackgroundCommandTerminal {
  if (result.timedOut) {
    return { kind: "timedOut", exitCode: result.exitCode };
  }
  if (result.exitCode === 0) {
    return { kind: "succeeded", exitCode: 0 };
  }
  return { kind: "failed", exitCode: result.exitCode };
}

async function settleAlreadyExited(
  state: SessionState,
  pid: string,
  handle: ProcessHandle,
): Promise<BackgroundCommandSettlement | null> {
  const result = await handle.wait();
  const settlement = settleBackgroundCommand(state, pid, terminalFromNaturalExit(result), {
    eventPid: pid,
    sourceToolName: "session-background-cleanup",
  });
  if (!settlement) forgetBackgroundCommandOwner(state, pid);
  return settlement;
}

/**
 * 只遍历会话既有 PID→owner 索引，不维护第二份进程注册表。
 * 调用方必须在 forget/invalidate workspace 之前 await，确保 retained lease 能在
 * handle.wait() 结算后释放，随后 workspace.destroy() 才会真正拆沙箱。
 */
export async function terminateSessionBackgroundCommands(
  state: SessionState,
  reason: BackgroundCommandStopReason,
  options: TerminateSessionBackgroundCommandsOptions = {},
): Promise<BackgroundCommandSettlement[]> {
  const pids = [...(state._backgroundCommandOwnerByPid?.keys() ?? [])];
  if (pids.length === 0) return [];

  const lease = await (
    options.getWorkspaceLease ??
    (() => acquireQingagentSessionWorkspace(state.sessionId))
  )();
  const settlements: BackgroundCommandSettlement[] = [];
  try {
    const processes = lease.workspace.sandbox?.processes;
    if (!processes) return settlements;

    for (const pid of pids) {
      let handle: ProcessHandle | undefined;
      try {
        handle = await processes.get(pid);
      } catch {
        continue;
      }
      if (!handle) {
        forgetBackgroundCommandOwner(state, pid);
        continue;
      }
      if (handle.exitCode !== undefined) {
        const settlement = await settleAlreadyExited(state, pid, handle).catch(() => null);
        if (settlement) settlements.push(settlement);
        continue;
      }

      let killed = false;
      try {
        killed = await handle.kill();
      } catch {
        // kill 抛错时不能无界 await 一个仍活着的进程；会话关闭还有随后
        // workspace.destroy 的兜底，用户停止则保留索引供后续再次止付/TTL 回收。
        continue;
      }
      if (!killed) {
        const settlement = await settleAlreadyExited(state, pid, handle).catch(() => null);
        if (settlement) settlements.push(settlement);
        continue;
      }
      await handle.wait().catch(() => undefined);
      recordBackgroundCommandTombstone(state, pid, reason);
      const settlement = settleBackgroundCommand(
        state,
        pid,
        { kind: "killed", signal: reason === "userStop" ? "用户停止" : "会话关闭" },
        {
          eventPid: pid,
          sourceToolName: "session-background-cleanup",
        },
      );
      if (!settlement) forgetBackgroundCommandOwner(state, pid);
      if (settlement) settlements.push(settlement);
    }
    return settlements;
  } finally {
    lease.release();
  }
}
