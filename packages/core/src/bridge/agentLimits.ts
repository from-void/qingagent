// agent 单轮工具调用步数上限。10 对纯写作够用,但浏览器交互(browser_* 登录:
// goto→snapshot→click→type→… 轻松十几步)很容易超;超限会静默截断 → 前端卡住。
// 故默认提到 60 并允许 env 覆盖(浏览器链路 30 仍易超);真超限时另有
// "步数耗尽兜底"发可见提示(见 processAgentStream)。
export const AGENT_MAX_STEPS = Math.max(1, Number(process.env.QINGAGENT_AGENT_MAX_STEPS) || 60);

// agent 主流空闲看门狗:连续这么久没有任何 chunk 就判定卡死、abort 整轮。
// 默认 90s 是"有心跳时"的兜底:允许偶发心跳漏发或单次 await 抖动,避免工具正常
// 执行时被误杀(实测:SVG 生成期静默 >45s 被掐、图没插入)。
// generateSvg 工具内层有 30s 硬超时;心跳仍是兜底,防止慢网络/消毒写盘期间主流静默。
// 主防线是各耗时工具的 startToolHeartbeat 周期性注入 chunk 清零看门狗,不是继续拉大 idle。
export const AGENT_IDLE_TIMEOUT_MS = Math.max(
  1_000,
  Number(process.env.QINGAGENT_AGENT_IDLE_TIMEOUT_MS) || 90_000,
);

export const TURN_RETRY_LIMIT = 2;
export const MAX_CONSECUTIVE_ASKUSER_SUSPENDS = 2;
export const ABORT_CLEANUP_ACTIVE_TURN_TIMEOUT_MS = 5000;
