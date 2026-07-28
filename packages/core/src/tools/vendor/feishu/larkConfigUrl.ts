/**
 * 从 `lark-cli config init` 的输出里提取"创建飞书应用"链接。
 *
 * 背景:飞书 BYO-App onboarding 现走框架通用后台命令(execute_command background:true +
 * get_process_output),不再用专用 larkConfigInit 工具。但"从混杂 stdout 里挑出正确的飞书
 * 创建链接"这一步是确定性逻辑(按域名/关键词评分),比让模型自己猜更可靠,故保留为纯 util,
 * 供需要时复用,并配脏输入测试。
 */

function cleanupUrl(raw: string): string {
  return raw.replace(/[)\]\}>,，。；;,.!?！？]+$/u, "");
}

function isOfficialLarkHost(host: string): boolean {
  return [
    "feishu.cn",
    "larksuite.com",
    "larkoffice.com",
  ].some((domain) => host === domain || host.endsWith(`.${domain}`));
}

function scoreOnboardingUrl(value: string): number {
  let parsed: URL | null = null;
  try {
    parsed = new URL(value);
  } catch {
    return -1;
  }
  const host = parsed.hostname.toLowerCase();
  if (!isOfficialLarkHost(host)) return -1;
  const path = parsed.pathname.toLowerCase();
  const hasVerificationPath = /\/(?:verification|verify)(?:\/|$)/u.test(path);
  const hasCreationPath = /\/(?:app\/)?(?:create|init)(?:\/|$)/u.test(path);
  if (!hasVerificationPath && !hasCreationPath) return -1;

  let score = 10;
  if (hasVerificationPath || parsed.searchParams.has("verification")) score += 5;
  if (hasCreationPath) score += 4;
  return score;
}

/** 从一段可能混杂多条 URL 的文本里,挑出最像"飞书应用创建链接"的那条;没有返回 null。 */
export function extractLarkConfigInitUrl(output: string): string | null {
  const matches = output.match(/https?:\/\/[^\s<>"'`]+/giu) ?? [];
  if (matches.length === 0) return null;

  const candidates = matches
    .map((raw, index) => {
      const url = cleanupUrl(raw);
      return { url, index, score: scoreOnboardingUrl(url) };
    })
    .filter((candidate) => candidate.score >= 0);
  if (candidates.length === 0) return null;

  candidates.sort((a, b) => b.score - a.score || a.index - b.index);
  return candidates[0]!.url;
}
