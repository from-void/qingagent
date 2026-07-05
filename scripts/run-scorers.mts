import { getOfflineScorerSuites } from "../packages/core/src/evals/fixtures.js";

type FixtureResult = {
  id: string;
  source: string;
  score: number;
  reason?: string;
};

type SuiteResult = {
  id: string;
  description: string;
  threshold: number;
  averageScore: number;
  passed: boolean;
  fixtures: FixtureResult[];
};

const includeBadFixture = process.env.QINGAGENT_SCORER_INJECT_BAD_FIXTURE === "1";
const suites = getOfflineScorerSuites({ includeBadFixture });
const suiteResults: SuiteResult[] = [];

for (const suite of suites) {
  const fixtures: FixtureResult[] = [];
  for (const fixture of suite.fixtures) {
    const result = await suite.scorer.run({
      runId: `${suite.id}:${fixture.id}`,
      input: fixture.input,
      output: fixture.output,
      groundTruth: fixture.groundTruth,
    });
    if (typeof result.score !== "number" || !Number.isFinite(result.score)) {
      throw new Error(`${suite.id}/${fixture.id} returned non-numeric score: ${String(result.score)}`);
    }
    fixtures.push({
      id: fixture.id,
      source: fixture.source,
      score: result.score,
      reason: typeof result.reason === "string" ? result.reason : undefined,
    });
  }
  const averageScore = fixtures.reduce((sum, item) => sum + item.score, 0) / Math.max(1, fixtures.length);
  suiteResults.push({
    id: suite.id,
    description: suite.description,
    threshold: suite.threshold,
    averageScore,
    passed: averageScore >= suite.threshold,
    fixtures,
  });
}

const failed = suiteResults.filter((suite) => !suite.passed);
const artifact = {
  timestamp: new Date().toISOString(),
  mode: "offline-deterministic-scorer",
  includeBadFixture,
  summary: {
    totalSuites: suiteResults.length,
    failedSuites: failed.length,
    verdict: failed.length === 0 ? "PASS" : "FAIL",
  },
  suites: suiteResults,
};

console.log(JSON.stringify(artifact, null, 2));

if (failed.length > 0) {
  process.exitCode = 1;
}
