import type { CommandResult, ProcessHandle, Workspace } from "@mastra/core/workspace";
import { describe, expect, it, vi } from "vitest";
import { terminateSessionBackgroundCommands } from "../agent-run/backgroundCommandTermination.js";
import { createSession } from "../session/sessionState.js";

function runningHandle(pid: string) {
  let resolveWait!: (result: CommandResult) => void;
  const waitResult = new Promise<CommandResult>((resolve) => {
    resolveWait = resolve;
  });
  const handle = {
    pid,
    stdout: "",
    stderr: "",
    exitCode: undefined,
    kill: vi.fn(async () => {
      handle.exitCode = 128;
      resolveWait({
        success: false,
        exitCode: 128,
        stdout: "",
        stderr: "",
        executionTimeMs: 1,
        killed: true,
      });
      return true;
    }),
    wait: vi.fn(async () => waitResult),
    sendStdin: vi.fn(),
  } as unknown as ProcessHandle & { exitCode: number | undefined };
  return handle;
}

describe("会话后台进程止付", () => {
  it.each(["userStop", "sessionClosed"] as const)(
    "%s 逐个终止索引中的后台进程并释放 workspace lease",
    async (reason) => {
      const state = createSession(`background-stop-${reason}`);
      state._backgroundCommandOwnerByPid?.set("4242", "owner-1");
      const handle = runningHandle("4242");
      const release = vi.fn();
      const getWorkspaceLease = vi.fn(async () => ({
        workspace: {
          sandbox: {
            processes: {
              get: vi.fn(async () => handle),
            },
          },
        } as unknown as Workspace,
        release,
      }));

      await expect(terminateSessionBackgroundCommands(state, reason, {
        getWorkspaceLease,
      })).resolves.toEqual([]);

      expect(handle.kill).toHaveBeenCalledOnce();
      expect(handle.wait).toHaveBeenCalledOnce();
      expect(state._backgroundCommandOwnerByPid?.has("4242")).toBe(false);
      expect(release).toHaveBeenCalledOnce();
    },
  );
});
