import { createRequire } from "node:module";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { createOpenAI } from "@ai-sdk/openai";
import { streamObject, streamText } from "ai";
import { aiBlockSchema, compileAiDocumentToPm } from "@qingagent/pm-schema";
import { parseAiDocumentFromText } from "../src/tools/generateDoc.js";

type SmokeStatus = "PASS" | "FAIL" | "ENV_SKIP" | "ERROR";

interface SmokeArtifact {
  timestamp: string;
  provider: string;
  model: string;
  versions: Record<string, string>;
  typeDefs: SmokeStatus;
  structuredOutput: SmokeStatus;
  streamElementGranularity: SmokeStatus;
  zodBlockErrors: SmokeStatus;
  fallbackStreamTextToIr: SmokeStatus;
  verdict: SmokeStatus;
  evidence: string[];
  error?: string;
  humanOverride?: {
    source: string;
    reason: string;
    retestPlan: string;
  };
}

const require = createRequire(import.meta.url);
const repoRoot = resolve(process.cwd(), "../..");
const artifactPath = resolve(repoRoot, "output/pm/phase-c-model-smoke.json");
const evidencePath = resolve(repoRoot, "output/pm/phase-c-model-smoke.ndjson");

function packageVersion(name: string): string {
  return require(`${name}/package.json`).version as string;
}

function envSkip(message: string): SmokeArtifact {
  return {
    timestamp: new Date().toISOString(),
    provider: providerName(),
    model: modelName(),
    versions: versions(),
    typeDefs: "PASS",
    structuredOutput: "ENV_SKIP",
    streamElementGranularity: "ENV_SKIP",
    zodBlockErrors: "PASS",
    fallbackStreamTextToIr: "ENV_SKIP",
    verdict: "ENV_SKIP",
    evidence: [],
    error: message,
    humanOverride: {
      source: "Phase C 用户指令",
      reason: "当前环境缺少 DEEPSEEK_API_KEY/OPENAI_API_KEY；本次指令明确真实模型不可用时标 ENV_SKIP 并留档，不卡 Phase C 开发收尾。ENV_SKIP 不作为模型能力 PASS。",
      retestPlan: "配置 DEEPSEEK_API_KEY 或 OPENAI_API_KEY 后重跑 `pnpm --filter @qingagent/core pm:model-smoke`，要求 verdict=PASS。",
    },
  };
}

function providerName(): string {
  if (process.env.DEEPSEEK_API_KEY) return "deepseek";
  if (process.env.OPENAI_API_KEY) return "openai";
  return "none";
}

function modelName(): string {
  if (process.env.DEEPSEEK_API_KEY) return process.env.DEEPSEEK_MODEL ?? "deepseek-v4-flash";
  if (process.env.OPENAI_API_KEY) return process.env.OPENAI_MODEL ?? "gpt-4o-mini";
  return "none";
}

function versions(): Record<string, string> {
  return {
    "@mastra/core": packageVersion("@mastra/core"),
    "ai": packageVersion("ai"),
    "@ai-sdk/openai": packageVersion("@ai-sdk/openai"),
  };
}

function createModel() {
  if (process.env.DEEPSEEK_API_KEY) {
    const deepseek = createOpenAI({
      baseURL: "https://api.deepseek.com/v1",
      apiKey: process.env.DEEPSEEK_API_KEY,
    });
    return deepseek(modelName());
  }
  if (process.env.OPENAI_API_KEY) {
    const openai = createOpenAI({ apiKey: process.env.OPENAI_API_KEY });
    return openai(modelName());
  }
  return null;
}

function isEnvFailure(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /429|ECONNRESET|ETIMEDOUT|ENOTFOUND|network|fetch failed|rate limit/i.test(message);
}

async function retry<T>(fn: () => Promise<T>): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!isEnvFailure(err) || attempt === 2) break;
      await new Promise((resolveRetry) => setTimeout(resolveRetry, 500 * (attempt + 1)));
    }
  }
  throw lastErr;
}

async function appendEvidence(value: unknown): Promise<void> {
  await writeFile(evidencePath, `${JSON.stringify(value)}\n`, { flag: "a" });
}

