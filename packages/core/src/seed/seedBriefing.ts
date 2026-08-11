import { getAppSetting } from "@qingagent/db";

const SEED_BRIEFING_KEY_PREFIX = "seed_briefing:";

/** 读取预置示例会话的固定隐藏简报；普通会话返回 null。 */
export async function getSeedBriefing(sessionId: string): Promise<string | null> {
  if (!sessionId.trim()) return null;
  return getAppSetting(`${SEED_BRIEFING_KEY_PREFIX}${sessionId}`);
}

/**
 * 固定简报追加在 Agent immutable instructions 之后，作为 system-side context；
 * 不进入 chatHistory，也不会产生任何前端可见消息。
 */
export function appendSeedBriefingToInstructions(
  baseInstructions: string,
  briefing: string | null,
): string {
  const fixedBriefing = briefing?.trim();
  if (!fixedBriefing) return baseInstructions;
  return (
    `${baseInstructions}\n\n` +
    `## 系统·预置示例会话补充上下文（仅模型可见）\n${fixedBriefing}`
  );
}
