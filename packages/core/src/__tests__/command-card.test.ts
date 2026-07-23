import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BridgeFrame, ToolCallSpec, CommandCardBody } from "@qingagent/contract-ts";

// 沙箱命令终端卡:execute_command tool-result 定格成 commandCard(友好标题+脱敏输出+退出码)

vi.mock("../mastra.js", () => ({
  mastra: {
    getLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
    getMemory: () => null,
  },
  getObservability: () => null,
}));
vi.mock("../agents/qingagent.js", () => ({
  getQingagentSkills: vi.fn(async () => ({ maybeRefresh: vi.fn(async () => {}), has: vi.fn(async () => false) })),
  qingagentAgent: { stream: vi.fn(), resumeStream: vi.fn() },
}));

async function* streamOf(...chunks: unknown[]): AsyncGenerator<unknown> {
  for (const c of chunks) yield c;
}
async function collect(gen: AsyncGenerator<BridgeFrame>): Promise<BridgeFrame[]> {
  const out: BridgeFrame[] = [];
  for await (const f of gen) out.push(f);
  return out;
}
function specs(frames: BridgeFrame[]): ToolCallSpec[] {
  return frames
    .filter((f) => f.kind === "toolCallUpdated")
    .map((f) => (f.data as unknown as { spec: ToolCallSpec }).spec);
}
function cards(frames: BridgeFrame[]): CommandCardBody[] {
  return specs(frames)
    .filter((s) => s.body.kind === "commandCard")
    .map((s) => (s.body as { data: CommandCardBody }).data);
}
function genericTextResults(frames: BridgeFrame[], toolName: string): string[] {
  return specs(frames)
    .filter((s) => s.name === toolName && s.result?.kind === "genericText")
    .map((s) => (s.result as { data: string }).data);
}

function findSpec(
  state: import("../bridge/index.js").SessionState,
  toolCallId: string,
): ToolCallSpec | null {
  for (const message of state.chatHistory) {
    for (const part of message.parts) {
      if (part.kind === "toolCall" && part.data.id === toolCallId) return part.data;
    }
  }
  return null;
}

