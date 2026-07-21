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

async function render(
  specs: ToolCallSpec[],
  onStopCommand?: (toolCallId: string) => Promise<void>,
) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(<>{specs.map((spec) => (
      <UnifiedToolCall
        key={spec.id}
        spec={spec}
        onStopCommand={onStopCommand}
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
  });

  it("生成期占位 generic body 使用真实工具中文名,不显示裸工具调用", async () => {
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
          exitCode: 0,
          outputTail: "",
          phase: "running",
        },
      },
      result: null,
    };

    await render([contradictory]);

    expect(host?.textContent).toContain("未完成");
    expect(host?.textContent).not.toContain("处理中");
    expect(host?.querySelector(".u-spin")).toBeNull();
  });

  it("排队命令卡显示已确认进度，running 卡可按 toolCallId 定向停止", async () => {
    const onStopCommand = vi.fn(async () => undefined);
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

    await render([queued, running], onStopCommand);

    expect(host?.textContent).toContain("已确认，排队执行");
    const stopButton = Array.from(host!.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent === "停止此命令")!;
    await act(async () => {
      stopButton.click();
      await Promise.resolve();
    });
    expect(onStopCommand).toHaveBeenCalledWith("command-running");
  });

  it("定向停止终态显示已中止和结果可能未知", async () => {
    const stopped: ToolCallSpec = {
      id: "command-stopped",
      name: "mastra_workspace_execute_command",
      render: { kind: "chatInline" },
      status: {
        kind: "failed",
        data: { retriable: false, reason: "已中止，结果可能未知" },
      },
      body: {
        kind: "commandCard",
        data: {
          title: "安装工具",
          icon: "📦",
          command: "npm install ffmpeg",
          exitCode: 0,
          outputTail: "已中止，结果可能未知",
          phase: "failed",
        },
      },
      result: null,
    };

    await render([stopped], vi.fn(async () => undefined));

    expect(host?.textContent).toContain("已中止 / 结果可能未知");
    expect(host?.textContent).not.toContain("停止此命令");
  });
});
