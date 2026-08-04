import { legacyBanExtraTerms, legacyTerms, scanTerms } from "./pm-ledger.mjs";

const phase = readPhase();
const terms = [...legacyTerms, ...legacyBanExtraTerms];
const results = scanTerms({ terms });
const runtimeResults = results.filter((result) => result.group === "runtime");

console.log(`PM legacy ban scan phase=${phase}`);
console.log(`terms: ${terms.join("|")}`);
console.log(`runtime files=${runtimeResults.length}`);
for (const result of runtimeResults) {
  console.log(`- ${result.path}: ${result.matches.map((match) => `${match.term}:${match.count}`).join(", ")}`);
}

if (phase === "F" && runtimeResults.length > 0) {
  console.error("Phase F requires runtime legacy terms to be cleared or moved to an explicit non-runtime whitelist.");
  process.exit(1);
}

console.log("pm:legacy-ban PASS");

function readPhase() {
  const phaseIndex = process.argv.findIndex((arg) => arg === "--phase");
  if (phaseIndex >= 0) return process.argv[phaseIndex + 1] ?? "F";
  const inline = process.argv.find((arg) => arg.startsWith("--phase="));
  if (inline) return inline.slice("--phase=".length);
  return "F";
}
