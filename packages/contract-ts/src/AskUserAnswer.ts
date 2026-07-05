
/**
 * One submitted answer to an `AskUserQuestion`. `chosen` carries the
 * selected option values (empty for `kind=Text`); `freeText` carries
 * the user's free-text from the implicit "Other" affordance (always
 * available per Claude Code semantics, regardless of `kind`).
 * Both can be present for `Multi` questions where the user picked
 * option(s) AND typed free-text.
 */
export type AskUserAnswer = { chosen: Array<string>, freeText: string | null,
/** F4:kind=slider 的数值答案(不塞 chosen 字符串);其余 kind 为 null/缺省。 */
numericValue?: number | null, };
