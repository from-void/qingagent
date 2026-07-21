/** 沙箱命令执行卡:模型在沙箱跑命令后,在聊天里定格成一张友好卡。
 *  对小白:默认显示人话(图标+做了什么+成功/失败);命令原文与输出藏在"查看详情"折叠。 */
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
  /** 仅确认恢复链路的运行中命令允许按 toolCallId 定向停止。 */
  cancellable?: boolean;
};
