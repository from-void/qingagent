import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(process.cwd(), "../..");
const matrix: Array<{ file: string; callSites: string[] }> = [
  { file: "packages/core/src/bridge/processAgentStream.ts", callSites: ["agent"] },
  { file: "packages/core/src/services/genService.ts", callSites: ["planDraft", "askMore"] },
  { file: "packages/core/src/tools/writeDraft.ts", callSites: ["writeDraft"] },
  { file: "packages/core/src/tools/generateSvg.ts", callSites: ["generateSvg"] },
  { file: "packages/core/src/tools/readImage.ts", callSites: ["readImage"] },
  { file: "packages/core/src/llm/visionTest.ts", callSites: ["visionTest"] },
  { file: "packages/core/src/search/deepseekWebSearch.ts", callSites: ["webSearch"] },
  { file: "packages/core/src/bridge/omSidecar.ts", callSites: ["omObserve", "omReflect"] },
  {
    file: "packages/core/src/agents/processors.ts",
    callSites: ["guardPii", "guardPromptInjection", "guardModeration"],
  },
  { file: "packages/core/src/evals/liveRunner.ts", callSites: ["liveEval"] },
  {
    file: "packages/core/scripts/pm-model-smoke.ts",
    callSites: ["pmModelSmokeStructured", "pmModelSmokeText"],
  },
  {
    file: "packages/core/src/llm/textConnectionTest.ts",
    callSites: ["anthropicConnectionTest"],
  },
];

describe("LLM usage 全调用点覆盖矩阵", () => {
  for (const entry of matrix) {
    it(`${entry.file} 声明 ${entry.callSites.join("/")}`, () => {
      const source = readFileSync(resolve(root, entry.file), "utf8");
      for (const callSite of entry.callSites) expect(source).toContain(`"${callSite}"`);
    });
  }
});
