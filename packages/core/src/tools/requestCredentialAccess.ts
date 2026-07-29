import { createTool, type ToolExecutionContext } from "@mastra/core/tools";
import { z } from "zod";
import {
  checkRequestedCredentialAccess,
  credentialAccessDigest,
  effectiveCredentialHome,
  requestCredentialAccessInputSchema,
  REQUEST_CREDENTIAL_ACCESS_TOOL,
  type RequestCredentialAccessInput,
} from "../confirm/credentialAccessConfirmation.js";
import { consumeApprovalProof, type ApprovalProofSession } from "../confirm/approvalProof.js";
import { credentialAccessIsCooling } from "../confirm/credentialAccessCooldown.js";
import { ensureCredentialPathExists } from "../skills/credentialRequests.js";
import { isBypassEnabled } from "../security/bypassMode.js";
import { invalidateSessionWorkspace } from "../workspace/sessionWorkspace.js";

/**
 * 按需授权兜底通道。技能声明是第一通道(装好就有),本工具是第二通道:
 * 任意 CLI 撞墙时模型就地申请,用户拍板,授权按路径落进同一张表、走同一条生效管线。
 *
 * 拒绝后同一路径进入冷却:模型再申请也不会再弹卡骚扰用户,直接拿到"已拒绝"的答复。
 */
export interface CredentialAccessGrantStore {
  createGrant: (input: {
    path: string;
    skillName: string;
    declared: string;
    source: "card";
  }) => Promise<unknown>;
}

export interface RequestCredentialAccessToolOptions {
  sessionId: string;
  /** proof 只绑当前内存会话;缺失时一律 fail-closed。 */
  state?: ApprovalProofSession;
  store: CredentialAccessGrantStore;
  now?: () => number;
  home?: string;
}

const outputSchema = z.object({
  granted: z.boolean(),
  message: z.string(),
});

export function createRequestCredentialAccessTool(
  options: RequestCredentialAccessToolOptions,
) {
  const now = options.now ?? Date.now;
  const home = options.home ?? effectiveCredentialHome();
  const cooling = (declared: string): boolean =>
    credentialAccessIsCooling(options.state, declared, now());

  return createTool({
    id: REQUEST_CREDENTIAL_ACCESS_TOOL,
    description:
      "命令因权限被拒、且报错指向用户目录下某个路径时,用本工具申请共享该位置的登录信息,得到允许后重试原命令;不要放弃或绕行。" +
      "path 写 ~/ 开头的目录(如 ~/.yuque);reason 一句话说明哪个工具、为什么需要,会原样念给用户听。" +
      "浏览器数据和系统钥匙串一律不可申请。",
    inputSchema: requestCredentialAccessInputSchema,
    outputSchema,
    // 冷却中的路径不再挂起确认,直接由 execute 回一句"已拒绝",避免反复弹卡。
    requireApproval: (input: RequestCredentialAccessInput) => {
      // 用户已勾「以后不用再问我」时不再弹任何确认卡;此时命令本就以用户本人身份
      // 执行,这条申请通道没有任何要授权的东西,execute 会直接告诉模型可以重试。
      if (isBypassEnabled()) return false;
      const checked = checkRequestedCredentialAccess(input, home);
      if (!checked.ok) return false;
      return !cooling(checked.declared);
    },
    execute: async (
      input: RequestCredentialAccessInput,
      context?: ToolExecutionContext,
    ) => {
      if (isBypassEnabled()) {
        return {
          granted: true,
          message: "现在不需要额外授权，直接重试刚才的命令即可。",
        };
      }
      const checked = checkRequestedCredentialAccess(input, home);
      if (!checked.ok) {
        return { granted: false, message: `不能共享这个位置:${checked.message}` };
      }
      if (cooling(checked.declared)) {
        return {
          granted: false,
          message: `用户刚刚拒绝共享 ${checked.declared}，不要再申请。改用不需要这份登录的做法，或让用户自己在设置里开启。`,
        };
      }
      // 走到这里说明确认卡已被用户点了「允许」(Mastra 只在批准后才执行本工具);
      // proof 再核一次,确保批准的正是这份参数。
      const state = options.state;
      const runId = context?.requestContext?.get("runId");
      const toolCallId = context?.agent?.toolCallId;
      const hasProof =
        state !== undefined &&
        typeof runId === "string" && runId.length > 0 &&
        typeof toolCallId === "string" && toolCallId.length > 0 &&
        consumeApprovalProof(state, {
          sessionId: options.sessionId,
          runId,
          toolCallId,
          commandDigest: credentialAccessDigest(options.sessionId, input),
        });
      if (!hasProof) {
        return { granted: false, message: "这次授权没有完成，请让用户重新确认后再试。" };
      }

      await ensureCredentialPathExists(checked.path);
      await options.store.createGrant({
        path: checked.path,
        // 兜底通道的授权不绑技能:按路径记,技能声明通道拿到同一条也直接生效。
        skillName: "",
        declared: checked.declared,
        source: "card",
      });
      // credential_grants 是全局表;作废全部会话缓存,让其它会话的下一条命令也重建策略。
      invalidateSessionWorkspace();
      return {
        granted: true,
        message: `已可以读写 ${checked.declared}，现在重试刚才被拒的命令。`,
      };
    },
  });
}
