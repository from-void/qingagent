import { runLiveScorers } from "../packages/core/src/evals/index.js";

const artifact = await runLiveScorers();
console.log(JSON.stringify(artifact, null, 2));

if (artifact.verdict !== "passed" && artifact.verdict !== "ENV_SKIP") {
  process.exitCode = 1;
}
