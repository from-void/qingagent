// 切换「以后不用再问我」的唯一写入口:落库 + 让已有会话立即换形态。
//
// 单独成文件是为了避免环:bypassMode 只管状态,sessionWorkspace 读状态,
// 这里把两者组合起来,谁都不反向依赖谁。

import { invalidateSessionWorkspace } from "../workspace/sessionWorkspace.js";
import { setBypassMode, type SecurityBypassSnapshot } from "./bypassMode.js";

/**
 * 开启/关闭全局免询问,并让所有已有会话的工作区立即按新形态重建:
 * 开启后下一条命令就不再进隔离,关闭后下一条命令立刻回到隔离 + 弹卡。
 * (与凭据授权变更同一套失效姿势。)
 */
export async function applyBypassMode(enabled: boolean): Promise<SecurityBypassSnapshot> {
  const snapshot = await setBypassMode(enabled);
  invalidateSessionWorkspace();
  return snapshot;
}
