import { createHash } from "node:crypto";
import { modelFetch } from "@qingagent/core";
import {
  getProviderBalanceComparison,
  recordProviderBalanceSnapshot,
  type ProviderBalanceComparison,
} from "@qingagent/db";

const DEEPSEEK_BALANCE_URL = "https://api.deepseek.com/user/balance";
const BALANCE_PROBE_INTERVAL_MS = 6 * 60 * 60_000;
const BALANCE_PROBE_TIMEOUT_MS = 5_000;
const BALANCE_PROBE_DEDUPE_MS = 60_000;

let inFlight: Promise<void> | null = null;
let lastProbeAt = 0;

export function credentialFingerprint(apiKey: string): string {
  return createHash("sha256").update(apiKey, "utf8").digest("hex");
}

function envDeepseekAccount(): { apiKey: string; fingerprint: string } | null {
  const apiKey = process.env.DEEPSEEK_API_KEY?.trim();
  return apiKey ? { apiKey, fingerprint: credentialFingerprint(apiKey) } : null;
}

async function probeDeepseekBalance(): Promise<void> {
  const account = envDeepseekAccount();
  if (!account) return;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), BALANCE_PROBE_TIMEOUT_MS);
  timer.unref?.();
  try {
    const response = await modelFetch(DEEPSEEK_BALANCE_URL, {
      headers: { Authorization: `Bearer ${account.apiKey}` },
      signal: controller.signal,
    });
    if (!response.ok) return;
    const body = await response.json() as {
      balance_infos?: Array<{ currency?: unknown; total_balance?: unknown }>;
    };
    const cny = body.balance_infos?.find((item) => item.currency === "CNY");
    const balanceCny = Number(cny?.total_balance);
    if (!Number.isFinite(balanceCny) || balanceCny < 0) return;
    await recordProviderBalanceSnapshot({
      provider: "deepseek",
      credentialFingerprint: account.fingerprint,
      balanceCny,
    });
  } catch {
    // 对账探针仅供提示，失败不能影响启动、看板或模型主链。
  } finally {
    clearTimeout(timer);
  }
}

export function refreshDeepseekBalanceSnapshot(options: { force?: boolean } = {}): Promise<void> {
  if (inFlight) return inFlight;
  if (!options.force && Date.now() - lastProbeAt < BALANCE_PROBE_DEDUPE_MS) {
    return Promise.resolve();
  }
  lastProbeAt = Date.now();
  inFlight = probeDeepseekBalance().finally(() => { inFlight = null; });
  return inFlight;
}

export async function getEnvDeepseekBalanceComparison(): Promise<ProviderBalanceComparison | null> {
  const account = envDeepseekAccount();
  if (!account) return null;
  try {
    return await getProviderBalanceComparison("deepseek", account.fingerprint);
  } catch {
    return null;
  }
}

export function startProviderBalanceSnapshotScheduler(): () => void {
  void refreshDeepseekBalanceSnapshot({ force: true });
  const interval = setInterval(() => {
    void refreshDeepseekBalanceSnapshot({ force: true });
  }, BALANCE_PROBE_INTERVAL_MS);
  interval.unref?.();
  return () => clearInterval(interval);
}

export function resetProviderBalanceProbeForTests(): void {
  inFlight = null;
  lastProbeAt = 0;
}
