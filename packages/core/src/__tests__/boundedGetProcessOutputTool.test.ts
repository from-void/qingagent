import type { CommandResult, Workspace } from "@mastra/core/workspace";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createBoundedGetProcessOutputTool } from "../workspace/boundedGetProcessOutputTool.js";
import {
  backgroundCommandTombstone,
  backgroundCommandTombstoneNotice,
  recordBackgroundCommandTombstone,
} from "../session/backgroundCommand.js";
import { createSession, type SessionState } from "../session/sessionState.js";

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
  stdoutTruncated?: boolean;
  stderrTruncated?: boolean;
  stdoutDroppedBytes?: number;
  stderrDroppedBytes?: number;
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

function createHarness(
  handle: FakeProcessHandle | undefined,
  waitMaxMs = 20,
  state?: SessionState,
) {
  const workspace = workspaceWithHandle(handle);
  const tool = createBoundedGetProcessOutputTool({
    getWorkspace: async () => workspace,
    waitMaxMs,
    getMissingProcessNotice: state
      ? (pid) => {
          const tombstone = backgroundCommandTombstone(state, pid);
          return tombstone ? backgroundCommandTombstoneNotice(tombstone) : null;
        }
      : undefined,
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

function neverSettlingHandle(output = "working\n"): FakeProcessHandle {
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
  it("无授权信号时 wait:true 仍等满上限，再返回当前输出且不杀进程", async () => {
    vi.useFakeTimers();
    const handle = neverSettlingHandle("正在下载 https://example.test/archive.zip\n");
    const { tool } = createHarness(handle, 15);

    let settled = false;
    const result = executeTool(tool, { pid: handle.pid, wait: true });
    void result.then(
      () => { settled = true; },
      () => { settled = true; },
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(handle.wait).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(14);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const output = await result;

    expect(output).toContain("正在下载 https://example.test/archive.zip");
    expect(output).toContain("进程仍在运行（等待 15ms 未退出）");
    expect(output).toContain("不带 wait 再次轮询");
    expect(output).not.toContain("Exit code:");
    expect(handle.kill).not.toHaveBeenCalled();
  });

  it("stdout 渐进出现授权 URL 与扫码语义时提前返回当前输出", async () => {
    vi.useFakeTimers();
    const handle = neverSettlingHandle("正在初始化\n");
    handle.wait = vi.fn((options) => new Promise<CommandResult>(() => {
      setTimeout(() => {
        const chunk = "请扫码完成授权：https://example.test/device-auth\n";
        handle.stdout += chunk;
        void options?.onStdout?.(chunk);
      }, 5);
    }));
    const { tool } = createHarness(handle, 60_000);

    const result = executeTool(tool, { pid: handle.pid, wait: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(handle.wait).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(4);
    let settled = false;
    void result.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(96);
    const output = await result;
    expect(output).toContain("请扫码完成授权：https://example.test/device-auth");
    expect(output).not.toContain("进程仍在运行");
    expect(handle.kill).not.toHaveBeenCalled();
  });

  it("授权信号出现在 stderr 时也提前返回", async () => {
    vi.useFakeTimers();
    const handle = neverSettlingHandle("starting\n");
    handle.wait = vi.fn((options) => new Promise<CommandResult>(() => {
      setTimeout(() => {
        const chunk = "Scan the QR code: https://example.test/qr-login\n";
        handle.stderr += chunk;
        void options?.onStderr?.(chunk);
      }, 8);
    }));
    const { tool } = createHarness(handle, 60_000);

    const result = executeTool(tool, { pid: handle.pid, wait: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(handle.wait).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(100);
    const output = await result;

    expect(output).toContain("stderr:");
    expect(output).toContain("Scan the QR code: https://example.test/qr-login");
    expect(output).not.toContain("进程仍在运行");
    expect(handle.kill).not.toHaveBeenCalled();
  });

  it("调用 wait 前已有授权信号时立即返回，退出后不再写入旧 writer", async () => {
    let resolveWait: ((result: CommandResult) => void) | undefined;
    const custom = vi.fn(async () => {});
    const handle = neverSettlingHandle(
      "Authorize this login at https://example.test/authorize\n",
    );
    handle.wait = vi.fn(() => new Promise<CommandResult>((resolve) => {
      resolveWait = resolve;
    }));
    const { tool } = createHarness(handle, 60_000);

    const output = await executeTool(tool, { pid: handle.pid, wait: true }, {
      ...toolInvocationOptions,
      agent: { toolCallId: "auth-signal-read" },
      writer: { custom, write: vi.fn() },
    } as never);
    expect(output).toContain("Authorize this login");
    expect(output).not.toContain("进程仍在运行");
    const callsAfterReturn = custom.mock.calls.length;

    handle.exitCode = 3;
    resolveWait?.({
      success: false,
      exitCode: 3,
      stdout: handle.stdout,
      stderr: handle.stderr,
      executionTimeMs: 25,
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(custom).toHaveBeenCalledTimes(callsAfterReturn);
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

    expect(output).toContain("stdout:\nbefore\ndone\n\n\nstderr:\nwarning\n\n\nExit code: 7");
    expect(output).not.toContain("仍在运行");
    // 非零退出是进程自己返回的失败，绝不能被讲成我们的超时。
    expect(output).toContain("后台进程自己运行结束并返回失败（退出码 7）");
    expect(output).not.toContain("系统终止");
    expect(custom).toHaveBeenCalledWith(expect.objectContaining({
      type: "data-sandbox-exit",
      data: expect.objectContaining({
        pid: "short-process",
        exitCode: 7,
        success: false,
        toolCallId: "exit-tool-call",
      }),
    }));
    expect(handle.kill).not.toHaveBeenCalled();
  });

  it("P1 回归:后台进程被 TTL 掐掉时如实说成系统终止，不冒充进程自身失败", async () => {
    const handle: FakeProcessHandle = {
      pid: "ttl-process",
      stdout: "",
      stderr: "",
      exitCode: undefined,
      kill: vi.fn(async () => true),
      wait: vi.fn(async () => {
        handle.exitCode = -1;
        return {
          success: false,
          exitCode: -1,
          stdout: handle.stdout,
          stderr: handle.stderr,
          executionTimeMs: 9,
          timedOut: true,
        };
      }),
    };
    const { tool } = createHarness(handle, 100);

    const output = await executeTool(tool, { pid: handle.pid, wait: true });

    expect(output).toContain("后台进程达到最长运行时限，已被系统终止");
    expect(output).not.toContain("自己运行结束");
  });

  it("pid 不存在时返回 Mastra 原版提示", async () => {
    const { tool } = createHarness(undefined);

    await expect(executeTool(tool, { pid: "missing" }))
      .resolves.toBe("No background process found with PID missing.");
  });

  it.each([
    ["userStop", "用户停止"],
    ["runtimeLimit", "超过运行时限"],
    ["sessionClosed", "会话关闭"],
  ] as const)("pid 不存在但命中 %s 墓碑时返回系统真实死因", async (reason, label) => {
    const state = createSession(`tombstone-${reason}`);
    recordBackgroundCommandTombstone(state, "missing", reason, "2026-07-30T00:00:00.000Z");
    const { tool } = createHarness(undefined, 20, state);

    const output = await executeTool(tool, { pid: "missing" });

    expect(output).toBe(
      `该进程已由系统回收(原因:${label}),不是命令自身失败;` +
        "不要据此推断命令背后的服务或登录态。",
    );
  });

  it("无 wait 观察到已退出进程时也发送带 PID 的退出事件", async () => {
    const custom = vi.fn(async () => {});
    const handle: FakeProcessHandle = {
      pid: "already-exited",
      stdout: "done\n",
      stderr: "",
      exitCode: 0,
      kill: vi.fn(async () => true),
      wait: vi.fn(),
    };
    const { tool } = createHarness(handle);

    await expect(executeTool(tool, { pid: handle.pid }, {
      ...toolInvocationOptions,
      agent: { toolCallId: "poll-exited" },
      writer: { custom, write: vi.fn() },
    } as never)).resolves.toContain("Exit code: 0");
    expect(custom).toHaveBeenCalledWith({
      type: "data-sandbox-exit",
      data: {
        pid: "already-exited",
        exitCode: 0,
        success: true,
        timedOut: false,
        toolCallId: "poll-exited",
      },
    });
  });

  it.each([0, 7])("无输出的已退出进程返回退出码且不再显示仍待输出：exitCode=%s", async (exitCode) => {
    const handle: FakeProcessHandle = {
      pid: `silent-${exitCode}`,
      stdout: "",
      stderr: "",
      exitCode,
      kill: vi.fn(async () => true),
      wait: vi.fn(),
    };
    const { tool } = createHarness(handle);

    await expect(executeTool(tool, { pid: handle.pid })).resolves.toBe(
      `(no output)\n\nExit code: ${exitCode}`,
    );
  });

  it("wait 有界返回后进程才退出时由下次轮询发送退出事件", async () => {
    vi.useFakeTimers();
    let resolveWait: ((result: CommandResult) => void) | undefined;
    const custom = vi.fn(async () => {});
    const handle = neverSettlingHandle("before\n");
    handle.wait = vi.fn(() => new Promise<CommandResult>((resolve) => {
      resolveWait = resolve;
    }));
    const { tool } = createHarness(handle, 10);

    const result = executeTool(tool, { pid: handle.pid, wait: true }, {
      ...toolInvocationOptions,
      agent: { toolCallId: "late-exit-read" },
      writer: { custom, write: vi.fn() },
    } as never);
    await vi.advanceTimersByTimeAsync(10);
    await expect(result).resolves.toContain("进程仍在运行");
    const callsAfterReturn = custom.mock.calls.length;

    handle.exitCode = 3;
    resolveWait?.({
      success: false,
      exitCode: 3,
      stdout: handle.stdout,
      stderr: handle.stderr,
      executionTimeMs: 25,
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(custom).toHaveBeenCalledTimes(callsAfterReturn);

    await expect(executeTool(tool, { pid: handle.pid }, {
      ...toolInvocationOptions,
      agent: { toolCallId: "poll-late-exit" },
      writer: { custom, write: vi.fn() },
    } as never)).resolves.toContain("Exit code: 3");
    expect(custom).toHaveBeenCalledWith({
      type: "data-sandbox-exit",
      data: {
        pid: handle.pid,
        exitCode: 3,
        success: false,
        timedOut: false,
        toolCallId: "poll-late-exit",
      },
    });
  });

  it("首次无 wait 仍在运行，下一次轮询发现已退出时补发退出事件", async () => {
    const custom = vi.fn(async () => {});
    const handle = neverSettlingHandle("working\n");
    const { tool } = createHarness(handle);
    const context = {
      ...toolInvocationOptions,
      agent: { toolCallId: "poll-after-exit" },
      writer: { custom, write: vi.fn() },
    } as never;

    await expect(executeTool(tool, { pid: handle.pid }, context))
      .resolves.toBe("working\n");
    expect(custom).not.toHaveBeenCalledWith(expect.objectContaining({
      type: "data-sandbox-exit",
    }));

    handle.exitCode = 0;
    handle.stdout = "done\n";
    await expect(executeTool(tool, { pid: handle.pid }, context))
      .resolves.toContain("Exit code: 0");
    expect(custom).toHaveBeenCalledWith(expect.objectContaining({
      type: "data-sandbox-exit",
      data: expect.objectContaining({
        pid: handle.pid,
        exitCode: 0,
        success: true,
      }),
    }));
  });

  it("tail 默认 200 行、负数取绝对值且 0 不截断，与 Mastra 原版一致", async () => {
    const allLines = Array.from({ length: 201 }, (_, index) => `line-${index + 1}`).join("\n");
    const handle = neverSettlingHandle(allLines);
    const { tool } = createHarness(handle);

    const defaultTail = await executeTool(tool, { pid: handle.pid });
    expect(defaultTail).toContain("[showing last 200 of 201 lines]");
    expect(defaultTail).toContain("do not rerun the command");
    expect(defaultTail).toContain("it may have side effects");
    expect(defaultTail).not.toContain("line-1\n");
    expect(defaultTail).toContain("line-201");

    const negativeTail = await executeTool(tool, { pid: handle.pid, tail: -2 });
    expect(negativeTail).toBe(
      "[showing last 2 of 201 lines]\n" +
      "[This is the tail of the complete output. To see more, increase tail or use 0 for all output; do not rerun the command to obtain complete output because it may have side effects.]\n" +
      "line-200\nline-201",
    );

    const unlimited = await executeTool(tool, { pid: handle.pid, tail: 0 });
    expect(unlimited).toBe(allLines);

    const untruncated = await executeTool(tool, { pid: handle.pid, tail: 201 });
    expect(untruncated).toBe(allLines);
    expect(untruncated).not.toContain("do not rerun the command");
  });

  it("底层保留上限丢弃前缀时不受 tail=0 影响并显示丢弃字节数", async () => {
    const handle = {
      ...neverSettlingHandle("retained tail\n"),
      stdoutTruncated: true,
      stderrTruncated: true,
      stdoutDroppedBytes: 8_192,
      stderrDroppedBytes: 1_024,
    };
    const { tool } = createHarness(handle);

    const output = await executeTool(tool, { pid: handle.pid, tail: 0 });
    expect(output).toContain("retained tail");
    expect(output).toContain("stdout: 8192 bytes");
    expect(output).toContain("stderr: 1024 bytes");
    expect(output).toContain("permanently dropped");
    expect(output).toContain("do not rerun the command");
  });

  it("保留缓冲区滚动后只按绝对偏移发送新增输出", async () => {
    vi.useFakeTimers();
    const custom = vi.fn(async (_chunk: Record<string, unknown>) => {});
    const handle = {
      ...neverSettlingHandle("abcdefgh"),
      stdoutDroppedBytes: 0,
      stderrDroppedBytes: 0,
    };
    const { tool } = createHarness(handle, 210);

    const result = executeTool(tool, { pid: handle.pid, wait: true }, {
      ...toolInvocationOptions,
      writer: { custom, write: vi.fn() },
    } as never);
    await vi.advanceTimersByTimeAsync(0);
    handle.stdout = "efghIJ";
    handle.stdoutDroppedBytes = 4;
    handle.stdoutTruncated = true;
    await vi.advanceTimersByTimeAsync(100);

    const stdoutDeltas = custom.mock.calls
      .map(([chunk]) => chunk)
      .filter((chunk) => chunk.type === "data-sandbox-stdout")
      .map((chunk) => (chunk.data as { output: string }).output);
    expect(stdoutDeltas).toEqual(["IJ"]);

    await vi.advanceTimersByTimeAsync(110);
    await expect(result).resolves.toContain("进程仍在运行");
    expect(custom.mock.calls.filter(([chunk]) =>
      chunk.type === "data-sandbox-stdout"
    )).toHaveLength(1);
  });

  it("连续有界等待复用单一退出观察且不注册流回调", async () => {
    vi.useFakeTimers();
    const handle = neverSettlingHandle("working\n");
    const { tool } = createHarness(handle, 10);

    const first = executeTool(tool, { pid: handle.pid, wait: true });
    await vi.advanceTimersByTimeAsync(10);
    await expect(first).resolves.toContain("进程仍在运行");

    const second = executeTool(tool, { pid: handle.pid, wait: true });
    await vi.advanceTimersByTimeAsync(10);
    await expect(second).resolves.toContain("进程仍在运行");

    expect(handle.wait).toHaveBeenCalledOnce();
    expect(handle.wait).toHaveBeenCalledWith();
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

  it("abort 立即停止 wait 工具但不 kill 后台进程，迟到 rejection 被收口", async () => {
    let rejectWait: ((reason: unknown) => void) | undefined;
    const handle = neverSettlingHandle();
    handle.wait = vi.fn(() =>
      new Promise<CommandResult>((_resolve, reject) => {
        rejectWait = reject;
      })
    );
    const controller = new AbortController();
    const { tool } = createHarness(handle, 30_000);

    const result = executeTool(tool, { pid: handle.pid, wait: true }, {
      ...toolInvocationOptions,
      abortSignal: controller.signal,
      writer: { custom: vi.fn(async () => {}), write: vi.fn(async () => {}) },
    } as never);
    await vi.waitFor(() => expect(handle.wait).toHaveBeenCalledOnce());

    controller.abort("preemptedByNewMessage");
    await expect(result).rejects.toMatchObject({
      name: "AbortError",
      message: "preemptedByNewMessage",
    });
    expect(handle.kill).not.toHaveBeenCalled();

    rejectWait?.(new Error("late wait failure after abort"));
    await Promise.resolve();
  });

  it.each(["timeout", "abort"] as const)(
    "慢 writer 在 %s 后串行收尾且不再调用旧 writer",
    async (mode) => {
      vi.useFakeTimers();
      let resolveCustom: (() => void) | undefined;
      let activeCustomCalls = 0;
      let maxActiveCustomCalls = 0;
      const custom = vi.fn(async (chunk: Record<string, unknown>) => {
        if (chunk.type !== "data-sandbox-stdout") return;
        activeCustomCalls += 1;
        maxActiveCustomCalls = Math.max(maxActiveCustomCalls, activeCustomCalls);
        await new Promise<void>((resolve) => {
          resolveCustom = resolve;
        });
        activeCustomCalls -= 1;
      });
      const handle = neverSettlingHandle("");
      handle.command = undefined;
      const controller = new AbortController();
      const { tool } = createHarness(handle, 150);
      const result = executeTool(tool, { pid: handle.pid, wait: true }, {
        ...toolInvocationOptions,
        abortSignal: controller.signal,
        writer: { custom, write: vi.fn() },
      } as never);
      const observedResult = result.then(
        (value) => ({ status: "fulfilled" as const, value }),
        (error: unknown) => ({ status: "rejected" as const, error }),
      );

      await vi.advanceTimersByTimeAsync(0);
      handle.stdout = "first";
      await vi.advanceTimersByTimeAsync(100);
      expect(custom).toHaveBeenCalledOnce();
      if (mode === "abort") {
        controller.abort("preemptedByNewMessage");
        await Promise.resolve();
      } else {
        await vi.advanceTimersByTimeAsync(50);
      }

      handle.stdout = "firstsecond";
      await vi.advanceTimersByTimeAsync(500);
      expect(custom).toHaveBeenCalledOnce();
      expect(maxActiveCustomCalls).toBe(1);

      resolveCustom?.();
      await vi.advanceTimersByTimeAsync(0);
      const outcome = await observedResult;
      if (mode === "abort") {
        expect(outcome).toMatchObject({
          status: "rejected",
          error: {
            name: "AbortError",
            message: "preemptedByNewMessage",
          },
        });
      } else {
        expect(outcome).toMatchObject({
          status: "fulfilled",
          value: expect.stringContaining("进程仍在运行"),
        });
      }
      const callsAfterReturn = custom.mock.calls.length;
      await vi.advanceTimersByTimeAsync(500);
      expect(custom).toHaveBeenCalledTimes(callsAfterReturn);
      expect(activeCustomCalls).toBe(0);
    },
  );

  it("有界返回后退出观察不持有流回调或旧 writer", async () => {
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

    expect(callbacks).toBeUndefined();
    const callsAfterReturn = custom.mock.calls.length;
    writerClosed = true;
    rejectWait?.(new Error("late wait failure"));
    await Promise.resolve();
    await Promise.resolve();
    expect(custom).toHaveBeenCalledTimes(callsAfterReturn);
  });
});

/**
 * 扫码登录几乎都跑在「后台起进程 + 轮询输出」这条路上,所以归因必须在轮询回合就生效:
 * 否则模型只看到「还在等」,就会一轮轮重发二维码,而真相是凭据已经拿到、只是存不下去。
 */
describe("轮询回合的凭据归因", () => {
  const KEYCHAIN_LOG = [
    "polling success, token obtained",
    `msg="key access denied" service="AntOAuthSDK" account="htnn-gateway-master-key" reason="denied"`,
  ].join("\n");

  function handleWithOutput(stdout: string, exitCode?: number): FakeProcessHandle {
    return {
      pid: "yuque-login",
      command: "yuque login",
      stdout,
      stderr: "",
      exitCode,
      wait: vi.fn(() => new Promise<CommandResult>(() => {})),
      kill: vi.fn(async () => true),
    };
  }

  it("扫码成功却存不下时,当轮就告诉模型不要再出码", async () => {
    const { tool } = createHarness(handleWithOutput(KEYCHAIN_LOG));
    const output = await executeTool(tool, { pid: "yuque-login" });
    expect(output).toContain("授权/扫码环节已经完成");
    expect(output).toContain("禁止再调用 show_qr");
    expect(output).toContain("立即停止本次登录编排");
  });

  it("同一份输出重复轮询也始终给同一个结论,不会回退成「等用户扫码」", async () => {
    const { tool } = createHarness(handleWithOutput(KEYCHAIN_LOG));
    const first = await executeTool(tool, { pid: "yuque-login" });
    const second = await executeTool(tool, { pid: "yuque-login" });
    expect(second).toBe(first);
    expect(second).not.toContain("请扫描下方的二维码");
  });

  it("正常等待扫码的回合不追加诊断噪音", async () => {
    const { tool } = createHarness(handleWithOutput("waiting for user to scan the QR code"));
    const output = await executeTool(tool, { pid: "yuque-login" });
    expect(output).not.toContain("凭据诊断");
  });

  it("与登录无关的输出一律不追加", async () => {
    const { tool } = createHarness(handleWithOutput("building...\n", 0));
    const output = await executeTool(tool, { pid: "yuque-login" });
    expect(output).not.toContain("凭据诊断");
  });
});
