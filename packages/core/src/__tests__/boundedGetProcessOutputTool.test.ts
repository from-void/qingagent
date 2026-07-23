import type { CommandResult, Workspace } from "@mastra/core/workspace";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createBoundedGetProcessOutputTool } from "../workspace/boundedGetProcessOutputTool.js";

interface WaitOptions {
  onStdout?: (data: string) => void | Promise<void>;
  onStderr?: (data: string) => void | Promise<void>;
}

interface FakeProcessHandle {
  pid: string;
  command?: string;
  stdout: string;
  stderr: string;
  exitCode: number | undefined;
  wait: (options?: WaitOptions) => Promise<CommandResult>;
  kill: ReturnType<typeof vi.fn>;
}

const toolInvocationOptions = { toolCallId: "bounded-output-test", messages: [] };

function workspaceWithHandle(handle: FakeProcessHandle | undefined): Workspace {
  return {
    sandbox: {
      processes: {
        get: vi.fn(async () => handle),
      },
    },
  } as unknown as Workspace;
}

function createHarness(handle: FakeProcessHandle | undefined, waitMaxMs = 20) {
  const workspace = workspaceWithHandle(handle);
  const tool = createBoundedGetProcessOutputTool({
    getWorkspace: async () => workspace,
    waitMaxMs,
  });
  return { tool, workspace };
}

async function executeTool(
  tool: ReturnType<typeof createBoundedGetProcessOutputTool>,
  input: { pid: string; tail?: number; wait?: boolean },
  context = toolInvocationOptions,
): Promise<string> {
  if (!tool.execute) throw new Error("get_process_output execute missing");
  return await tool.execute(input, context as never) as string;
}

function neverSettlingHandle(output = "扫码地址：https://example.test/auth\n"): FakeProcessHandle {
  return {
    pid: "qr-login",
    command: "wecom-cli login",
    stdout: output,
    stderr: "",
    exitCode: undefined,
    wait: vi.fn(() => new Promise<CommandResult>(() => {})),
    kill: vi.fn(async () => true),
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("bounded get_process_output", () => {
  it("wait:true 到上限后返回当前输出和仍在运行提示，不杀进程", async () => {
    const handle = neverSettlingHandle();
    const { tool } = createHarness(handle, 15);

    const output = await executeTool(tool, { pid: handle.pid, wait: true });

    expect(output).toContain("扫码地址：https://example.test/auth");
    expect(output).toContain("进程仍在运行（等待 15ms 未退出）");
    expect(output).toContain("不带 wait 再次轮询");
    expect(output).not.toContain("Exit code:");
    expect(handle.kill).not.toHaveBeenCalled();
  });

  it("wait:true 且上限内退出时返回输出和 Exit code，并发退出事件", async () => {
    const custom = vi.fn(async () => {});
    const handle: FakeProcessHandle = {
      pid: "short-process",
      stdout: "before\n",
      stderr: "warning\n",
      exitCode: undefined,
      kill: vi.fn(async () => true),
      wait: vi.fn(async (options) => {
        handle.stdout += "done\n";
        await options?.onStdout?.("done\n");
        handle.exitCode = 7;
        return {
          success: false,
          exitCode: 7,
          stdout: handle.stdout,
          stderr: handle.stderr,
          executionTimeMs: 8,
        };
      }),
    };
    const { tool } = createHarness(handle, 100);

    const output = await executeTool(tool, { pid: handle.pid, wait: true }, {
      ...toolInvocationOptions,
      agent: { toolCallId: "exit-tool-call" },
      writer: { custom, write: vi.fn() },
    } as never);

    expect(output).toBe("stdout:\nbefore\ndone\n\n\nstderr:\nwarning\n\n\nExit code: 7");
    expect(output).not.toContain("仍在运行");
    expect(custom).toHaveBeenCalledWith(expect.objectContaining({
      type: "data-sandbox-exit",
      data: expect.objectContaining({ exitCode: 7, success: false, toolCallId: "exit-tool-call" }),
    }));
    expect(handle.kill).not.toHaveBeenCalled();
  });

  it("pid 不存在时返回 Mastra 原版提示", async () => {
    const { tool } = createHarness(undefined);

    await expect(executeTool(tool, { pid: "missing" }))
      .resolves.toBe("No background process found with PID missing.");
  });

  it("tail 默认 200 行、负数取绝对值且 0 不截断，与 Mastra 原版一致", async () => {
    const allLines = Array.from({ length: 201 }, (_, index) => `line-${index + 1}`).join("\n");
    const handle = neverSettlingHandle(allLines);
    const { tool } = createHarness(handle);

    const defaultTail = await executeTool(tool, { pid: handle.pid });
    expect(defaultTail).toContain("[showing last 200 of 201 lines]");
    expect(defaultTail).not.toContain("line-1\n");
    expect(defaultTail).toContain("line-201");

    const negativeTail = await executeTool(tool, { pid: handle.pid, tail: -2 });
    expect(negativeTail).toBe("[showing last 2 of 201 lines]\nline-200\nline-201");

    const unlimited = await executeTool(tool, { pid: handle.pid, tail: 0 });
    expect(unlimited).toBe(allLines);
  });

  it("等待期间发送 tool-heartbeat，execute 收尾后停止", async () => {
    vi.useFakeTimers();
    const handle = neverSettlingHandle();
    const write = vi.fn(async () => {});
    const { tool } = createHarness(handle, 30_000);

    const result = executeTool(tool, { pid: handle.pid, wait: true }, {
      ...toolInvocationOptions,
      writer: { custom: vi.fn(async () => {}), write },
    } as never);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(write).toHaveBeenCalledWith(expect.objectContaining({
      type: "tool-heartbeat",
      tool: "get_process_output",
    }));

    await vi.advanceTimersByTimeAsync(20_000);
    await expect(result).resolves.toContain("进程仍在运行");
    const countAfterReturn = write.mock.calls.length;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(write).toHaveBeenCalledTimes(countAfterReturn);
  });

  it("有界返回后悬挂 wait 的迟到回调和 rejection 不产生未捕获异常", async () => {
    let callbacks: WaitOptions | undefined;
    let rejectWait: ((reason: unknown) => void) | undefined;
    let writerClosed = false;
    const custom = vi.fn(async () => {
      if (writerClosed) throw new Error("writer already closed");
    });
    const handle = neverSettlingHandle();
    handle.wait = vi.fn((options?: WaitOptions) => {
      callbacks = options;
      return new Promise<CommandResult>((_resolve, reject) => {
        rejectWait = reject;
      });
    });
    const { tool } = createHarness(handle, 10);

    await expect(executeTool(tool, { pid: handle.pid, wait: true }, {
      ...toolInvocationOptions,
      writer: { custom, write: vi.fn() },
    } as never)).resolves.toContain("进程仍在运行");

    writerClosed = true;
    await expect(callbacks?.onStdout?.("late stdout\n")).resolves.toBeUndefined();
    await expect(callbacks?.onStderr?.("late stderr\n")).resolves.toBeUndefined();
    rejectWait?.(new Error("late wait failure"));
    await Promise.resolve();
    expect(custom).toHaveBeenCalledTimes(3);
  });
});
