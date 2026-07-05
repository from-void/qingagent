import { formatLedger, scanTerms } from "./pm-ledger.mjs";

const results = scanTerms();
console.log(formatLedger(results));
