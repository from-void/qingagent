import { runQuarantine0002Recovery } from "../src/db/quarantine0002Recovery.js";

const report = await runQuarantine0002Recovery();
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
