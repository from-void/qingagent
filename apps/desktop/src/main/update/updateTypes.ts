// 更新链路的「无 electron 依赖」共享定义:抽出来让手动检查纯逻辑(manualCheck.ts)与其单测
// 能在 node:test 下直接 import——updater.ts 依赖 electron,ESM 链接期就会因 electron 包在非
// Electron 运行时只导出二进制路径(无具名导出)而报 "does not provide an export named 'app'"。

export const RELEASES_URL = "https://github.com/from-void/qingagent/releases";

// 五态基础上「只加不改」新增 error:仅用于手动检查的请求-响应结果,区分「已是最新」与「检查失败」。
// 启动被动检查仍把 error 映射为 none(静默不打扰),见 updater.ts。
export type UpdateStatusKind =
  | "soft-ready"
  | "soft-available"
  | "force"
  | "mac-manual"
  | "none"
  | "error";

export type UpdateStatusPayload = {
  kind: UpdateStatusKind;
  version?: string;
  notesUrl?: string;
};
