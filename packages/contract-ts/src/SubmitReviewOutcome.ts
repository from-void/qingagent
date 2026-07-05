import type { ReviewOutcome } from "./ReviewOutcome";

/**
 * 用户审核完一轮 diff 后，以用户名义把审核结果回流给后端，驱动模型进一轮追问 /
 * 继续修改。仅在「非全量采纳」（至少一处被拒）时由前端发出。
 */
export type SubmitReviewOutcome = { sessionId: string, outcome: ReviewOutcome, };
