import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactElement,
} from "react";
import { createPortal } from "react-dom";
import { mergeAttributes, textblockTypeInputRule } from "@tiptap/core";
import type { NodeViewRendererProps } from "@tiptap/core";
import { CodeBlockLowlight } from "@tiptap/extension-code-block-lowlight";
import {
  NodeViewContent,
  NodeViewWrapper,
  ReactNodeViewRenderer,
} from "@tiptap/react";
import type { NodeViewContentProps } from "@tiptap/react";
import { common, createLowlight } from "lowlight";

/* ───────────── Language registry ───────────── */

interface LangEntry {
  label: string;
}

const LANGUAGES: Record<string, LangEntry> = {
  javascript: { label: "JavaScript" },
  typescript: { label: "TypeScript" },
  python: { label: "Python" },
  java: { label: "Java" },
  cpp: { label: "C/C++" },
  csharp: { label: "C#" },
  go: { label: "Go" },
  rust: { label: "Rust" },
  kotlin: { label: "Kotlin" },
  swift: { label: "Swift" },
  php: { label: "PHP" },
  ruby: { label: "Ruby" },
  html: { label: "HTML" },
  css: { label: "CSS" },
  json: { label: "JSON" },
  yaml: { label: "YAML" },
  toml: { label: "TOML" },
  xml: { label: "XML" },
  sql: { label: "SQL" },
  bash: { label: "Bash/Shell" },
  dockerfile: { label: "Dockerfile" },
  graphql: { label: "GraphQL" },
  markdown: { label: "Markdown" },
  plaintext: { label: "Plain Text" },
};

// Aliases for input rule matching (e.g. ```js => javascript)
const LANG_ALIASES: Record<string, string> = {
  js: "javascript",
  jsx: "javascript",
  ts: "typescript",
  tsx: "typescript",
  py: "python",
  c: "cpp",
  "c++": "cpp",
  cs: "csharp",
  kt: "kotlin",
  rb: "ruby",
  yml: "yaml",
  sh: "bash",
  shell: "bash",
  zsh: "bash",
  md: "markdown",
  txt: "plaintext",
  text: "plaintext",
  plain: "plaintext",
};

// 别名先归一,否则**原样保留**模型/生成给的语言标签(小写)。只有真正空才 plaintext。
// 旧逻辑『白名单否则 plaintext』会把 yaml/groovy/vue/svelte/hcl 等误杀成 plaintext——
// 候选预览直吐 data-language 故正确,进编辑器走本函数被压扁(回归 fmt-codeblock-lang-mismatch)。
// lowlight 能高亮的(common 集)自动高亮,不能高亮的也保住正确 language attr 与下拉显示。
function resolveLanguage(lang: string | null | undefined): string {
  if (!lang) return "plaintext";
  const lower = lang.toLowerCase().trim();
  if (!lower) return "plaintext";
  if (LANG_ALIASES[lower]) return LANG_ALIASES[lower]!;
  return lower;
}

export const codeBlockLowlight = createLowlight(common);
const PreNodeViewContent = NodeViewContent as (
  props: NodeViewContentProps<"pre">,
) => ReactElement;

/* ───────────── React NodeView Component ───────────── */

interface CodeBlockNodeViewProps {
  editor: NodeViewRendererProps["editor"];
  node: NodeViewRendererProps["node"];
  updateAttributes: (attrs: Record<string, unknown>) => void;
}

/** 当前语言的显示名:内置清单用其 label,否则原样显示语言串。 */
function languageLabel(language: string): string {
  return LANGUAGES[language]?.label ?? language;
}

/**
 * 代码块语言选择器:自定义下拉(非原生 <select>)。
 * 关键:原生 <select> 会把全部 24 个 <option> 语言标签**常驻**在编辑器内容 DOM 里,
 * 即使闭合态也污染正文 innerText / 可访问树(e2e R17/R18/R19 三轮复现:含代码块的文档
 * 字数被全部语言名灌水、屏读遍历正文时念出全语言列表)。这里闭合态正文只留一个显示当前
 * 语言名的按钮(role=combobox),选项菜单仅在展开时通过 portal 挂到 document.body(正文树之外)、
 * 关闭即卸载——彻底不污染正文。菜单不在 ProseMirror 内容流里,不进文档序列化/字数统计。
 */
