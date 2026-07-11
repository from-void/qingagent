import type { AskUserOption } from "./AskUserOption";
import type { AskUserQuestionKind } from "./AskUserQuestionKind";

/**
 * F4 滑块配置(kind=slider 时必填)。范围由工具侧 sanitize 保证合理:
 * 字数类 min>0;滑到最右(=max)时 UI 显示 `aboveLabel`(如「2000 字以上」)。
 */
export type AskUserSliderSpec = { min: number, max: number, step: number,
/** 单位文案,如「字」「段」。 */
unit: string | null,
/** 刻度值(可选,UI 画刻度;为空则按 step 自动)。 */
marks: Array<number> | null,
/** 滑到最右端的展示文案,如「2000 字以上」。 */
aboveLabel: string | null, };

export type AskUserQuestion = { id: string,
/** 可选短标题，按 Unicode code point 计最多 12 个字符。 */
header?: string | null, label: string, kind: AskUserQuestionKind,
/**
 * MUST be empty for kind=Text/Slider. ≤8 entries (channel validator enforces).
 */
options: Array<AskUserOption>, placeholder: string | null,
/** kind=slider 时必填,其余 kind 为 null/缺省。 */
slider?: AskUserSliderSpec | null, };
