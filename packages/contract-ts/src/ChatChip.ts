import type { ChatChipKind } from "./ChatChipKind";
import type { ResourceRef } from "./ResourceRef";
import type { TableSelection } from "./TableSelection";

export type ChatChip = {
	kind: ChatChipKind,
	/**
	 * Required for Selection/Insertion/Attach/Mention; MUST be None
	 * for Skill/Text. Validator §5.1.3 enforces.
	 */
	resourceRef: ResourceRef | null,
	/**
	 * Trusted skill identifier carried only by skill chips. The backend uses this
	 * id to load SKILL.md; labels are display-only and must not be reverse-mapped.
	 */
	skillId?: string,
	prefix: string | null,
	label: string,
	suffix: string | null,
	/** ProseMirror absolute position of the selection start (selection chips only). */
	from?: number,
	/** ProseMirror absolute position of the selection end (selection chips only). */
	to?: number,
	/** Stable block refs covered by a selection chip, e.g. multiple listItem/taskItem refs. */
	selectionRefs?: string[],
	/** 表格行/列选区；仅 selection chip 可携带。 */
	tableSelection?: TableSelection,
	/**
	 * 长文本折叠卡片(kind=text)承载的完整原文，仅用于前端气泡里把卡片展开还原。
	 * 发送时长文本已展开进 SendMessage.text 进入模型上下文，本字段后端不消费。
	 */
	text?: string | null,
};
