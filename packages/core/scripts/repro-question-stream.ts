import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const outputDir = resolve(
  process.env.QUESTION_STREAM_EVAL_DIR ??
    "/home/jimmy/proj/qingagent-ops/evals/260712-branchcall",
);
await mkdir(outputDir, { recursive: true });
process.loadEnvFile(resolve("../server/.env"));

const { generateQuestions } = await import("../src/services/genService.js");
const startedAt = performance.now();
const frames: Array<{
  atMs: number;
  questions: Array<{ id: string; label: string; optionCount: number }>;
}> = [];

const result = await generateQuestions({
  mode: "initial",
  rationale: "为技术团队写一篇介绍流式交互体验的文章，需要确认受众、语气和案例侧重点。",
  topic: "流式交互设计",
  onProgress: (questions) => {
    frames.push({
      atMs: Math.round(performance.now() - startedAt),
      questions: questions.map((question) => ({
        id: question.id,
        label: question.label,
        optionCount: question.options.length,
      })),
    });
  },
});

const artifact = {
  generatedAt: new Date().toISOString(),
  elapsedMs: Math.round(performance.now() - startedAt),
  transport: result.transport,
  branchFailure: result.branchFailure,
  frames,
  finalQuestions: result.questions,
};
const outputPath = resolve(outputDir, "question-stream-repro.json");
await writeFile(outputPath, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ outputPath, ...artifact }, null, 2));