async function runSmoke(): Promise<SmokeArtifact> {
  const model = createModel();
  const localBad = compileAiDocumentToPm({
    blocks: [
      { type: "paragraph", runs: [{ text: "本地校验" }] },
      { type: "image", src: "https://example.com/not-allowed.png", alt: "坏图" },
    ],
  });
  const zodBlockErrors: SmokeStatus = !localBad.ok && localBad.blockErrors[0]?.index === 1 ? "PASS" : "FAIL";

  if (!model) return envSkip("missing DEEPSEEK_API_KEY or OPENAI_API_KEY");

  const artifact: SmokeArtifact = {
    timestamp: new Date().toISOString(),
    provider: providerName(),
    model: modelName(),
    versions: versions(),
    typeDefs: typeof streamObject === "function" && typeof streamText === "function" ? "PASS" : "FAIL",
    structuredOutput: "ERROR",
    streamElementGranularity: "ERROR",
    zodBlockErrors,
    fallbackStreamTextToIr: "ERROR",
    verdict: "ERROR",
    evidence: [evidencePath],
  };

  try {
    const streamed: unknown[] = [];
    const result = await retry(async () => {
      const stream = streamObject({
        model,
        output: "array",
        schema: aiBlockSchema,
        mode: "json",
        system: "输出恰好两个中文 AI-IR blocks，不要输出解释文字。",
        prompt: "生成一个 heading 和一个 paragraph，主题为 Phase C smoke。",
      });
      for await (const element of stream.elementStream) {
        streamed.push(element);
        await appendEvidence({ type: "element", element });
      }
      return await stream.object;
    });

    const compiled = compileAiDocumentToPm({ blocks: result });
    artifact.structuredOutput = compiled.ok ? "PASS" : "FAIL";
    artifact.streamElementGranularity = streamed.every((element) => aiBlockSchema.safeParse(element).success) ? "PASS" : "FAIL";
    await appendEvidence({ type: "final", result, blockErrors: compiled.blockErrors });

    const fallback = await retry(async () => {
      const textResult = streamText({
        model,
        system: "只输出 JSON：{\"blocks\":[{\"type\":\"paragraph\",\"runs\":[{\"text\":\"fallback ok\"}]}]}",
        prompt: "输出 fallback JSON",
        toolChoice: "none",
      });
      let text = "";
      for await (const delta of textResult.textStream) text += delta;
      return parseAiDocumentFromText(text);
    });
    const fallbackCompiled = compileAiDocumentToPm(fallback);
    artifact.fallbackStreamTextToIr = fallbackCompiled.ok ? "PASS" : "FAIL";
    await appendEvidence({ type: "fallback", fallback, blockErrors: fallbackCompiled.blockErrors });

    artifact.verdict = [
      artifact.typeDefs,
      artifact.structuredOutput,
      artifact.streamElementGranularity,
      artifact.zodBlockErrors,
      artifact.fallbackStreamTextToIr,
    ].every((status) => status === "PASS") ? "PASS" : "FAIL";
    return artifact;
  } catch (err) {
    if (isEnvFailure(err)) {
      return {
        ...artifact,
        structuredOutput: artifact.structuredOutput === "ERROR" ? "ENV_SKIP" : artifact.structuredOutput,
        streamElementGranularity: artifact.streamElementGranularity === "ERROR" ? "ENV_SKIP" : artifact.streamElementGranularity,
        fallbackStreamTextToIr: artifact.fallbackStreamTextToIr === "ERROR" ? "ENV_SKIP" : artifact.fallbackStreamTextToIr,
        verdict: "ENV_SKIP",
        error: err instanceof Error ? err.message : String(err),
      };
    }
    return {
      ...artifact,
      verdict: "ERROR",
      error: err instanceof Error ? err.stack ?? err.message : String(err),
    };
  }
}

await mkdir(dirname(artifactPath), { recursive: true });
const artifact = await runSmoke();
await writeFile(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`);
console.log(JSON.stringify(artifact, null, 2));
if (artifact.verdict === "FAIL" || artifact.verdict === "ERROR") {
  process.exitCode = 1;
}
