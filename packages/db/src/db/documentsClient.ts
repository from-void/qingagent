import { createClient, type Client } from "@libsql/client";
import { AsyncLocalStorage } from "node:async_hooks";

let client: Client | null = null;
let txnClient: Client | null = null;
let pragmaClients = new WeakSet<Client>();
let txnChain: Promise<unknown> = Promise.resolve();
const transactionContext = new AsyncLocalStorage<boolean>();

let consecutiveFailures = 0;
let circuitOpenUntil = 0;
let lastWarnAt = Number.NEGATIVE_INFINITY;

export const SHADOW_CIRCUIT_FAIL_THRESHOLD = 5;
export const SHADOW_CIRCUIT_COOLDOWN_MS = 30_000;

export function resolveDbUrl(): string {
  return process.env.DATABASE_URL ?? "file:./qingagent.db";
}

export function getDocumentsClient(): Client {
  if (!client) {
    client = createClient({ url: resolveDbUrl() });
  }
  return client;
}

export function getTxnClient(): Client {
  if (!txnClient) {
    txnClient = createClient({ url: resolveDbUrl() });
  }
  return txnClient;
}

export async function ensurePragmas(c: Client): Promise<void> {
  if (pragmaClients.has(c)) return;
  if (resolveDbUrl().startsWith("file:")) {
    await c.execute("PRAGMA journal_mode=WAL");
    await c.execute("PRAGMA busy_timeout=5000");
  }
  pragmaClients.add(c);
}

function isBusyError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  const code = typeof err === "object" && err && "code" in err ? String(err.code) : "";
  return /SQLITE_BUSY|SQLITE_LOCKED|database is locked/i.test(`${code} ${message}`);
}

export async function withWriteRetry<T>(
  fn: () => Promise<T>,
  maxRetries = 5,
  initialBackoffMs = 50,
): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (!isBusyError(err)) throw err;
      lastErr = err;
      if (attempt < maxRetries - 1) {
        await new Promise((resolve) =>
          setTimeout(resolve, initialBackoffMs * 2 ** attempt),
        );
      }
    }
  }
  throw lastErr;
}

export type TransactionOutcome<T> =
  | { action: "commit"; value: T }
  | { action: "rollback"; value: T };

export function commitTransaction<T>(value: T): TransactionOutcome<T> {
  return { action: "commit", value };
}

export function rollbackTransaction<T>(value: T): TransactionOutcome<T> {
  return { action: "rollback", value };
}

async function runExclusiveTransaction<T>(
  fn: (client: Client) => Promise<TransactionOutcome<T>>,
): Promise<T> {
  return withWriteRetry(async () => {
    const c = getTxnClient();
    await ensurePragmas(c);
    await c.execute("BEGIN IMMEDIATE");
    let finished = false;
    try {
      const outcome = await fn(c);
      if (outcome.action === "commit") {
        await c.execute("COMMIT");
      } else {
        await c.execute("ROLLBACK");
      }
      finished = true;
      return outcome.value;
    } catch (err) {
      if (!finished) {
        try {
          await c.execute("ROLLBACK");
        } catch {
          // 原始错误更有价值；rollback 失败只说明事务已结束或连接异常。
        }
      }
      throw err;
    }
  });
}

export async function withTransaction<T>(
  fn: (client: Client) => Promise<TransactionOutcome<T>>,
): Promise<T> {
  if (transactionContext.getStore()) {
    throw new Error(
      "嵌套事务不受支持，请传递同一 client 组合原子操作",
    );
  }
  const run = txnChain.then(() =>
    runExclusiveTransaction((client) =>
      transactionContext.run(true, () => fn(client)),
    ),
  );
  txnChain = run.catch(() => {});
  return run;
}

export function shadowCircuitOpen(now: number): boolean {
  return now < circuitOpenUntil;
}

export function recordShadowOutcome(ok: boolean, now: number): void {
  if (ok) {
    consecutiveFailures = 0;
    circuitOpenUntil = 0;
    return;
  }
  consecutiveFailures++;
  if (consecutiveFailures >= SHADOW_CIRCUIT_FAIL_THRESHOLD) {
    circuitOpenUntil = now + SHADOW_CIRCUIT_COOLDOWN_MS;
  }
}

export function shouldWarn(now: number, minIntervalMs = 10_000): boolean {
  if (now - lastWarnAt < minIntervalMs) return false;
  lastWarnAt = now;
  return true;
}

export function getShadowCircuitState(): {
  consecutiveFailures: number;
  circuitOpenUntil: number;
} {
  return { consecutiveFailures, circuitOpenUntil };
}

export function __resetShadowCircuitForTest(): void {
  consecutiveFailures = 0;
  circuitOpenUntil = 0;
  lastWarnAt = Number.NEGATIVE_INFINITY;
}

export function __resetDocumentsClientForTest(): void {
  if (client && !client.closed) {
    client.close();
  }
  if (txnClient && !txnClient.closed) {
    txnClient.close();
  }
  client = null;
  txnClient = null;
  pragmaClients = new WeakSet<Client>();
  txnChain = Promise.resolve();
  __resetShadowCircuitForTest();
}
