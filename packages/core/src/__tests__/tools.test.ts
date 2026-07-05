import { describe, it, expect } from "vitest";
import { RequestContext } from "@mastra/core/request-context";
import { askUserTool } from "../tools/askUser.js";

// ---------------------------------------------------------------------------
// Helpers: extract the Zod schema from the Mastra tool and validate.
// Mastra's Tool.inputSchema is typed as optional StandardSchemaWithJSON,
// but our tools always define one. We cast through `unknown` to access
// the underlying Zod .parse() method.
// ---------------------------------------------------------------------------

function validateToolInput(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  toolDef: { inputSchema?: unknown },
  input: unknown,
): { success: boolean; error?: string } {
  const schema = toolDef.inputSchema as { parse: (v: unknown) => unknown } | undefined;
  if (!schema) {
    return { success: false, error: "Tool has no inputSchema" };
  }
  try {
    schema.parse(input);
    return { success: true };
  } catch (e) {
    return {
      success: false,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

function validateToolOutput(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  toolDef: { outputSchema?: unknown },
  output: unknown,
): { success: boolean; error?: string } {
  const schema = toolDef.outputSchema as { parse: (v: unknown) => unknown } | undefined;
  if (!schema) {
    return { success: false, error: "Tool has no outputSchema" };
  }
  try {
    schema.parse(output);
    return { success: true };
  } catch (e) {
    return {
      success: false,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

// ---------------------------------------------------------------------------
// Tests: askUser tool schema
// ---------------------------------------------------------------------------

describe("askUser tool schema", () => {
  it("validates a correct initialBrief askUser input", () => {
    const input = {
      id: "direction-gathering",
      purpose: "initialBrief",
      rationale: "需要了解写作方向",
      topic: "用户想写一篇关于春天校园生活的文章",
    };

    const result = validateToolInput(askUserTool, input);
    expect(result.success).toBe(true);
  });

  it("validates quickClarification and directionChange purposes", () => {
    const base = {
      id: "test",
      rationale: "test",
      topic: "test topic",
    };

    expect(
      validateToolInput(askUserTool, { ...base, purpose: "quickClarification" }).success,
    ).toBe(true);
    expect(
      validateToolInput(askUserTool, { ...base, purpose: "directionChange" }).success,
    ).toBe(true);
  });

  it("rejects invalid purpose", () => {
    const input = {
      id: "test",
      purpose: "fullpage", // 旧 mode 值，现已非法
      rationale: "test",
      topic: "test topic",
    };

    const result = validateToolInput(askUserTool, input);
    expect(result.success).toBe(false);
  });

  it("rejects missing required fields", () => {
    expect(validateToolInput(askUserTool, {}).success).toBe(false);
    expect(
      validateToolInput(askUserTool, { id: "test" }).success,
    ).toBe(false);
    // missing topic
    expect(
      validateToolInput(askUserTool, { id: "test", purpose: "initialBrief", rationale: "r" }).success,
    ).toBe(false);
  });

  it("validates with all required fields", () => {
    const input = {
      id: "test",
      purpose: "initialBrief",
      rationale: "testing rationale",
      topic: "detailed topic description with context about what the user wants",
    };

    const result = validateToolInput(askUserTool, input);
    expect(result.success).toBe(true);
  });

  it("returns semantic suppressed output after askUser has already completed", async () => {
    const requestContext = new RequestContext([
      ["askUserAlreadyCompleted", true],
    ]);
    const result = await askUserTool.execute!(
      {
        id: "direction-gathering",
        purpose: "initialBrief",
        rationale: "需要了解写作方向",
        topic: "用户想写一篇关于春天校园生活的文章",
      },
      { requestContext } as any,
    ) as {
      suppressed: true;
      reason: string;
      instruction: string;
    };

    expect(result.suppressed).toBe(true);
    expect(result.reason).toBe("askUserAlreadyCompleted");
    expect(result.instruction).toContain("writeDraft");
    expect(result.instruction).not.toContain("已弹出表单");
    expect(result.instruction).not.toContain("请填表单");
    expect(validateToolOutput(askUserTool, result).success).toBe(true);
  });

  it("suppresses repeated directionChange when no write happened since last completed directionChange", async () => {
    const requestContext = new RequestContext([
      ["askUserAlreadyCompleted", true],
      ["directionChangeAskedSinceLastWrite", true],
    ]);
    const result = await askUserTool.execute!(
      {
        id: "direction-change-repeat",
        purpose: "directionChange",
        rationale: "模型再次误判要换方向",
        topic: "已有文档方向调整",
      },
      { requestContext } as any,
    ) as {
      suppressed: true;
      reason: string;
      instruction: string;
    };

    expect(result.suppressed).toBe(true);
    expect(result.reason).toBe("askUserAlreadyCompleted");
    expect(validateToolOutput(askUserTool, result).success).toBe(true);
  });
});
