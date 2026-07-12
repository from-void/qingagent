import { parentPort } from "node:worker_threads";

interface WorkerRequest {
  id: number;
  pattern: string;
  flags: string;
  text: string;
  limit: number;
}

interface WorkerMatch {
  text: string;
  index: number;
  captures: string[];
}

function run(input: WorkerRequest):
  | { ok: true; matches: WorkerMatch[] }
  | { ok: false; error: string } {
  try {
    const re = new RegExp(input.pattern, input.flags);
    const matches: WorkerMatch[] = [];
    let match: RegExpExecArray | null;
    while ((match = re.exec(input.text)) !== null) {
      if ((match[0] ?? "").length === 0) {
        re.lastIndex += 1;
        continue;
      }
      if (matches.length >= input.limit) {
        return { ok: false, error: "unsafe regex (too many matches)" };
      }
      matches.push({
        text: match[0] ?? "",
        index: match.index,
        captures: match.slice(1).map((part) => part ?? ""),
      });
    }
    return { ok: true, matches };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

parentPort?.on("message", (input: WorkerRequest) => {
  parentPort?.postMessage({ id: input.id, ...run(input) });
});
