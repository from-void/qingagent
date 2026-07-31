import type { BridgeFrame } from "@qingagent/contract-ts";
import type { ConfirmGrantState } from "@qingagent/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { processAgentStream } from "../agent-run/processAgentStream.js";
import { resumeConfirmDecision } from "../agent-run/confirmResume.js";
import { buildCommandConfirmSpec } from "../confirm/commandConfirmation.js";
import {
  connectAccountConfirmationDigest,
  FEISHU_AUTH_START_TOOL,
  GITHUB_AUTH_START_TOOL,
  parseConnectAccountAuthInput,
  WECHAT_AUTH_START_TOOL,
} from "../confirm/connectAccountConfirmation.js";
import { ConfirmService } from "../confirm/confirmService.js";
import {
  __resetBypassModeForTest,
  __setBypassModeCacheForTest,
} from "../security/bypassMode.js";
import { createSession } from "../session/sessionState.js";
import { feishuAuthStartTool } from "../tools/feishuAuthStart.js";
import { githubAuthStartTool } from "../tools/githubAuthStart.js";
import { wechatAuthStartTool } from "../tools/wechatAuth.js";
import { evaluateCommandPolicy } from "../workspace/commandPolicy.js";

async function* events(...items: unknown[]): AsyncGenerator<unknown> {
  for (const item of items) yield item;
}

async function collect(
  generator: AsyncGenerator<BridgeFrame>,
): Promise<BridgeFrame[]> {
  const frames: BridgeFrame[] = [];
  for await (const frame of generator) frames.push(frame);
  return frames;
}

function grantState(
  present: boolean,
): ConfirmGrantState {
  return {
    kind: "connect",
    present,
    grantId: present ? "grant-connect" : null,
    version: present ? 1 : 0,
    revocationEpoch: 0,
    grant: present
      ? {
          grantId: "grant-connect",
          kind: "connect",
          createdAt: "2026-07-30T00:00:00.000Z",
          source: "settings",
        }
      : null,
  };
}

const connectorCases = [
  {
    toolName: GITHUB_AUTH_START_TOOL,
    args: { scope: "repo" },
    tool: githubAuthStartTool,
    title: "连接 GitHub",
    commandPreview: 'github_auth_start({"scope":"repo"})',
  },
  {
    toolName: FEISHU_AUTH_START_TOOL,
    args: { domains: ["docs"] },
    tool: feishuAuthStartTool,
    title: "扫码授权飞书",
    commandPreview: 'feishu_auth_start({"domains":["docs"]})',
  },
  {
    toolName: WECHAT_AUTH_START_TOOL,
    args: {},
    tool: wechatAuthStartTool,
    title: "扫码登录微信公众平台",
    commandPreview: "wechat_auth_start({})",
  },
] as const;

