import type { BalanceState } from "./modelSettingsTypes";
import type { ModelProvider, ModelTier } from "./visitorKeyStore";

export interface CustomConnectionTestInput {
  provider: ModelProvider;
  baseUrl: string;
  apiKey: string;
  model: string;
  protocol: string;
}

export interface CustomConnectionTestResult {
  ok: boolean;
  keyInvalid?: boolean;
  permissionDenied?: boolean;
  error?: string;
  normalizedBaseUrl?: string;
}

/** 设置页与首启页共用同一个官方 key 连通性端点。 */
export async function testOfficialModelKey({
  provider,
  apiKey,
  tier,
  signal,
}: {
  provider: ModelProvider;
  apiKey: string;
  tier?: ModelTier;
  signal?: AbortSignal;
}): Promise<BalanceState> {
  const response = await fetch("/api/v1/settings/model/balance", {
    headers: {
      "x-model-provider": provider,
      "x-model-key": apiKey.trim(),
      ...(tier ? { "x-model-tier": tier } : {}),
    },
    signal,
  });
  return (await response.json()) as BalanceState;
}

/** 设置页与首启页共用同一个自定义 provider 代理测试端点。 */
export async function testCustomModelConnection(
  input: CustomConnectionTestInput,
  signal?: AbortSignal,
): Promise<CustomConnectionTestResult> {
  const response = await fetch("/api/v1/settings/model/test-custom", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
    signal,
  });
  return (await response.json()) as CustomConnectionTestResult;
}

