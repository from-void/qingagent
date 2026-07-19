import type { SkillRef, TableSelection } from "@qingagent/contract-ts";

export interface ChatChipSpec {
  kind: "sel" | "attach" | "mention" | "longtext" | "annotation";
  /** Bracket prefix shown before the label (e.g. "§"). */
  prefix?: string;
  /** Display text inside the chip body. */
  label: string;
  /** Trailing context shown after the label. */
  suffix?: string;
  /** ProseMirror absolute position of the selection start (selection chips only). */
  from?: number;
  /** ProseMirror absolute position of the selection end (selection chips only). */
  to?: number;
  /**
   * 稳定块锚:被引用块的 blockId(选区/块引用 chip 用)。后端按它精确找回引用的块,
   * 不再依赖会随表格/列表/原子块漂移的 PM 位置估算。
   */
  blockId?: string;
  /** 多行列表选区覆盖的 item refs，按文档顺序排列。 */
  selectionRefs?: string[];
  /** 表格行/列选区，0-based inclusive。 */
  tableSelection?: TableSelection;
  /**
   * 技能占位 chip 携带的 skill id(mention chip 用)。选技能=往正文插一个带 skillId 的占位
   * token,提交时由 snapshot() 从这些 token 反推出本轮 skills(去重)发后端做检索预加载/记录。
   * 不再维护单独的"已选中技能"状态。
   */
  skillId?: string;
  /**
   * 长文本折叠卡片(kind="longtext")承载完整原文；批注标记(kind="annotation")承载完整修改指令。
   * 发送时由 snapshot() 原位展开回 text 进入模型上下文；卡片本身只是输入区/气泡的短展示。
   */
  text?: string;
}

export interface ChatInputSnapshot {
  text: string;
  chips: ChatChipSpec[];
  files: File[];
  richText: string;
  skills: SkillRef[];
}

export interface ChatInputHandle {
  /** Insert a chip at the current caret. */
  insertChip: (spec: ChatChipSpec) => boolean;
  /** 按 snapshot 中的 chip 顺序移除一个 chip。 */
  removeChipAt: (index: number) => void;
  /** Insert plain text at the current caret. */
  insertText: (text: string) => void;
  /** Clear the editor. */
  clear: () => void;
  /**
   * Snapshot current text + chip payloads + files without forcing
   * a re-render. Each chip's structured data (kind / prefix / label /
   * suffix) is serialized from the chip node's data-* attributes so
   * Stage C receives the same `ChatChip` contract the protocol defines.
   *
   * `richText` preserves the interleaved order of text and chips using
   * `{{chip:N}}` markers (N = 0-based chip index). This enables inline
   * rendering of chips alongside text in sent message bubbles.
   */
  snapshot: () => ChatInputSnapshot;
  /** Restore a previously captured draft after an optimistic send fails. */
  restore: (snapshot: ChatInputSnapshot) => void;
  /** Focus the editor. */
  focus: () => void;
}
