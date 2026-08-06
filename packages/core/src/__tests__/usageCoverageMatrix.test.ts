import { readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(process.cwd(), "../..");

function sourceFiles(directory: string): string[] {
  const files: string[] = [];
  const visit = (current: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (
        entry.isFile() &&
        path.endsWith(".ts") &&
        !path.includes("__tests__") &&
        !path.endsWith(".test.ts")
      ) {
        files.push(path);
      }
    }
  };
  visit(resolve(root, directory));
  return files;
}

describe("LLM usage provider 边界覆盖", () => {
  it("只有统一终态记录器可以直接写 usage 账本", () => {
    const writers = sourceFiles("packages/core/src")
      .filter((file) => readFileSync(file, "utf8").includes("recordUsageEvent"))
      .map((file) => relative(root, file).replace(/\\/g, "/"));
    expect(writers).toEqual(["packages/core/src/llm/usageMiddleware.ts"]);
  });

  it("三类模型传输都委托统一终态记录器", () => {
    const middleware = readFileSync(
      resolve(root, "packages/core/src/llm/usageMiddleware.ts"),
      "utf8",
    );
    const modern = readFileSync(
      resolve(root, "packages/core/src/llm/modernUsageModel.ts"),
      "utf8",
    );
    const branch = readFileSync(
      resolve(root, "packages/core/src/llm/modelConfig.ts"),
      "utf8",
    );
    const manual = readFileSync(
      resolve(root, "packages/core/src/search/deepseekWebSearch.ts"),
      "utf8",
    );

    expect(middleware).toContain("recordModelCallOutcome({");
    expect(modern).toContain("recordModelCallOutcome({");
    expect(branch).toContain("recordModelCallOutcome({");
    expect(manual).toContain("recordModelCallOutcome({");
  });

  it("主动中止的主链、分支与联网搜索只提交估算素材，不绕过统一账本", () => {
    const middleware = readFileSync(
      resolve(root, "packages/core/src/llm/usageMiddleware.ts"),
      "utf8",
    );
    const modern = readFileSync(
      resolve(root, "packages/core/src/llm/modernUsageModel.ts"),
      "utf8",
    );
    const branch = readFileSync(
      resolve(root, "packages/core/src/llm/modelConfig.ts"),
      "utf8",
    );
    const manual = readFileSync(
      resolve(root, "packages/core/src/search/deepseekWebSearch.ts"),
      "utf8",
    );

    expect(middleware).toMatch(
      /usageState\s*=\s*recorded\s*\?\s*"recorded"\s*:\s*estimated\s*\?\s*"estimated"/,
    );
    expect(middleware).toContain("usageEstimate,");
    expect(modern).toContain("usageEstimate,");
    expect(branch).toContain("usageEstimate,");
    expect(manual).toContain("usageEstimate,");
    expect(modern).not.toContain("recordUsageEvent");
    expect(branch).not.toContain("recordUsageEvent");
    expect(manual).not.toContain("recordUsageEvent");
  });

  it("主 Agent 的 OpenAI/Anthropic 两条模型路径都始终套 provider wrapper", () => {
    const source = readFileSync(
      resolve(root, "packages/core/src/agents/qingagent.ts"),
      "utf8",
    );
    expect(source.match(/return trackQingagentModel\(/g)).toHaveLength(2);
    expect(source).toContain("return wrapModernModelUsage(model");
    expect(source).not.toContain("maybeTrackNonBridgeModel");
  });

  it("step-finish 只保留 Mastra span，不直接写 usage", () => {
    const source = readFileSync(
      resolve(root, "packages/core/src/agent-run/agentStreamLifecycle.ts"),
      "utf8",
    );
    expect(source).toContain("recordLlmStepResponseSpan(");
    expect(source).not.toContain("recordUsageEvent");
  });

  it("同一业务动作的 branch/fallback site 不漂移", () => {
    const draftTemplate = readFileSync(
      resolve(root, "packages/core/src/session/draftTemplate.ts"),
      "utf8",
    );
    expect(draftTemplate.match(/callSite: "draftTemplate"/g)).toHaveLength(2);
    expect(draftTemplate).not.toContain("draftTemplateFallback");
  });
});