describe("沙箱命令终端卡", () => {
  beforeEach(() => vi.clearAllMocks());

  it("execute_command 成功定格 done 卡,计算命令标'运行命令',退出码 0", async () => {
    const { createSession, processAgentStream } = await import("../bridge/index.js");
    const state = createSession("cmd-card");
    const frames = await collect(
      processAgentStream(
        streamOf(
          { type: "tool-call", payload: { toolName: "mastra_workspace_execute_command", toolCallId: "c1", args: { command: "node calc.mjs sum" } } },
          { type: "tool-result", payload: { toolName: "mastra_workspace_execute_command", toolCallId: "c1", args: { command: "node calc.mjs sum" }, result: '{"sum":4545}' } },
        ),
        { state, agentMessageId: "m", streamId: "s", runId: "r" },
      ),
    );
    const cs = cards(frames);
    expect(cs.length).toBeGreaterThanOrEqual(1);
    const final = cs[cs.length - 1]!;
    expect(final.phase).toBe("done");
    expect(final.exitCode).toBe(0);
    expect(final.command).toBe("node calc.mjs sum");
  });

  it("结构化 exit 非零结果定格 failed 卡且原因直接进入主状态", async () => {
    const { createSession, processAgentStream } = await import("../bridge/index.js");
    const state = createSession("cmd-card-nonzero");
    const frames = await collect(
      processAgentStream(
        streamOf(
          {
            type: "tool-call",
            payload: {
              toolName: "mastra_workspace_execute_command",
              toolCallId: "nonzero",
              args: { command: "node fail.mjs" },
            },
          },
          {
            type: "tool-result",
            payload: {
              toolName: "mastra_workspace_execute_command",
              toolCallId: "nonzero",
              args: { command: "node fail.mjs" },
              result: {
                success: false,
                exitCode: 9,
                cancelled: false,
                timedOut: false,
                output: "boom",
              },
            },
          },
        ),
        { state, agentMessageId: "m", streamId: "s-nonzero", runId: "r" },
      ),
    );

    const finalSpec = specs(frames).filter((spec) => spec.id === "nonzero").pop()!;
    const finalCard = cards(frames).pop()!;
    expect(finalSpec.status).toMatchObject({ kind: "failed" });
    expect(finalCard).toMatchObject({ phase: "failed", exitCode: 9, outputTail: "boom" });
  });

  it("Round6 回归:gated 拒绝文本定格为未执行失败卡", async () => {
    const { createSession, processAgentStream } = await import("../bridge/index.js");
    const state = createSession("cmd-card-deny");
    const frames = await collect(
      processAgentStream(
        streamOf(
          {
            type: "tool-call",
            payload: {
              toolName: "mastra_workspace_execute_command",
              toolCallId: "deny1",
              args: { command: "node calc.mjs stats --file ../passwd" },
            },
          },
          {
            type: "tool-result",
            payload: {
              toolName: "mastra_workspace_execute_command",
              toolCallId: "deny1",
              args: { command: "node calc.mjs stats --file ../passwd" },
              result: "命令已被拒绝: --file 只能读取当前会话工作目录内的文件",
            },
          },
        ),
        { state, agentMessageId: "m", streamId: "s-deny", runId: "r" },
      ),
    );

    const finalSpec = specs(frames).filter((s) => s.name === "mastra_workspace_execute_command").pop()!;
    const finalCard = cards(frames).pop()!;
    expect(finalSpec.status.kind).not.toBe("done");
    expect(finalCard.phase).not.toBe("done");
    expect(finalCard.title).toContain("拦截");
    expect(finalCard.outputTail).toContain("命令已被拒绝");
  });

  it("Round6 回归:gated 审批文本定格为未执行失败卡", async () => {
    const { createSession, processAgentStream } = await import("../bridge/index.js");
    const state = createSession("cmd-card-confirm");
    const frames = await collect(
      processAgentStream(
        streamOf(
          {
            type: "tool-call",
            payload: {
              toolName: "mastra_workspace_execute_command",
              toolCallId: "confirm1",
              args: { command: "lark-cli docs +create --title x" },
            },
          },
          {
            type: "tool-result",
            payload: {
              toolName: "mastra_workspace_execute_command",
              toolCallId: "confirm1",
              args: { command: "lark-cli docs +create --title x" },
              result: "命令需要审批: 该外部平台命令不在只读允许清单内",
            },
          },
        ),
        { state, agentMessageId: "m", streamId: "s-confirm", runId: "r" },
      ),
    );

    const finalSpec = specs(frames).filter((s) => s.name === "mastra_workspace_execute_command").pop()!;
    const finalCard = cards(frames).pop()!;
    expect(finalSpec.status.kind).not.toBe("done");
    expect(finalCard.phase).not.toBe("done");
    expect(finalCard.title).toContain("审批");
    expect(finalCard.outputTail).toContain("命令需要审批");
  });

  it("发布命令定格成友好标题'发布到飞书'", async () => {
    const { createSession, processAgentStream } = await import("../bridge/index.js");
    const state = createSession("cmd-card-2");
    const frames = await collect(
      processAgentStream(
        streamOf(
          { type: "tool-call", payload: { toolName: "mastra_workspace_execute_command", toolCallId: "c2", args: { command: "lark-cli docs +create --title x" } } },
          { type: "tool-result", payload: { toolName: "mastra_workspace_execute_command", toolCallId: "c2", args: { command: "lark-cli docs +create --title x" }, result: "ok" } },
        ),
        { state, agentMessageId: "m", streamId: "s2", runId: "r" },
      ),
    );
    expect(cards(frames).pop()!.title).toContain("飞书");
  });

  it("输出里的多 token、Basic 凭证和内嵌 JSON 字段都被脱敏", async () => {
    const { createSession, processAgentStream } = await import("../bridge/index.js");
    const state = createSession("cmd-card-3");
    const frames = await collect(
      processAgentStream(
        streamOf(
          { type: "tool-call", payload: { toolName: "mastra_workspace_execute_command", toolCallId: "c3", args: { command: "node x.mjs" } } },
          {
            type: "tool-result",
            payload: {
              toolName: "mastra_workspace_execute_command",
              toolCallId: "c3",
              args: { command: "node x.mjs" },
              result: {
                stdout:
                  "Authorization: Bearer abc123def456 token: aaaaaa token: LEAKED\n" +
                  "Authorization: Basic dXNlcjpwYXNz\n" +
                  "{\"bearer_token\":\"jsonsecret\"}",
              },
            },
          },
        ),
        { state, agentMessageId: "m", streamId: "s3", runId: "r" },
      ),
    );
    const out = cards(frames).pop()!.outputTail;
    expect(out).not.toContain("abc123def456");
    expect(out).not.toContain("aaaaaa");
    expect(out).not.toContain("LEAKED");
    expect(out).not.toContain("dXNlcjpwYXNz");
    expect(out).not.toContain("jsonsecret");
    expect(out).toContain("***");
  });

  it("命令字段里的 Bearer 凭证被脱敏", async () => {
    const { createSession, processAgentStream } = await import("../bridge/index.js");
    const state = createSession("cmd-card-command-redact");
    const command = "curl -H 'Authorization: Bearer commandsecret123' https://example.com";
    const frames = await collect(
      processAgentStream(
        streamOf(
          {
            type: "tool-call",
            payload: {
              toolName: "mastra_workspace_execute_command",
              toolCallId: "c4",
              args: { command },
            },
          },
          {
            type: "tool-result",
            payload: {
              toolName: "mastra_workspace_execute_command",
              toolCallId: "c4",
              args: { command },
              result: "ok",
            },
          },
        ),
        { state, agentMessageId: "m", streamId: "s4", runId: "r" },
      ),
    );

    const renderedCommand = cards(frames).pop()!.command;
    expect(renderedCommand).not.toContain("commandsecret123");
    expect(renderedCommand).toContain("Bearer ***");
  });

  it("非命令工具结果里的 secret 被脱敏", async () => {
    const { createSession, processAgentStream } = await import("../bridge/index.js");
    const state = createSession("cmd-card-generic-redact");
    const frames = await collect(
      processAgentStream(
        streamOf(
          {
            type: "tool-call",
            payload: { toolName: "run_js", toolCallId: "w1", args: { code: "1+1" } },
          },
          {
            type: "tool-result",
            payload: {
              toolName: "run_js",
              toolCallId: "w1",
              args: { code: "1+1" },
              result: {
                ok: true,
                debug: "secret: noncommandsecret123",
              },
            },
          },
        ),
        { state, agentMessageId: "m", streamId: "s5", runId: "r" },
      ),
    );

    const result = genericTextResults(frames, "run_js").pop()!;
    expect(result).not.toContain("noncommandsecret123");
    expect(result).toContain("***");
  });

  it("工具返回 [Error] 文本但已有结果时,通用工具卡仍按完成收口", async () => {
    const { createSession, processAgentStream } = await import("../bridge/index.js");
    const state = createSession("tool-error-text-done");
    const frames = await collect(
      processAgentStream(
        streamOf(
          {
            type: "tool-call",
            payload: {
              toolName: "mastra_workspace_read_file",
              toolCallId: "read-error-text",
              args: { path: "/work/missing.md" },
            },
          },
          {
            type: "tool-result",
            payload: {
              toolName: "mastra_workspace_read_file",
              toolCallId: "read-error-text",
              args: { path: "/work/missing.md" },
              result: { text: "[Error] file not found" },
            },
          },
        ),
        { state, agentMessageId: "m", streamId: "s-error-text", runId: "r" },
      ),
    );

    const finalSpec = specs(frames).filter((s) => s.name === "mastra_workspace_read_file").pop()!;
    expect(finalSpec.status.kind).toBe("done");
    expect(finalSpec.result?.kind).toBe("genericText");
    if (finalSpec.result?.kind === "genericText") {
      expect(finalSpec.result.data).toContain("[Error] file not found");
    }
  });

  it.each([
    ["正常退出", 0, true, "done", "succeeded"],
    ["非零退出", 3, false, "failed", "failed"],
  ] as const)(
    "后台启动卡按 PID 收口%s，读取输出结果不覆盖 owner",
    async (_label, exitCode, success, statusKind, terminalKind) => {
      const {
        createSession,
        processAgentStream,
      } = await import("../bridge/index.js");
      const state = createSession(`background-settle-${exitCode}`);
      const frames = await collect(processAgentStream(
        streamOf(
          {
            type: "tool-call",
            payload: {
              toolName: "mastra_workspace_execute_command",
              toolCallId: "background-owner",
              args: { command: "node background.mjs", background: true },
            },
          },
          {
            type: "tool-result",
            payload: {
              toolName: "mastra_workspace_execute_command",
              toolCallId: "background-owner",
              args: { command: "node background.mjs", background: true },
              result: {
                success: true,
                exitCode: 0,
                cancelled: false,
                timedOut: false,
                background: true,
                pid: "4242",
                output: "Started background process (PID: 4242)",
              },
            },
          },
          {
            type: "tool-call",
            payload: {
              toolName: "mastra_workspace_get_process_output",
              toolCallId: "read-output",
              args: { pid: "4242", wait: true },
            },
          },
          {
            type: "tool-output",
            payload: {
              toolName: "mastra_workspace_get_process_output",
              toolCallId: "read-output",
              output: {
                type: "data-sandbox-exit",
                data: { pid: "4242", exitCode, success, timedOut: false },
              },
            },
          },
          {
            type: "tool-result",
            payload: {
              toolName: "mastra_workspace_get_process_output",
              toolCallId: "read-output",
              args: { pid: "4242", wait: true },
              result: `Exit code: ${exitCode}`,
            },
          },
        ),
        {
          state,
          agentMessageId: "agent-background",
          streamId: `stream-background-${exitCode}`,
          runId: "run-background",
        },
      ));

      const owner = findSpec(state, "background-owner");
      expect(owner?.status.kind).toBe(statusKind);
      expect(owner?.body).toMatchObject({
        kind: "commandCard",
        data: {
          pid: "4242",
          ownerToolCallId: "background-owner",
          background: true,
          exitCode,
          terminalKind,
        },
      });
      expect(findSpec(state, "read-output")?.status.kind).toBe("done");
      expect(specs(frames).filter((spec) => spec.id === "background-owner").at(-1))
        .toMatchObject({ status: { kind: statusKind } });
    },
  );

  it("kill 按 PID 收口 owner 为 killed，迟到退出事件不能覆盖终态", async () => {
    const { createSession, processAgentStream } = await import("../bridge/index.js");
    const state = createSession("background-killed");
    await collect(processAgentStream(
      streamOf(
        {
          type: "tool-call",
          payload: {
            toolName: "mastra_workspace_execute_command",
            toolCallId: "kill-owner",
            args: { command: "sleep 300", background: true },
          },
        },
        {
          type: "tool-result",
          payload: {
            toolName: "mastra_workspace_execute_command",
            toolCallId: "kill-owner",
            args: { command: "sleep 300", background: true },
            result: {
              success: true,
              exitCode: 0,
              cancelled: false,
              timedOut: false,
              background: true,
              pid: "5252",
              output: "Started background process (PID: 5252)",
            },
          },
        },
        {
          type: "tool-call",
          payload: {
            toolName: "mastra_workspace_kill_process",
            toolCallId: "kill-call",
            args: { pid: "5252" },
          },
        },
        {
          type: "tool-output",
          payload: {
            toolName: "mastra_workspace_kill_process",
            toolCallId: "kill-call",
            output: {
              type: "data-sandbox-exit",
              data: {
                exitCode: 137,
                success: false,
                killed: true,
                toolCallId: "kill-call",
              },
            },
          },
        },
        {
          type: "tool-result",
          payload: {
            toolName: "mastra_workspace_kill_process",
            toolCallId: "kill-call",
            args: { pid: "5252" },
            result: "Process 5252 has been killed.",
          },
        },
        {
          type: "tool-output",
          payload: {
            toolName: "mastra_workspace_get_process_output",
            toolCallId: "late-read",
            output: {
              type: "data-sandbox-exit",
              data: { pid: "5252", exitCode: 143, success: false },
            },
          },
        },
      ),
      {
        state,
        agentMessageId: "agent-kill",
        streamId: "stream-kill",
        runId: "run-kill",
      },
    ));

    const owner = findSpec(state, "kill-owner");
    expect(owner?.status).toEqual({
      kind: "failed",
      data: { retriable: false, reason: "已终止（SIGTERM）" },
    });
    expect(owner?.body).toMatchObject({
      kind: "commandCard",
      data: {
        terminalKind: "killed",
        signal: "SIGTERM",
        pid: "5252",
      },
    });
  });

  it("native kill 报告未找到进程时不把 owner 误标为 killed", async () => {
    const { createSession, processAgentStream } = await import("../bridge/index.js");
    const state = createSession("background-kill-miss");
    await collect(processAgentStream(
      streamOf(
        {
          type: "tool-call",
          payload: {
            toolName: "mastra_workspace_execute_command",
            toolCallId: "kill-miss-owner",
            args: { command: "sleep 300", background: true },
          },
        },
        {
          type: "tool-result",
          payload: {
            toolName: "mastra_workspace_execute_command",
            toolCallId: "kill-miss-owner",
            args: { command: "sleep 300", background: true },
            result: {
              success: true,
              exitCode: 0,
              background: true,
              pid: "5353",
              output: "Started background process (PID: 5353)",
            },
          },
        },
        {
          type: "tool-call",
          payload: {
            toolName: "mastra_workspace_kill_process",
            toolCallId: "kill-miss-call",
            args: { pid: "5353" },
          },
        },
        {
          type: "tool-output",
          payload: {
            toolName: "mastra_workspace_kill_process",
            toolCallId: "kill-miss-call",
            output: {
              type: "data-sandbox-exit",
              data: {
                exitCode: -1,
                success: false,
                killed: false,
                toolCallId: "kill-miss-call",
              },
            },
          },
        },
        {
          type: "tool-result",
          payload: {
            toolName: "mastra_workspace_kill_process",
            toolCallId: "kill-miss-call",
            args: { pid: "5353" },
            result: "Process 5353 was not found or had already exited.",
          },
        },
      ),
      {
        state,
        agentMessageId: "agent-kill-miss",
        streamId: "stream-kill-miss",
        runId: "run-kill-miss",
      },
    ));

    expect(findSpec(state, "kill-miss-owner")).toMatchObject({
      status: { kind: "running" },
      body: {
        kind: "commandCard",
        data: {
          pid: "5353",
        },
      },
    });
    const owner = findSpec(state, "kill-miss-owner");
    expect(owner?.body.kind === "commandCard" ? owner.body.data.terminalKind : null)
      .toBeUndefined();
  });

  it("后台进程卡跨轮次保持 running，不被 lingering 清理误改", async () => {
    const {
      createSession,
      finalizeLingeringRunningToolCalls,
      processAgentStream,
    } = await import("../bridge/index.js");
    const state = createSession("background-cross-turn");
    await collect(processAgentStream(
      streamOf(
        {
          type: "tool-call",
          payload: {
            toolName: "mastra_workspace_execute_command",
            toolCallId: "cross-turn-owner",
            args: { command: "sleep 90", background: true },
          },
        },
        {
          type: "tool-result",
          payload: {
            toolName: "mastra_workspace_execute_command",
            toolCallId: "cross-turn-owner",
            args: { command: "sleep 90", background: true },
            result: {
              success: true,
              exitCode: 0,
              cancelled: false,
              timedOut: false,
              background: true,
              pid: "6262",
              output: "Started background process (PID: 6262)",
            },
          },
        },
      ),
      {
        state,
        agentMessageId: "agent-cross-turn",
        streamId: "stream-cross-turn",
        runId: "run-cross-turn",
      },
    ));

    expect(finalizeLingeringRunningToolCalls(state)).toEqual([]);
    expect(findSpec(state, "cross-turn-owner")).toMatchObject({
      status: { kind: "running" },
      body: {
        kind: "commandCard",
        data: {
          pid: "6262",
          ownerToolCallId: "cross-turn-owner",
          background: true,
          phase: "running",
        },
      },
    });
  });
});
