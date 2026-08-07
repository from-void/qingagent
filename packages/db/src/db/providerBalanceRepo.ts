import { getDocumentsClient, withWriteRetry } from "./documentsClient.js";
import { ensureMigrated } from "./migrations.js";

export interface ProviderBalanceSnapshotInput {
  provider: string;
  credentialFingerprint: string;
  balanceCny: number;
  ts?: string | number | Date;
}

export interface ProviderBalanceComparison {
  provider: string;
  credentialFingerprint: string;
  latestBalanceCny: number;
  latestAt: string;
  previousBalanceCny?: number;
  changeCny?: number;
}

function snapshotTime(value: ProviderBalanceSnapshotInput["ts"]): string {
  const date = value instanceof Date ? value : value === undefined ? new Date() : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error("余额快照时间无效");
  return date.toISOString();
}

export async function recordProviderBalanceSnapshot(
  input: ProviderBalanceSnapshotInput,
): Promise<void> {
  if (!input.provider || !input.credentialFingerprint) throw new Error("余额快照账户标识不能为空");
  if (!Number.isFinite(input.balanceCny) || input.balanceCny < 0) throw new Error("余额快照金额无效");
  const client = getDocumentsClient();
  await ensureMigrated();
  await withWriteRetry(() => client.execute({
    sql: `INSERT INTO provider_balance_snapshots
      (ts, provider, credential_fingerprint, balance_cny) VALUES (?, ?, ?, ?)`,
    args: [
      snapshotTime(input.ts),
      input.provider,
      input.credentialFingerprint,
      input.balanceCny,
    ],
  })).then(() => undefined);
}

export async function getProviderBalanceComparison(
  provider: string,
  credentialFingerprint: string,
): Promise<ProviderBalanceComparison | null> {
  const client = getDocumentsClient();
  await ensureMigrated();
  const result = await client.execute({
    sql: `SELECT ts, balance_cny
      FROM provider_balance_snapshots
      WHERE provider = ? AND credential_fingerprint = ?
      ORDER BY ts DESC, rowid DESC LIMIT 2`,
    args: [provider, credentialFingerprint],
  });
  const latest = result.rows[0];
  if (!latest) return null;
  const previous = result.rows[1];
  const latestBalanceCny = Number(latest.balance_cny);
  const previousBalanceCny = previous ? Number(previous.balance_cny) : undefined;
  return {
    provider,
    credentialFingerprint,
    latestBalanceCny,
    latestAt: String(latest.ts),
    ...(previousBalanceCny === undefined
      ? {}
      : {
          previousBalanceCny,
          changeCny: latestBalanceCny - previousBalanceCny,
        }),
  };
}