function LanguageSelect(props: {
  editable: boolean;
  language: string;
  onSelect: (lang: string) => void;
}): ReactElement {
  const { editable, language, onSelect } = props;
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; right: number }>({
    top: 0,
    right: 0,
  });
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  // 展开时按按钮位置把菜单定位到视口(fixed),右对齐(按钮在代码块右上角)。
  useLayoutEffect(() => {
    if (!open) return;
    const rect = buttonRef.current?.getBoundingClientRect();
    if (rect) {
      setPos({
        top: rect.bottom + 4,
        right: Math.max(8, window.innerWidth - rect.right),
      });
    }
  }, [open]);

  // 展开时:点击菜单与按钮之外 / 按 Esc / 滚动 → 关闭。
  useEffect(() => {
    if (!open) return;
    const onDocPointer = (e: PointerEvent) => {
      const t = e.target as Node | null;
      if (
        t &&
        (menuRef.current?.contains(t) || buttonRef.current?.contains(t))
      )
        return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    const onScroll = (e: Event) => {
      const t = e.target as Node | null;
      if (t && menuRef.current?.contains(t)) return;
      setOpen(false);
    };
    document.addEventListener("pointerdown", onDocPointer, true);
    document.addEventListener("keydown", onKey, true);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      document.removeEventListener("pointerdown", onDocPointer, true);
      document.removeEventListener("keydown", onKey, true);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [open]);

  // 当前语言不在内置清单时,菜单里额外置顶一条它自身,确保可见可选回。
  const keys = Object.keys(LANGUAGES);
  const optionKeys = LANGUAGES[language] ? keys : [language, ...keys];

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className="code-block-language-select"
        contentEditable={false}
        aria-label="代码语言"
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={!editable}
        // 阻止 mousedown 改动 ProseMirror 选区/光标,保持节点稳定。
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => {
          if (!editable) return;
          setOpen((v) => !v);
        }}
      >
        {languageLabel(language)}
      </button>
      {editable &&
        open &&
        createPortal(
          <div
            ref={menuRef}
            className="code-block-language-menu"
            role="listbox"
            contentEditable={false}
            style={{ position: "fixed", top: pos.top, right: pos.right }}
            onPointerDown={(e) => e.stopPropagation()}
            onWheel={(e) => e.stopPropagation()}
          >
            {optionKeys.map((key) => (
              <button
                key={key}
                type="button"
                role="option"
                aria-selected={key === language}
                className="code-block-language-option"
                data-active={key === language ? "true" : undefined}
                onMouseDown={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                }}
                onClick={() => {
                  onSelect(key);
                  setOpen(false);
                }}
              >
                {languageLabel(key)}
              </button>
            ))}
          </div>,
          document.body,
        )}
    </>
  );
}

function CodeBlockComponent(props: CodeBlockNodeViewProps) {
  const { editor, node, updateAttributes } = props;
  const language = resolveLanguage(node.attrs.language as string);

  const onSelect = useCallback(
    (lang: string) => {
      if (!editor.isEditable) return;
      updateAttributes({ language: resolveLanguage(lang) });
    },
    [editor, updateAttributes],
  );

  return (
    <NodeViewWrapper className="code-block-node" data-language={language}>
      <LanguageSelect
        editable={editor.isEditable}
        language={language}
        onSelect={onSelect}
      />
      <PreNodeViewContent
        as="pre"
        className={`language-${language}`}
        data-language={language}
        spellCheck={false}
      />
    </NodeViewWrapper>
  );
}

/* ───────────── TipTap Extension ───────────── */

// Input rule: ```lang + space/newline triggers code block
const backtickInputRegex = /^```([^`\s]*)[\s\n]$/;

export const CodeBlockCM = CodeBlockLowlight.extend({
  name: "codeBlock",

  addAttributes() {
    return {
      ...this.parent?.(),
      language: {
        default: "plaintext",
        parseHTML: (element: HTMLElement) => {
          const dataLang = element.getAttribute("data-language");
          if (dataLang) return resolveLanguage(dataLang);

          const code = element.querySelector("code");
          const className = code?.className ?? "";
          const match = /language-([^\s]+)/.exec(className);
          return resolveLanguage(match?.[1] ?? null);
        },
        rendered: false,
      },
    };
  },

  renderHTML({ node, HTMLAttributes }) {
    const language = resolveLanguage(node.attrs.language as string);

    return [
      "pre",
      mergeAttributes(this.options.HTMLAttributes, HTMLAttributes, {
        "data-language": language,
      }),
      ["code", { class: `language-${language}` }, 0],
    ];
  },

  addNodeView() {
    return ReactNodeViewRenderer(CodeBlockComponent as never, {
      contentDOMElementTag: "code",
    });
  },

  addInputRules() {
    return [
      textblockTypeInputRule({
        find: backtickInputRegex,
        type: this.type,
        getAttributes: (match: RegExpMatchArray) => ({
          language: resolveLanguage(match[1]),
        }),
      }),
    ];
  },
}).configure({
  lowlight: codeBlockLowlight,
  defaultLanguage: "plaintext",
  languageClassPrefix: "language-",
  HTMLAttributes: {},
});
