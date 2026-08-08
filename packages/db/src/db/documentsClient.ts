import { createClient, type Client } from "@libsql/client";
import { AsyncLocalStorage } from "node:async_hooks";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

let client: Client | null = null;
let txnClient: Client | null = null;
let pragmaClients = new WeakSet<Client>();
let txnChain: Promise<unknown> = Promise.resolve();
const transactionContext = new AsyncLocalStorage<boolean>();

const defaultDbDir = join(homedir(), ".qingagent");
const defaultDbPath = join(defaultDbDir, "qingagent.db");
const defaultDbUrl = pathToFileURL(defaultDbPath).href;
let defaultDbLocationLogged = false;

export function resolveDbUrl(): string {
  const configured = process.env.DATABASE_URL;
  if (configured !== undefined) return configured;

  mkdirSync(defaultDbDir, { recursive: true, mode: 0o700 });
  if (!defaultDbLocationLogged) {
    defaultDbLocationLogged = true;
    console.info(`[database] 未配置 DATABASE_URL，使用默认数据库位置: ${defaultDbPath}`);
  }
  return defaultDbUrl;
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
}
