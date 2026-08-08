import type { ChatChip } from "./ChatChip";
import type { SkillRef } from "./SkillRef";
import type { ActionCardData } from "./ActionCard";
import type { ReviewContext } from "./ReviewTemplates";

export type SendMessageTurnKind = "generateDerivative";

/**
 * 用户点击发送时，工作区界面实际激活的文档。
 *
 * 这是路由提示而非写权限：服务端仍须由会话级工具 guard 校验 docId 归属。
 */
export type ActiveDocumentTarget =
  | { kind: "main" }
  | { kind: "derivative"; docId: string };

export type SendMessage = { sessionId: string, text: string,
skills: Array<SkillRef>,
/**
 * User-side chip echoes (Selection, Insertion, Attach, Mention,
 * Skill, Text). Each chip carries an optional `ResourceRef` per
 * chip-kind rules (validator §5.1.3 enforces).
 */
chips: Array<ChatChip>,
/**
 * File IDs referencing previously uploaded files via
 * POST /api/v1/upload. Each ID maps to a file stored on the server.
 * Empty array when no files.
 */
fileIds: Array<string>,
/**
 * Optional client-generated message id for this user message. The client
 * renders its optimistic user bubble with this id; the server uses the SAME
 * id for the live `chatMessageAdded` user frame it emits, so the reducer's
 * id-dedup collapses them into one bubble. Also keeps the user message
 * present in FrameLog replay (re-enter during generation shows the bubble).
 */
clientMessageId?: string,
/**
 * Optional interleaved form of the message: `text` with `{{chip:N}}`
 * placeholders at the chips' original positions (N indexes into `chips`).
 * The server expands placeholders into inline tokens for the model
 * (「技能：X」/「文件：X」…, positional binding preserved — industry
 * pattern à la Copilot `#file:` / Cline `@mention`), and uses it as the
 * user bubble body so replay/restore render chips inline (WYSIWYG).
 * Absent = plain-text message; behavior unchanged.
 */
richText?: string,
/** 受控的用户动作分类，只用于服务端模型调用归属，不接受任意 site。 */
turnKind?: SendMessageTurnKind,
/**
 * 当前指令默认作用的文档。服务端据此生成仅本轮有效的模型路由上下文，
 * 不把瞬态选中态写进持久会话历史。
 */
activeDocument?: ActiveDocumentTarget,
/** 可选的用户侧展示卡；模型仍接收 text 原文。 */
displayCard?: ActionCardData,
/** 审查菜单发起时的结构化类型/模板标识；只约束当前回合。 */
reviewContext?: ReviewContext, };
