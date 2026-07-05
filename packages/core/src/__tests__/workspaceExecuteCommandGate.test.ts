import { Agent } from "@mastra/core/agent";
import { RequestContext } from "@mastra/core/request-context";
import { createTool } from "@mastra/core/tools";
import { LocalSandbox, WORKSPACE_TOOLS, Workspace } from "@mastra/core/workspace";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import {
  buildSandboxEnv,
  invalidateSessionWorkspace,
} from "../workspace/sessionWorkspace.js";
import { getQingagentSessionWorkspace, qingagentAgent } from "../agents/qingagent.js";

const toolInvocationOptions = { toolCallId: "tool-call", messages: [] } as never;

describe("workspace execute_command gate placement", () => {
  beforeEach(() => {
    process.env.QINGAGENT_FORCE_SESSION_SANDBOX = "1";
    process.env.QINGAGENT_SANDBOX_ISOLATION = "none";
  });

  afterEach(() => {
    delete process.env.QINGAGENT_FORCE_SESSION_SANDBOX;
    delete process.env.QINGAGENT_SANDBOX_ISOLATION;
    invalidateSessionWorkspace("g2-gate-test");
  });

  it("V1:toolsets 同名工具不会覆盖 Mastra 内置 workspace execute_command", async () => {
    let markerCalled = false;
    const markerTool = createTool({
      id: WORKSPACE_TOOLS.SANDBOX.EXECUTE_COMMAND,
      description: "marker override should lose",
      inputSchema: z.object({ command: z.string() }),
      execute: async () => {
        markerCalled = true;
        return "marker";
      },
    });

    const tmp = mkdtempSync(join(tmpdir(), "mastra-v1-"));
    const workspace = new Workspace({
      sandbox: new LocalSandbox({
        workingDirectory: tmp,
        isolation: "none",
        env: buildSandboxEnv(),
      }),
    });
    const agent = new Agent({
      id: "v1-probe",
      name: "v1-probe",
      instructions: "probe",
      model: "openai/gpt-4o-mini",
      workspace,
    });

    try {
      const tools = await agent.getToolsForExecution({
        requestContext: new RequestContext(),
        toolsets: {
          marker: {
            [WORKSPACE_TOOLS.SANDBOX.EXECUTE_COMMAND]: markerTool,
          },
        },
      });
      const executeCommand = tools[WORKSPACE_TOOLS.SANDBOX.EXECUTE_COMMAND];

      expect(executeCommand?.description).not.toBe("marker override should lose");
      expect(executeCommand?.description).toContain("Execute a shell command");
      const result = await executeCommand!.execute!(
        { command: "printf builtin" },
        toolInvocationOptions,
      );
      expect(markerCalled).toBe(false);
      expect(String(result)).toContain("builtin");
    } finally {
      await workspace.destroy();
    }
  }, 30_000);

  it("G2:qingagent 关闭内置工具后使用 session-scoped gate", async () => {
    const tools = await qingagentAgent.getToolsForExecution({
      requestContext: new RequestContext([["sessionId", "g2-gate-test"]]),
      toolsets: {
        sessionScoped: {
          [WORKSPACE_TOOLS.SANDBOX.EXECUTE_COMMAND]: createTool({
            id: WORKSPACE_TOOLS.SANDBOX.EXECUTE_COMMAND,
            description: "session gated execute command",
            inputSchema: z.object({ command: z.string() }),
            execute: async () => "session-gated-marker",
          }),
        },
      },
    });
    const executeCommand = tools[WORKSPACE_TOOLS.SANDBOX.EXECUTE_COMMAND];

    expect(executeCommand?.description).toBe("session gated execute command");
    await expect(
      executeCommand!.execute!(
        { command: "node /workspace/x.mjs" },
        toolInvocationOptions,
      ),
    ).resolves.toContain("session-gated-marker");
    const workspace = await getQingagentSessionWorkspace("g2-gate-test");
    await workspace.destroy();
    invalidateSessionWorkspace("g2-gate-test");
  });
});
