
/**
 * 渲染形态：由工具语义决定，模型不再选择。
 * fullpage = 右侧大表单（写作前的方向建模）；overlay = 对话浮层（写作中途的澄清）。
 * 模型的语义意图见 AskUserPurpose。
 */
export type AskUserMode = { "kind": "overlay" } | { "kind": "fullpage" };
