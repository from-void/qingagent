import type { ActiveDocumentTarget } from "@qingagent/contract-ts";
import type { CoreMessage } from "ai";

/**
 * 把界面激活文档翻译成模型当轮路由提示。
 *
 * 该提示必须只进入本次模型调用，不能写回 SessionState.messages；否则 Tab 选中态会
 * 退化成会话历史事实，下一轮切回主稿时仍可能沿用旧衍生稿路由。
 */
export function buildActiveDocumentTurnContext(
  target: ActiveDocumentTarget,
): string {
  if (target.kind === "main") {
    return (
      "[系统·当前文档目标]本轮发送时界面激活的是主文档。" +
      "此状态优先于历史消息中任何“当前正查看衍生稿”或衍生稿 doc_id 标记；那些只描述旧轮，现已失效。" +
      "用户用“当前文档”“这篇”“第几段”等指代且本轮未明确点名别的稿件时，目标就是主文档。" +
      "修改主文档须走 readDraft/editDraft/readDiff 草稿流程，不得因历史衍生稿上下文调用 " +
      "derivative_brief、update_derivative_params 或 generate_derivative。" +
      "只有用户本轮明确要求新建、生成或操作衍生稿时，才按该明确诉求改走衍生稿路由。"
    );
  }

  return (
    `[系统·当前文档目标]本轮发送时界面激活的是衍生稿(doc_id: ${target.docId})。` +
    "此状态优先于历史消息中的旧文档目标。" +
    "用户用“当前文档”“这篇”等指代且本轮未明确点名别的稿件时，目标就是这篇衍生稿；" +
    "修改它须按“已有衍生稿修改路由”执行，doc_id 已给出，无需 list_derivatives 定位。" +
    "不得把这类修改反向写入主文档。"
  );
}

/**
 * 有当轮提示时，只为当前模型请求复制并增强最后一条 user message，保留持久消息数组原样；
 * 没有可注入提示时直接返回原引用，保持 OM 非投影/fail-open 路径的消息同一性。
 * 放在末条 user 尾部还能保持历史前缀字节稳定，避免 active tab 切换打散模型前缀缓存。
 */
export function appendTurnContextToLatestUserMessage(
  messages: CoreMessage[],
  context: string | null | undefined,
): CoreMessage[] {
  const trimmed = context?.trim();
  if (!trimmed) return messages;

  let userIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === "user") {
      userIndex = index;
      break;
    }
  }
  if (userIndex < 0) return messages;
  const userMessage = messages[userIndex]!;
  const content =
    typeof userMessage.content === "string"
      ? `${userMessage.content}\n\n${trimmed}`
      : [
          ...userMessage.content,
          { type: "text" as const, text: `\n\n${trimmed}` },
        ];
  const next = [...messages];
  next[userIndex] = { ...userMessage, content } as CoreMessage;
  return next;
}
