/**
 * 普通衍生稿追问的工具执行边界。首次/重新生成会在 query 中显式列出目标，
 * 不写入此键，以保留一轮串行生成多篇衍生稿的能力。
 */
export const ACTIVE_DERIVATIVE_DOC_ID_REQUEST_CONTEXT_KEY =
  "activeDerivativeDocId";
