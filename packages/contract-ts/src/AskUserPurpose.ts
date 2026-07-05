
/**
 * 模型提问时的语义意图（由 LLM 选择）。后端据此 + 会话阶段决定渲染形态 AskUserMode。
 * - initialBrief：开写前收集整体方向（文体/篇幅/风格/受众等）
 * - quickClarification：写作过程中就某个局部小问题做一次澄清
 * - directionChange：已有文档但用户想推翻、重设整体写作方向
 */
export type AskUserPurpose =
  | { "kind": "initialBrief" }
  | { "kind": "quickClarification" }
  | { "kind": "directionChange" };
