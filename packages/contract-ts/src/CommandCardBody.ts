/** 沙箱命令执行卡:模型在沙箱跑命令后,在聊天里定格成一张友好卡。
 *  对小白:默认显示人话(图标+做了什么+成功/失败);命令原文与输出藏在"查看详情"折叠。 */
export type CommandTerminalKind =
  | "rejected"
  | "killed"
  | "aborted"
  | "failed"
  | "timedOut"
  | "succeeded";

export type CommandCardBody = {
  /** 人话标题(意图化,如"计算"、"发布到飞书")。 */
  title: string;
  /** 图标(🧮/📤/🗑️/⚙️ 等)。 */
  icon: string;
  /** 命令原文(折叠在详情里,不默认展示给小白)。 */
  command: string;
  /** 退出码(0=成功)。 */
  exitCode: number;
  /** 输出尾部(折叠在详情里;已脱敏截断)。 */
  outputTail: string;
  /** running=执行中;done=成功;failed=非零退出。 */
  phase: "running" | "done" | "failed";
  /** 结构化终态；运行中不填写，前端不得再从 reason 文案猜测。 */
  terminalKind?: CommandTerminalKind;
  /** 后台进程 PID；随 owner 卡持久化，供后续退出/kill 精确收口。 */
  pid?: string;
  /** 启动后台进程的原始 toolCallId。 */
  ownerToolCallId?: string;
  /** 标识跨轮次持续运行的后台进程卡。 */
  background?: boolean;
  /** killed 终态的权威信号。 */
  signal?: string;
  /** 仅确认恢复链路的运行中命令允许按 toolCallId 定向停止。 */
  cancellable?: boolean;
};
