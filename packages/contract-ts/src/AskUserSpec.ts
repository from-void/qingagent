import type { AskUserMode } from "./AskUserMode";
import type { AskUserPurpose } from "./AskUserPurpose";
import type { AskUserQuestion } from "./AskUserQuestion";

export type AskUserSpec = { id: string, mode: AskUserMode,
/**
 * 模型选择的语义意图；仅用于可观测（前端展示 / 日志），不影响渲染。null 表示未知（如冷恢复）。
 */
purpose: AskUserPurpose | null, source: string | null, rationale: string | null,
/**
 * ≤8 entries，具体工具可以在 adapter 层进一步收紧。
 */
questions: Array<AskUserQuestion>, };
