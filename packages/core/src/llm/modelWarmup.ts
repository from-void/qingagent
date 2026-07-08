import { performance } from "node:perf_hooks";

type LogFn = (line: string) => void;

export function modelWarmupUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/models`;
}

/** 起服后后台预热模型域:GET <baseUrl>/models,不带 key(401 也已暖完 DNS+TCP+TLS)。
 * 绝不阻塞启动、绝不抛错;超时 5s;完成后打一行 warmup 诊断。 */
export function warmUpModelEndpoint(baseUrl: string, log: LogFn = console.log): void {
  if (process.env.QINGAGENT_MODEL_WARMUP === "0") return;
  const url = modelWarmupUrl(baseUrl);
  const origin = safeOrigin(url);
  const startedAt = performance.now();

  void fetch(url, {
    method: "GET",
    signal: AbortSignal.timeout(5_000),
  })
    .then((response) => {
      log(`[warmup] origin=${origin} status=${response.status} ms=${elapsedMs(startedAt)}`);
    })
    .catch(() => {
      log(`[warmup] origin=${origin} status=error ms=${elapsedMs(startedAt)}`);
    });
}

function safeOrigin(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return "invalid";
  }
}

function elapsedMs(startedAt: number): number {
  return Math.max(0, Math.round(performance.now() - startedAt));
}
