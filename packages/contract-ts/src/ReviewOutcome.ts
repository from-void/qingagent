/**
 * 一轮 diff 审核的结果汇总。用户点「提交（局部采纳）」或「放弃本轮修改（全部拒绝）」
 * 后，前端据当前审阅态逐处归并生成本对象，随 `submitReviewOutcome` 命令回流给后端。
 *
 * 同一对象做两投影：① 后端序列化成中文正文喂模型（看到每处 before/after + 采纳/拒绝）；
 * ② 作为 `MessagePart{kind:"reviewOutcome"}` 进 chatHistory，前端渲染成缩略卡片。
 */
export type ReviewOutcome = {
	/** 采纳的修改处数。 */
	acceptedCount: number;
	/** 拒绝的修改处数。 */
	rejectedCount: number;
	/** 逐处修改明细（采纳 + 拒绝都在内，供模型读全文 / 卡片展开）。 */
	hunks: Array<ReviewOutcomeHunk>;
};

export type ReviewOutcomeHunk = {
	verdict: "accepted" | "rejected";
	/** 该处所在块的简短摘要（用于卡片一行简述，可截断）。 */
	blockSummary: string;
	/** 原文。 */
	beforeText: string;
	/** 新文（模型这一处的改写结果）。 */
	afterText: string;
};
