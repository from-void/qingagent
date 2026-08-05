// deepseek-v4-flash 上下文虽为 393216 tokens，写稿还需给 65k 输出、主 system、
// 对话历史与技能注入留余量。generateDoc 与 readMaterial 共用这一预算，避免读取路径分叉。
export const MATERIAL_CONTEXT_MAX_CHARS = 120_000;
