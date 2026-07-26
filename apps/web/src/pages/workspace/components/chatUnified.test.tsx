// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ToolCallSpec } from "@qingagent/contract-ts";
import { UnifiedToolCall } from "./chatUnified";

let root: Root | null = null;
let host: HTMLDivElement | null = null;

const genericTool = (name: string): ToolCallSpec => ({
  id: `tool-${name}`,
  name,
  render: { kind: "chatInline" },
  status: { kind: "running", data: { progressPct: null, etaSec: null } },
  body: { kind: "generic", data: { argsJson: "" } },
  result: null,
});

async function render(specs: ToolCallSpec[]) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(<>{specs.map((spec) => (
      <UnifiedToolCall
        key={spec.id}
        spec={spec}
      />
    ))}</>);
  });
}

describe("UnifiedToolCall generic placeholder labels", () => {
  afterEach(() => {
    if (root) {
      act(() => root?.unmount());
      root = null;
    }
    host?.remove();
    host = null;
    vi.useRealTimers();
  });

  it("生成期占位 generic body 使用真实工具中文名，不显示匿名兜底", async () => {
    await render([
      genericTool("writeDraft"),
      genericTool("generateSvg"),
      genericTool("show_qr"),
      genericTool("askUser"),
      genericTool("planDraft"),
      genericTool("askUserQuestion"),
      genericTool("create_annotation_groups"),
      genericTool("list_derivatives"),
      genericTool("update_derivative_params"),
      genericTool("style_template_list"),
      genericTool("style_template_get"),
      genericTool("style_template_save"),
      genericTool("style_template_delete"),
    ]);

    const text = host?.textContent ?? "";
    expect(text).toContain("酝酿中…");
    expect(text).toContain("生成配图");
    expect(text).toContain("生成二维码");
    expect(text).toContain("确认方向");
    expect(text).toContain("有问题待确认");
    expect(text).toContain("生成批注");
    expect(text).toContain("列出稿件");
    expect(text).toContain("更新稿件设置");
    expect(text).toContain("列出风格模板");
    expect(text).toContain("读取风格模板");
    expect(text).toContain("保存风格模板");
    expect(text).toContain("删除风格模板");
    expect(text).not.toContain("工具调用");
  });

  it("命令卡以 status 为唯一权威，failed 加载旧 running body 也不再转圈", async () => {
    const contradictory: ToolCallSpec = {
      id: "command-cancelled",
      name: "mastra_workspace_execute_command",
      render: { kind: "chatInline" },
      status: {
        kind: "failed",
        data: { retriable: false, reason: "本轮生成已中断" },
      },
      body: {
        kind: "commandCard",
        data: {
          title: "运行命令",
          icon: "⚙️",
          command: "sleep 20",
          exitCode: 9,
          outputTail: "boom",
          phase: "running",
        },
      },
      result: null,
    };

    await render([contradictory]);

    expect(host?.textContent).toContain("未完成");
    expect(host?.textContent).not.toContain("boom");
    expect(host?.textContent).not.toContain("处理中");
    expect(host?.textContent).not.toContain("退出码");
    expect(host?.textContent).not.toContain("9");
    expect(host?.querySelector(".u-spin")).toBeNull();
  });

  it("所有专用工具卡以 status 终态收敛，不泄露 body 内部错误或保留转圈", async () => {
    const internalError =
      "Rendered page is a hollow shell (nav/share controls only, no substantive article text).";
    const specs: ToolCallSpec[] = [
      {
        id: "research-aborted",
        name: "webSearch",
        render: { kind: "chatInline" },
        status: { kind: "aborted" },
        body: {
          kind: "researchCard",
          data: {
            query: "测试",
            phase: "fetching",
            items: [
              {
                url: "https://example.com",
                title: "来源",
                status: "browser",
                wordCount: null,
              },
            ],
            total: 1,
            fetchedCount: 0,
            okCount: 0,
            skippedCount: 0,
          },
        },
        result: null,
      },
      {
        id: "svg-failed",
        name: "generateSvg",
        render: { kind: "chatInline" },
        status: {
          kind: "failed",
          data: { retriable: false, reason: internalError },
        },
        body: {
          kind: "generateSvg",
          data: {
            prompt: "示意图",
            style: null,
            aspect: null,
            progress: {
              stage: "failed",
              elapsedMs: 10,
              rawKb: 0,
              message: "failed",
              error: internalError,
              src: null,
              width: null,
              height: null,
              partialSvg: null,
            },
          },
        },
        result: null,
      },
      {
        id: "image-failed",
        name: "readImage",
        render: { kind: "chatInline" },
        status: {
          kind: "failed",
          data: { retriable: true, reason: internalError },
        },
        body: {
          kind: "readImageCard",
          data: { prompt: "识别", thumbnailSrc: null, excerpt: internalError },
        },
        result: null,
      },
    ];

    await render(specs);

    expect(host?.textContent).toContain("已中止");
    expect(host?.textContent).toContain("未完成");
    expect(host?.textContent).not.toContain(internalError);
    expect(host?.querySelector(".u-spin")).toBeNull();
    expect(host?.querySelector(".u-dots")).toBeNull();
    expect(host?.querySelector(".is-error")).toBeNull();
  });

  it("通用失败行不把协议 reason 放入正文或 hover title", async () => {
    const reason = "EACCES: permission denied /srv/internal/secret";
    const failed: ToolCallSpec = {
      id: "generic-terminal-failed",
      name: "fetchArticle",
      render: { kind: "chatInline" },
      status: { kind: "failed", data: { retriable: false, reason } },
      body: {
        kind: "generic",
        data: { argsJson: "{\"url\":\"https://example.com\"}" },
      },
      result: { kind: "genericText", data: reason },
    };

    await render([failed]);

    expect(host?.textContent).toContain("未完成");
    expect(host?.textContent).not.toContain(reason);
    expect(host?.querySelector("[title*='permission denied']")).toBeNull();
    expect(host?.querySelector(".is-error")).toBeNull();
  });

  it("后台命令 spawn 成功即显示带 PID 的完成态，不因进程仍运行而转圈", async () => {
    const started: ToolCallSpec = {
      id: "background-started",
      name: "mastra_workspace_execute_command",
      render: { kind: "chatInline" },
      status: { kind: "done" },
      body: {
        kind: "commandCard",
        data: {
          title: "运行命令",
          icon: "⚙️",
          command: "wecom-cli init --noninteractive --no-open",
          exitCode: 0,
          outputTail: "已在后台启动（PID: 4242）",
          phase: "done",
          pid: "4242",
          ownerToolCallId: "background-started",
          background: true,
        },
      },
      result: null,
    };

    await render([started]);

    expect(host?.textContent).toContain("已在后台启动（PID: 4242）");
    expect(host?.textContent).not.toContain("处理中");
    expect(host?.querySelector(".u-spin")).toBeNull();
  });

  it("用户拒绝确认时按 terminalKind 显示已取消且不提供重试", async () => {
    const notStarted: ToolCallSpec = {
      id: "command-not-started",
      name: "mastra_workspace_execute_command",
      render: { kind: "chatInline" },
      status: {
        kind: "failed",
        data: { retriable: false, reason: "已取消，命令未执行" },
      },
      body: {
        kind: "commandCard",
        data: {
          title: "运行命令",
          icon: "⚙️",
          command: "echo safe",
          exitCode: -1,
          outputTail: "已取消，命令未执行",
          phase: "failed",
          terminalKind: "rejected",
        },
      },
      result: null,
    };

    await render([notStarted]);

    expect(host?.textContent).toContain("已取消，命令未执行");
    expect(host?.textContent).not.toContain("重试");
  });

  it("排队命令卡显示已确认进度，running 卡不提供单条停止入口", async () => {
    const commandBody = {
      kind: "commandCard" as const,
      data: {
        title: "安装工具",
        icon: "📦",
        command: "npm install ffmpeg",
        exitCode: 0,
        outputTail: "",
        phase: "running" as const,
        cancellable: true,
      },
    };
    const queued: ToolCallSpec = {
      id: "command-queued",
      name: "mastra_workspace_execute_command",
      render: { kind: "chatInline" },
      status: { kind: "pending" },
      body: commandBody,
      result: null,
    };
    const running: ToolCallSpec = {
      ...queued,
      id: "command-running",
      status: { kind: "running", data: { progressPct: null, etaSec: null } },
    };

    await render([queued, running]);

    expect(host?.textContent).toContain("已确认，排队执行");
    expect(host?.textContent).not.toContain("停止此命令");
    expect(host?.querySelector(".u-command-stop")).toBeNull();
  });

  it("定向停止终态显示中性已中止", async () => {
    const stopped: ToolCallSpec = {
      id: "command-stopped",
      name: "mastra_workspace_execute_command",
      render: { kind: "chatInline" },
      status: { kind: "aborted" },
      body: {
        kind: "commandCard",
        data: {
          title: "安装工具",
          icon: "📦",
          command: "npm install ffmpeg",
          exitCode: 0,
          outputTail: "已中止，结果可能未知",
          phase: "failed",
          terminalKind: "aborted",
        },
      },
      result: null,
    };

    await render([stopped]);

    expect(host?.textContent).toContain("已中止");
    expect(host?.textContent).not.toContain("结果可能未知");
    expect(host?.textContent).not.toContain("停止此命令");
  });

  it.each([
    ["rejected", -1, undefined, "已取消，命令未执行"],
    ["killed", -1, "SIGTERM", "已终止（SIGTERM）"],
    ["aborted", -1, undefined, "已中止"],
    ["failed", 3, undefined, "未完成"],
    ["timedOut", -1, undefined, "已超时"],
    ["succeeded", 0, undefined, "已完成"],
  ] as const)(
    "命令终态 %s 使用结构化真值表展示",
    async (terminalKind, exitCode, signal, expected) => {
      const succeeded = terminalKind === "succeeded";
      const spec: ToolCallSpec = {
        id: `terminal-${terminalKind}`,
        name: "mastra_workspace_execute_command",
        render: { kind: "chatInline" },
        status: succeeded
          ? { kind: "done" }
          : terminalKind === "aborted"
            ? { kind: "aborted" }
          : {
              kind: "failed",
              data: { retriable: false, reason: expected },
            },
        body: {
          kind: "commandCard",
          data: {
            title: "运行命令",
            icon: "⚙️",
            command: "node task.mjs",
            exitCode,
            outputTail: "",
            phase: succeeded ? "done" : "failed",
            terminalKind,
            ...(signal ? { signal } : {}),
          },
        },
        result: null,
      };

      await render([spec]);

      expect(host?.textContent).toContain(expected);
      expect(host?.textContent).not.toContain("permission denied");
      expect(host?.textContent).not.toContain("重试");
      expect(host?.querySelector(".u-spin")).toBeNull();
    },
  );

  it("读取输出急停使用结构化 aborted，不显示操作失败", async () => {
    const readOutput: ToolCallSpec = {
      id: "read-output-aborted",
      name: "mastra_workspace_get_process_output",
      render: { kind: "chatInline" },
      status: { kind: "aborted" },
      body: {
        kind: "generic",
        data: {
          argsJson: "{\"pid\":\"4242\",\"wait\":true}",
          terminalKind: "aborted",
        },
      },
      result: null,
    };

    await render([readOutput]);

    expect(host?.textContent).toContain("已中止");
    expect(host?.textContent).not.toContain("操作失败");
  });

  it("读取输出等待态每秒显示已等待时长，并保留本次检查倒计时", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-24T00:00:00.000Z"));
    const waiting: ToolCallSpec = {
      id: "read-output-waiting",
      name: "mastra_workspace_get_process_output",
      render: { kind: "chatInline" },
      status: { kind: "running", data: { progressPct: null, etaSec: null } },
      body: {
        kind: "generic",
        data: { argsJson: "{\"pid\":\"4242\",\"wait\":true,\"timeout\":60000}" },
      },
      result: null,
    };

    await render([waiting]);
    expect(host?.textContent).toContain("等待输出 · 已等待 0 秒");
    expect(host?.textContent).toContain("60 秒后发起检查");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(42_000);
    });

    expect(host?.textContent).toContain("等待输出 · 已等待 42 秒");
    expect(host?.textContent).toContain("18 秒后发起检查");
  });

  it("读取输出收到 stdout 活动标记时显示仍在输出", async () => {
    vi.useFakeTimers();
    const now = new Date("2026-07-24T00:00:00.000Z");
    vi.setSystemTime(now);
    const active: ToolCallSpec = {
      id: "read-output-active",
      name: "mastra_workspace_get_process_output",
      render: { kind: "chatInline" },
      status: { kind: "running", data: { progressPct: null, etaSec: null } },
      body: {
        kind: "generic",
        data: { argsJson: "{\"pid\":\"4242\",\"wait\":true}" },
      },
      result: {
        kind: "genericText",
        data: JSON.stringify({ outputActivityAt: now.getTime() }),
      },
    };

    await render([active]);
    expect(host?.textContent).toContain("仍在输出 · 已等待 0 秒");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(host?.textContent).toContain("等待输出 · 已等待 5 秒");
  });

  it("有界等待交还后明确显示仍在运行，不与 waiting 或命令终态混淆", async () => {
    const returned: ToolCallSpec = {
      id: "read-output-returned",
      name: "mastra_workspace_get_process_output",
      render: { kind: "chatInline" },
      status: { kind: "done" },
      body: {
        kind: "generic",
        data: { argsJson: "{\"pid\":\"4242\",\"wait\":true}" },
      },
      result: {
        kind: "genericText",
        data: JSON.stringify({ processStillRunning: true }),
      },
    };

    await render([returned]);

    expect(host?.textContent).toContain("本次等待结束，仍在运行");
    expect(host?.textContent).not.toContain("已等待");
    expect(host?.querySelector(".u-spin")).toBeNull();
  });
});
