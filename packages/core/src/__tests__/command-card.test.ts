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
});