describe("连接账号确认门禁", () => {
  beforeEach(() => __resetBypassModeForTest());
  afterEach(() => __resetBypassModeForTest());

  function requiresApproval(
    tool: { requireApproval?: unknown },
    args: unknown,
  ): unknown {
    const predicate = tool.requireApproval;
    return typeof predicate === "function"
      ? (predicate as (input: unknown) => unknown)(args)
      : predicate;
  }

  it.each(connectorCases)(
    "$toolName 在授权启动前声明 Mastra pre-execution approval",
    ({ tool, args }) => {
      expect(requiresApproval(tool, args)).toBe(true);
    },
  );

  it.each(connectorCases)(
    "$toolName 在总开关=不再询问时不要求 pre-execution approval",
    ({ tool, args }) => {
      __setBypassModeCacheForTest(true);
      expect(requiresApproval(tool, args)).toBe(false);
    },
  );

  it.each(connectorCases)(
    "$toolName 在连接账号=每次询问时先发 connect 确认卡",
    async ({ toolName, args, title, commandPreview }) => {
      const state = createSession(`connect-ask-${toolName}`);
      const service = new ConfirmService({
        createId: () => `confirm-${toolName}`,
        persist: async () => undefined,
        loadGrantState: async () => grantState(false),
        appendAudit: async () => undefined,
      });

      const result = await service.requestCommandConfirm({
        state,
        runId: `run-${toolName}`,
        toolCallId: `tool-${toolName}`,
        toolName,
        args,
        aborted: false,
      });

      expect(result).toMatchObject({
        ok: true,
        frame: {
          kind: "confirmRequested",
          data: {
            toolCallId: `tool-${toolName}`,
            spec: {
              kind: "connect",
              title,
              commandPreview,
              rememberCategory: { kind: "connect", label: "连接账号" },
              secondaryLabel: "取消",
            },
          },
        },
      });
      if (!result.ok) return;
      expect(result.storedGrantApproval).toBeUndefined();
    },
  );

  it.each(connectorCases)(
    "$toolName 在连接账号=不再询问时不发确认卡并按存量授权放行",
    async ({ toolName, args }) => {
      const state = createSession(`connect-always-${toolName}`);
      const service = new ConfirmService({
        createId: () => `confirm-${toolName}`,
        persist: async () => undefined,
        loadGrantState: async () => grantState(true),
        appendAudit: async () => undefined,
      });

      const result = await service.requestCommandConfirm({
        state,
        runId: `run-${toolName}`,
        toolCallId: `tool-${toolName}`,
        toolName,
        args,
        aborted: false,
      });

      expect(result).toMatchObject({
        ok: true,
        storedGrantApproval: {
          grant: { grantId: "grant-connect", kind: "connect" },
        },
      });
      if (!result.ok) return;
      expect(result.frame).toBeUndefined();
    },
  );

  it.each([
    [GITHUB_AUTH_START_TOOL, { scope: "repo", unexpected: true }],
    [FEISHU_AUTH_START_TOOL, { domains: [] }],
    [WECHAT_AUTH_START_TOOL, { unexpected: true }],
    [GITHUB_AUTH_START_TOOL, null],
  ])("%s 的脏参数 fail-closed，不生成确认请求", async (toolName, args) => {
    expect(parseConnectAccountAuthInput(toolName, args)).toBeNull();
    const state = createSession(`connect-invalid-${toolName}`);
    const service = new ConfirmService({
      persist: async () => undefined,
      loadGrantState: async () => grantState(false),
      appendAudit: async () => undefined,
    });

    await expect(service.requestCommandConfirm({
      state,
      runId: `run-invalid-${toolName}`,
      toolCallId: `tool-invalid-${toolName}`,
      toolName,
      args,
      aborted: false,
    })).resolves.toEqual({ ok: false, reason: "确认请求参数无效" });
    expect(state.pendingConfirms.size).toBe(0);
  });

  it("连接确认摘要绑定会话、工具名和规范化参数", () => {
    const github = parseConnectAccountAuthInput(
      GITHUB_AUTH_START_TOOL,
      { scope: "repo" },
    );
    const publicGithub = parseConnectAccountAuthInput(
      GITHUB_AUTH_START_TOOL,
      { scope: "public_repo" },
    );
    const wechat = parseConnectAccountAuthInput(WECHAT_AUTH_START_TOOL, {});
    expect(github && publicGithub && wechat).toBeTruthy();
    if (!github || !publicGithub || !wechat) return;

    const digest = connectAccountConfirmationDigest("session-a", github);
    expect(connectAccountConfirmationDigest("session-a", publicGithub)).not.toBe(digest);
    expect(connectAccountConfirmationDigest("session-a", wechat)).not.toBe(digest);
    expect(connectAccountConfirmationDigest("session-b", github)).not.toBe(digest);
  });

  it("飞书连接确认摘要忽略 domains 顺序且不修改原始参数", () => {
    const docsBase = parseConnectAccountAuthInput(
      FEISHU_AUTH_START_TOOL,
      { domains: ["docs", "base"] },
    );
    const baseDocs = parseConnectAccountAuthInput(
      FEISHU_AUTH_START_TOOL,
      { domains: ["base", "docs"] },
    );
    expect(docsBase && baseDocs).toBeTruthy();
    if (!docsBase || !baseDocs) return;
    expect(docsBase.toolName).toBe(FEISHU_AUTH_START_TOOL);
    expect(baseDocs.toolName).toBe(FEISHU_AUTH_START_TOOL);
    if (
      docsBase.toolName !== FEISHU_AUTH_START_TOOL ||
      baseDocs.toolName !== FEISHU_AUTH_START_TOOL
    ) return;

    expect(connectAccountConfirmationDigest("session-a", docsBase)).toBe(
      connectAccountConfirmationDigest("session-a", baseDocs),
    );
    expect(docsBase.args.domains).toEqual(["docs", "base"]);
    expect(baseDocs.args.domains).toEqual(["base", "docs"]);
  });

  it("GitHub 取消确认只走 decline，不生成配对码或授权卡", async () => {
    const state = createSession("connect-github-reject");
    const service = new ConfirmService({
      createId: () => "confirm-github-reject",
      persist: async () => undefined,
      loadGrantState: async () => grantState(false),
      appendAudit: async () => undefined,
    });
    const initialFrames = await collect(processAgentStream(
      events({
        type: "tool-call-approval",
        runId: "run-github-reject",
        payload: {
          toolCallId: "tool-github-reject",
          toolName: GITHUB_AUTH_START_TOOL,
          args: { scope: "repo" },
        },
      }),
      {
        state,
        agentMessageId: "agent-github-reject",
        streamId: "stream-github-reject",
        runId: "run-github-reject",
        confirmService: service,
      },
    ));
    const pending = state.pendingConfirms.get("tool-github-reject");
    expect(pending).toBeDefined();
    if (!pending) return;

    const agent = {
      approveToolCall: vi.fn(),
      declineToolCall: vi.fn(async () => ({
        runId: pending.runId,
        fullStream: events({
          type: "tool-result",
          payload: {
            toolName: GITHUB_AUTH_START_TOOL,
            toolCallId: pending.toolCallId,
            args: { scope: "repo" },
            result: "Tool call declined",
          },
        }),
      })),
    };
    const resumedFrames = await collect(resumeConfirmDecision({
      session: state,
      pending,
      decisionId: "decision-github-reject",
      accepted: false,
      resolution: "rejected",
      service,
      agent: agent as never,
    }));

    expect(agent.approveToolCall).not.toHaveBeenCalled();
    expect(agent.declineToolCall).toHaveBeenCalledTimes(1);
    const visible = JSON.stringify([
      ...initialFrames,
      ...resumedFrames,
      state.chatHistory,
    ]);
    expect(visible).not.toContain('"kind":"qrCard"');
    expect(visible).not.toContain("user_code");
    expect(visible).not.toContain("verification_uri");
    expect(state.pendingConfirms.size).toBe(0);
  });

  it("只读普通命令仍按 allow 处理，不进入确认分类", () => {
    expect(evaluateCommandPolicy("pwd", { workspaceCwd: "/tmp" }))
      .toEqual({ action: "allow" });
  });

  it("删除、外发、安装三类确认卡的既有分类与按钮文案不变", () => {
    const destructive = buildCommandConfirmSpec(
      { command: "rm old.txt" },
      "将删除文件",
      "regression-command",
    );
    const send = buildCommandConfirmSpec(
      { command: "git push origin main" },
      "将推送代码",
      "regression-send",
    );
    const install = buildCommandConfirmSpec(
      { command: "npm install zod" },
      "将改动这台电脑上的软件或设置",
      "regression-install",
    );

    expect([
      {
        kind: destructive.kind,
        title: destructive.title,
        primaryLabel: destructive.primaryLabel,
        secondaryLabel: destructive.secondaryLabel,
      },
      {
        kind: send.kind,
        title: send.title,
        primaryLabel: send.primaryLabel,
        secondaryLabel: send.secondaryLabel,
      },
      {
        kind: install.kind,
        title: install.title,
        primaryLabel: install.primaryLabel,
        secondaryLabel: install.secondaryLabel,
      },
    ]).toEqual([
      {
        kind: "command",
        title: "删除文件",
        primaryLabel: "确认执行",
        secondaryLabel: "取消",
      },
      {
        kind: "send",
        title: "推送代码到远端",
        primaryLabel: "确认发布",
        secondaryLabel: "取消",
      },
      {
        kind: "install",
        title: "安装 zod",
        primaryLabel: "确认安装",
        secondaryLabel: "取消",
      },
    ]);
  });
});
