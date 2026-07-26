import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from "react";
import type { NodeViewRendererProps } from "@tiptap/core";
import { NodeViewContent, NodeViewWrapper, ReactNodeViewRenderer } from "@tiptap/react";
import { CalloutNode } from "@qingagent/pm-schema/tiptap";

/* ───────────── 主题(贴合奶白纸 + 暖墨美学)─────────────
 * tone 枚举值(PM_CALLOUT_TONES)即「主题槽」——序列化/契约/AI-IR 全链路靠它,稳定可扩。
 * 这里 10 套主题横跨色相轮但全部去饱和、压低,坐在 #efe7d6 奶白纸上不刺眼。
 * 每个主题给默认 emoji 与一枚代表色(选择器小圆点 / 触发钮)。
 */
interface CalloutTheme {
  /** schema 里的 tone 枚举值(数据键) */
  tone: string;
  /** UI 主题名 */
  label: string;
  /** 代表色(选择器圆点 / 触发钮) */
  swatch: string;
  /** 该主题默认 emoji(仅供参考,不强改用户已选) */
  defaultEmoji: string;
}

// 顺序即选择器排列(暖 → 冷)。tone 键与 spec.ts PM_CALLOUT_TONES 一致。
export const CALLOUT_THEMES: readonly CalloutTheme[] = [
  { tone: "neutral", label: "素笺", swatch: "#b39d78", defaultEmoji: "📋" },
  { tone: "warning", label: "暖金", swatch: "#a8823f", defaultEmoji: "⭐" },
  { tone: "ochre", label: "赭石", swatch: "#b07a3c", defaultEmoji: "📌" },
  { tone: "danger", label: "朱砂", swatch: "#b04a34", defaultEmoji: "⚠️" },
  { tone: "rose", label: "绯霞", swatch: "#bd6a72", defaultEmoji: "🌸" },
  { tone: "mauve", label: "藕荷", swatch: "#9a6a9e", defaultEmoji: "💜" },
  { tone: "indigo", label: "黛青", swatch: "#6a6cae", defaultEmoji: "🌙" },
  { tone: "info", label: "黛蓝", swatch: "#5a7396", defaultEmoji: "💡" },
  { tone: "teal", label: "青碧", swatch: "#4f8f88", defaultEmoji: "🌊" },
  { tone: "success", label: "苔绿", swatch: "#5a7d4a", defaultEmoji: "✅" },
];

const DEFAULT_TONE = "info";

function resolveTone(tone: unknown): string {
  return typeof tone === "string" && CALLOUT_THEMES.some((t) => t.tone === tone)
    ? tone
    : DEFAULT_TONE;
}

function themeOf(tone: string): CalloutTheme {
  return CALLOUT_THEMES.find((t) => t.tone === tone) ?? CALLOUT_THEMES[7]!; // 兜底黛蓝(info)
}

/* 选择器里的常用 emoji(精选,非全量 emoji 键盘——跨平台可靠、轻量)。 */
const EMOJI_CHOICES: readonly string[] = [
  "💡", "⭐", "✅", "⚠️", "📌", "📝", "🔥", "💬",
  "❗", "ℹ️", "🎯", "🚀", "📖", "🔑", "💎", "🌿",
  "☕", "🧠", "📊", "🎨", "🐛", "🔒", "❤️", "✨",
  "📋", "🎉", "⏰", "🌟", "🌸", "💜", "🌙", "🌊",
];

/* ───────────── React NodeView 组件 ───────────── */

interface CalloutNodeViewProps {
  editor?: NodeViewRendererProps["editor"];
  node: NodeViewRendererProps["node"];
  updateAttributes: (attrs: Record<string, unknown>) => void;
}

