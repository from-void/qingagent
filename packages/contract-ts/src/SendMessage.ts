import type { ChatChip } from "./ChatChip";
import type { ResourceRef } from "./ResourceRef";
import type { SkillRef } from "./SkillRef";
import type { ActionCardData } from "./ActionCard";
import type { ReviewContext } from "./ReviewTemplates";

export type SendMessage = { sessionId: string, text: string,
/**
 * Round 3 sweep: mentions are now `ResourceRef` directly. Any of
 * the 10 resource domains is legal as a mention target.
 */
mentions: Array<ResourceRef>, skills: Array<SkillRef>,
/**
 * User-side chip echoes (Selection, Insertion, Attach, Mention,
 * Skill, Text). Each chip carries an optional `ResourceRef` per
 * chip-kind rules (validator §5.1.3 enforces).
 */
chips: Array<ChatChip>,
/**
 * Optional file IDs referencing previously uploaded files via
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
/** 可选的用户侧展示卡；模型仍接收 text 原文。 */
displayCard?: ActionCardData,
/** 审查菜单发起时的结构化类型/模板标识；只约束当前回合。 */
reviewContext?: ReviewContext, };
