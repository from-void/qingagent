/** 沙箱命令执行卡:模型在沙箱跑命令后,在聊天里定格成一张友好卡。
 *  对小白:默认显示人话(图标+做了什么+成功/失败);命令原文与输出藏在"查看详情"折叠。 */
export type CommandTerminalKind =
  | "rejected"
  | "killed"
  | "aborted"
  | "failed"
  /** 脚本已运行但代码自身报错。 */
  | "codeError"
  /** 脚本触发内存等资源护栏。 */
  | "resourceExceeded"
  | "timedOut"
  /** 命令转入交互式授权等待、被系统提前收口：不是失败也不是超时，卡面说"需要重新授权"。 */
  | "authRequired"
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
  /** running=动作执行中;done=动作已完成（后台命令指已拉起）;failed=动作失败。 */
  phase: "running" | "done" | "failed";
  /** 结构化进程终态；后台命令刚拉起时即使 phase=done 也暂不填写。 */
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
