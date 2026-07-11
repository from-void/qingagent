import { describe, it, expect } from "vitest";
import { RequestContext } from "@mastra/core/request-context";
import { planDraftTool } from "../tools/planDraft.js";

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
// Tests: planDraft tool schema
// ---------------------------------------------------------------------------

describe("planDraft tool schema", () => {
  it("validates a correct planDraft input without purpose", () => {
    const input = {
      id: "direction-gathering",
      rationale: "需要了解写作方向",
      topic: "用户想写一篇关于春天校园生活的文章",
    };

    const result = validateToolInput(planDraftTool, input);
    expect(result.success).toBe(true);
  });

  it("inputSchema 不再向模型暴露 purpose", () => {
    const schema = planDraftTool.inputSchema as unknown as {
      shape: Record<string, unknown>;
    };
    expect(Object.keys(schema.shape)).toEqual(["id", "rationale", "topic"]);
  });

  it("rejects missing required fields", () => {
    expect(validateToolInput(planDraftTool, {}).success).toBe(false);
    expect(
      validateToolInput(planDraftTool, { id: "test" }).success,
    ).toBe(false);
    // missing topic
    expect(
      validateToolInput(planDraftTool, { id: "test", rationale: "r" }).success,
    ).toBe(false);
  });

  it("validates with all required fields", () => {
    const input = {
      id: "test",
      rationale: "testing rationale",
      topic: "detailed topic description with context about what the user wants",
    };

    const result = validateToolInput(planDraftTool, input);
    expect(result.success).toBe(true);
  });

  it("returns semantic suppressed output after planDraft has already completed", async () => {
    const requestContext = new RequestContext([
      ["askUserAlreadyCompleted", true],
    ]);
    const result = await planDraftTool.execute!(
      {
        id: "direction-gathering",
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
    expect(validateToolOutput(planDraftTool, result).success).toBe(true);
  });

  it("suppresses repeated directionChange when no write happened since last completed directionChange", async () => {
    const requestContext = new RequestContext([
      ["askUserAlreadyCompleted", true],
      ["directionChangeAskedSinceLastWrite", true],
    ]);
    const result = await planDraftTool.execute!(
      {
        id: "direction-change-repeat",
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
    expect(validateToolOutput(planDraftTool, result).success).toBe(true);
  });
});
