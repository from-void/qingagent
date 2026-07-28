import type {
  ConfirmSpec,
  CredentialShareItem,
  CredentialShareResponse,
} from "@qingagent/contract-ts";

/**
 * 「共享命令行工具登录信息」的确认卡与读写接口。
 * 文案只说用户能感知的事:哪个技能、哪个位置、为什么、在哪收回。
 */

function isItem(value: unknown): value is CredentialShareItem {
  if (!value || typeof value !== "object") return false;
  const input = value as Record<string, unknown>;
  return (
    typeof input.skillName === "string" &&
    typeof input.skillLabel === "string" &&
    typeof input.declared === "string" &&
    typeof input.granted === "boolean" &&
    (input.grantedAt === null || typeof input.grantedAt === "string")
  );
}

export function parseCredentialShareItems(value: unknown): CredentialShareItem[] {
  if (!value || typeof value !== "object") return [];
  const input = (value as Record<string, unknown>).items;
  if (!Array.isArray(input)) return [];
  return input.filter(isItem);
}

export function buildCredentialShareSpec(items: CredentialShareItem[]): ConfirmSpec | null {
  const first = items[0];
  if (!first) return null;
  const places = items.map((item) => item.declared).join("、");
  return {
    id: `credential-share:${first.skillName}:${items.map((item) => item.declared).join(",")}`,
    kind: "connect",
    title: `让「${first.skillLabel}」用上你已登录的账号`,
    sub: places,
    say:
      `「${first.skillLabel}」用的命令行工具要读写 ${places} 里的登录信息。` +
      "允许后，它在这里和你在终端里就是同一个账号，不用再登一次。",
    rememberCategory: {
      kind: "connect",
      label: "连接账号",
    },
    footHint: "只涉及这个位置 · 在 设置 → 安全 里随时收回",
    primaryLabel: "允许共享",
    secondaryLabel: "暂不共享",
  };
}

export async function fetchCredentialShareItems(): Promise<CredentialShareItem[]> {
  const response = await fetch("/api/v1/settings/credential-share");
  if (!response.ok) throw new Error("读取共享设置失败");
  return parseCredentialShareItems((await response.json()) as CredentialShareResponse);
}

export async function updateCredentialShare(input: {
  skillName: string;
  declared: string;
  granted: boolean;
}): Promise<void> {
  const response = await fetch("/api/v1/settings/credential-share", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!response.ok) throw new Error(input.granted ? "共享没有开启成功" : "共享没有收回成功");
}
