import { identifyQuarantine0002OverwriteCandidates } from "../src/db/quarantine0002Audit.js";

const candidates = await identifyQuarantine0002OverwriteCandidates();
process.stdout.write(`${JSON.stringify({
  candidateCount: candidates.length,
  candidates,
}, null, 2)}\n`);
