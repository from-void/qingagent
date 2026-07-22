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

// 模型每一段（整轮初始段、工具结果后的续写段）首个真实 chunk 前都可能没有心跳；
// 慢后端/并发下 TTFT 可能超过常规 90s idle。段首单独放宽到 180s，开始产出后
// 立即恢复严格 idle。环境变量名保留 first chunk 以兼容既有部署配置。
export const AGENT_FIRST_CHUNK_TIMEOUT_MS = Math.max(
  1_000,
  Number(process.env.QINGAGENT_AGENT_FIRST_CHUNK_TIMEOUT_MS) || 180_000,
);

// 心跳只能证明工具 execute 仍有定时器在跑，不能证明工具取得了真实进展。
// 若主流连续只有 tool-heartbeat、没有 result/error/progress 等真实事件，最终必须有界收口，
// 否则卡死的工具会用心跳永久喂活上面的 idle watchdog。默认 5 分钟，显著高于常规工具
// 的内部硬超时，又能在用户线上观察到的 9 分钟挂死之前释放整轮。
export const AGENT_TOOL_HEARTBEAT_TIMEOUT_MS = Math.max(
  1_000,
  Number(process.env.QINGAGENT_TOOL_HEARTBEAT_TIMEOUT_MS) || 5 * 60_000,
);

export const TURN_RETRY_LIMIT = 2;
export const MAX_CONSECUTIVE_ASKUSER_SUSPENDS = 2;
export const ABORT_CLEANUP_ACTIVE_TURN_TIMEOUT_MS = 5000;