function CalloutComponent(props: CalloutNodeViewProps) {
  const { editor, node, updateAttributes } = props;
  const editable = Boolean(editor?.isEditable);
  const tone = resolveTone(node.attrs.tone);
  const activeTheme = themeOf(tone);
  // emoji 为空串("无图标",显式清除)或非字符串时不显图标,显"＋"占位。
  // 用 "" 而非 null 表达"无图标":normalizeAttrsShape 会删掉 null 值的 attr(validators.ts),
  // 导致重载时回落 base 默认 "💡"(用户清掉的图标复活);"" 不被 strip,故能持久保留无图标态。
  const emojiAttr = node.attrs.emoji;
  const emoji = typeof emojiAttr === "string" && emojiAttr.length > 0 ? emojiAttr : null;

  const [emojiOpen, setEmojiOpen] = useState(false);
  const [themeOpen, setThemeOpen] = useState(false);
  // ref 整个 wrap(触发钮 + 浮层):再点触发钮时 document 监听视作"内部"不关,交给 onClick 切换收起。
  const emojiWrapRef = useRef<HTMLSpanElement | null>(null);
  const themeWrapRef = useRef<HTMLSpanElement | null>(null);

  useEffect(() => {
    if (editable) return;
    setEmojiOpen(false);
    setThemeOpen(false);
  }, [editable]);

  // 点空白处 / Esc 关闭浮层(不打断正文输入)。
  useEffect(() => {
    if (!emojiOpen && !themeOpen) return;
    const onDocDown = (e: globalThis.MouseEvent) => {
      const t = e.target as Node;
      if (emojiOpen && !emojiWrapRef.current?.contains(t)) setEmojiOpen(false);
      if (themeOpen && !themeWrapRef.current?.contains(t)) setThemeOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setEmojiOpen(false);
        setThemeOpen(false);
      }
    };
    document.addEventListener("mousedown", onDocDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [emojiOpen, themeOpen]);

  // chrome 上的 mousedown 一律 preventDefault:避免点 chrome 时编辑器失焦/选区跳。
  const keepFocus = useCallback((e: ReactMouseEvent) => {
    e.preventDefault();
  }, []);

  const pickEmoji = useCallback(
    (next: string) => {
      if (!editable) return;
      updateAttributes({ emoji: next });
      setEmojiOpen(false);
    },
    [editable, updateAttributes],
  );

  const pickTone = useCallback(
    (nextTone: string) => {
      if (!editable) return;
      updateAttributes({ tone: nextTone });
      setThemeOpen(false);
    },
    [editable, updateAttributes],
  );

  return (
    <NodeViewWrapper
      className={`pm-callout pm-callout--${tone}`}
      data-pm-node="callout"
      data-tone={tone}
    >
      {/* emoji 图标(可点击换 emoji);contentEditable=false 不进正文 */}
      <span className="pm-callout-emoji-wrap" contentEditable={false} ref={emojiWrapRef}>
        <button
          type="button"
          className="pm-callout-emoji"
          onMouseDown={keepFocus}
          onClick={() => {
            if (!editable) return;
            setEmojiOpen((v) => !v);
          }}
          disabled={!editable}
          aria-label="选择图标"
          title="选择图标"
        >
          {emoji ?? <span className="pm-callout-emoji-empty">＋</span>}
        </button>
        {emojiOpen && (
          <div className="pm-callout-emoji-pop" contentEditable={false}>
            <div className="pm-callout-emoji-grid">
              {EMOJI_CHOICES.map((choice) => (
                <button
                  key={choice}
                  type="button"
                  className={`pm-callout-emoji-opt${choice === emoji ? " is-active" : ""}`}
                  onMouseDown={keepFocus}
                  onClick={() => pickEmoji(choice)}
                  aria-label={choice}
                >
                  {choice}
                </button>
              ))}
            </div>
            <button
              type="button"
              className="pm-callout-emoji-none"
              onMouseDown={keepFocus}
              onClick={() => pickEmoji("")}
            >
              无图标
            </button>
          </div>
        )}
      </span>

      {/* 正文:原生 PM 文本(paragraph+),IME 由 PM 处理,不嵌第二个编辑器 */}
      <NodeViewContent className="pm-callout-body" />

      {/* 主题选择器:右上角触发钮(当前主题色),hover/聚焦时显;点开为带名色板 */}
      <span className="pm-callout-themes-wrap" contentEditable={false} ref={themeWrapRef}>
        <button
          type="button"
          className="pm-callout-theme-trigger"
          style={{ background: activeTheme.swatch }}
          onMouseDown={keepFocus}
          onClick={() => {
            if (!editable) return;
            setThemeOpen((v) => !v);
          }}
          disabled={!editable}
          aria-label={`主题:${activeTheme.label}`}
          title={`主题:${activeTheme.label}`}
        />
        {themeOpen && (
          <div className="pm-callout-theme-pop" contentEditable={false}>
            {CALLOUT_THEMES.map((theme) => (
              <button
                key={theme.tone}
                type="button"
                className={`pm-callout-theme-opt${theme.tone === tone ? " is-active" : ""}`}
                onMouseDown={keepFocus}
                onClick={() => pickTone(theme.tone)}
                aria-label={theme.label}
              >
                <span className="pm-callout-theme-chip" style={{ background: theme.swatch }} />
                <span className="pm-callout-theme-label">{theme.label}</span>
              </button>
            ))}
          </div>
        )}
      </span>
    </NodeViewWrapper>
  );
}

/* ───────────── TipTap 扩展(扩展 base CalloutNode,只加 NodeView)─────────────
 * base 节点(attrs/parseHTML/renderHTML/序列化)留在 pm-schema 作单一真相;
 * 这里只叠加前端 NodeView(emoji 选择器 + 主题切换),不改数据与序列化。
 */
export const CalloutCM = CalloutNode.extend({
  addNodeView() {
    return ReactNodeViewRenderer(CalloutComponent as never);
  },
});
