import { Extension, InputRule, Mark, Node, type AnyExtension } from "@tiptap/core";
import type { Node as PmModelNode } from "@tiptap/pm/model";
import type { EditorState } from "@tiptap/pm/state";
import { Plugin } from "@tiptap/pm/state";
import Highlight from "@tiptap/extension-highlight";
import Image from "@tiptap/extension-image";
import Link from "@tiptap/extension-link";
import { OrderedList, TaskItem, TaskList } from "@tiptap/extension-list";
import { BlockMath, InlineMath } from "@tiptap/extension-mathematics";
import Placeholder from "@tiptap/extension-placeholder";
import { Table, TableCell, TableHeader, TableRow } from "@tiptap/extension-table";
import TextAlign from "@tiptap/extension-text-align";
import Underline from "@tiptap/extension-underline";
import StarterKit from "@tiptap/starter-kit";
import { PM_CALLOUT_TONES, PM_IMAGE_ALIGN_VALUES, PM_ORDERED_LIST_STYLES, PM_SCHEMA_NODE_NAMES } from "../spec";
import { isAllowedImageSrc, isAllowedLinkHref, isAllowedThemeColor } from "../validators";
import { DedupeBlockIds } from "./dedupeBlockIds";
export { APPLYING_REMOTE_META, createDedupeBlockIdsTransaction } from "./dedupeBlockIds";

export function getQingagentTiptapNodeNames(): readonly string[] {
  return PM_SCHEMA_NODE_NAMES;
}

export type MathClickHandler = (info: {
  kind: "inline" | "block";
  latex: string;
  pos: number;
}) => void;

export function createQingagentExtensions(options: {
	  codeBlockExtension?: AnyExtension;
	  /** 前端注入带 NodeView(对齐 / resize / 全屏)的 image 扩展;不传则用 base 节点(静态)。 */
	  imageExtension?: AnyExtension;
	  /** 前端注入带 NodeView(mermaid 实时渲染 + 源码编辑)的 diagram 扩展;不传则用 base 节点(静态)。 */
	  diagramExtension?: AnyExtension;
  /** 前端注入带 NodeView(emoji 选择器 + 主题切换 chrome)的 callout 扩展;不传则用 base 节点(静态 renderHTML)。 */
  calloutExtension?: AnyExtension;
  /** 前端注入带 NodeView(分隔线 resize)的分栏容器扩展;不传则用 base 节点(静态 flex)。 */
  columnListExtension?: AnyExtension;
  /** 前端注入的 column 扩展(配合 columnListExtension);不传则用 base 节点。 */
  columnExtension?: AnyExtension;
  /** 点击公式时回调(用于前端弹出 LaTeX 编辑浮层);不传则公式只读展示。 */
  onMathClick?: MathClickHandler;
} = {}) {
  const headingLevels: Array<1 | 2 | 3 | 4 | 5 | 6> = [1, 2, 3, 4, 5, 6];
  const starterKitOptions = {
    heading: { levels: headingLevels },
    code: { HTMLAttributes: { class: "inline-code" } },
    ...(options.codeBlockExtension ? { codeBlock: false as const } : {}),
    orderedList: false as const,
    link: false as const,
    underline: false as const,
    // StarterKit 的 trailingNode 会在 "# " 输入规则转换后立刻补一个空段落。
    // 标题可作为文档末尾;列表仍保留默认尾段,否则会破坏 Enter/Backspace 退出列表的既有行为。
    // columnList 内部可继续编辑,不需要 trailingNode 另补空段;否则分栏 DnD 的单事务 undo
    // 会被 trailingNode 追加事务污染。
    trailingNode: { notAfter: ["heading", "columnList"] },
    // 拖拽排序时的落点指示线:金色加粗,暗色皮肤下可见(StarterKit 自带 dropcursor)。
    // 配 class 以便列表/分栏自绘落点线时压制它(否则原生 dropcursor 默认无 class、压制选择器
    // 匹配不到,会在嵌套 gap 里和自绘线同时出现两根线)。变细到 1.5px 与自绘线观感一致。
    dropcursor: { color: "#c8a96a", width: 1.5, class: "wf-dropcursor" },
  };
  const extensions: AnyExtension[] = [
    // 列表类型切换规则放最前(且 priority 高于 StarterKit):已在列表项里输入另一种前缀
    // 即切换整条列表类型(对齐飞书);不在对应列表时放行,StarterKit 仍负责空段落起新列表。
    QingagentListSwitch,
    StarterKit.configure(starterKitOptions),
    QingagentOrderedList,
    ...(options.codeBlockExtension ? [options.codeBlockExtension] : []),
    QingagentBlockAttrs,
    QingagentHeadingAttrs,
    Underline,
    Link.configure({
      // 导航由编辑器 click handler 门控:普通点击弹链接气泡,Cmd/Ctrl+点击才打开。
      openOnClick: false,
      HTMLAttributes: { target: "_blank", rel: "noopener noreferrer", class: null },
      isAllowedUri: (url) => isAllowedLinkHref(url),
      shouldAutoLink: (url) => isAllowedLinkHref(url),
    }),
    TextColorMark,
    Highlight.extend({
      addAttributes() {
        return {
          color: {
            default: null,
            parseHTML: (element) =>
              readThemeColor(element.getAttribute("data-color")),
            renderHTML: (attributes) =>
              attributes.color ? { "data-color": attributes.color } : {},
          },
        };
      },
    }).configure({ multicolor: true }),
    TextAlign.configure({ types: ["heading", "paragraph"] }),
    options.imageExtension ?? QingagentImage,
    options.diagramExtension ?? DiagramNode,
    FileAttachmentNode,
    PenNoteNode,
    // 待办:TaskItem 自带输入规则,行首敲 "[] "/"[x] " 即转待办项(对齐飞书快捷输入)。
    TaskList,
    QingagentTaskItem.configure({ nested: true }),
    options.calloutExtension ?? CalloutNode,
    options.columnListExtension ?? ColumnListNode,
    options.columnExtension ?? ColumnNode,
    // 公式:KaTeX 渲染;输入规则 $$latex$$(行内)/$$$latex$$$(块级)。
    QingagentBlockMath.configure({
      // displayMode 必开:块级公式走 KaTeX 展示模式(居中大号),且 align/aligned/cases 等
      // 环境只在 display mode 下合法;@tiptap/extension-mathematics 的块级 nodeView 不会替我们
      // 注入 displayMode,漏了它块级公式就退化成行内模式,\begin{align} 直接解析报错(红字源码)。
      katexOptions: { throwOnError: false, displayMode: true },
      ...(options.onMathClick
        ? {
            onClick: (node: PmModelNode, pos: number) =>
              options.onMathClick?.({ kind: "block", latex: String(node.attrs.latex ?? ""), pos }),
          }
        : {}),
    }),
    QingagentInlineMath.configure({
      katexOptions: { throwOnError: false },
      ...(options.onMathClick
        ? {
            onClick: (node: PmModelNode, pos: number) =>
              options.onMathClick?.({ kind: "inline", latex: String(node.attrs.latex ?? ""), pos }),
          }
        : {}),
    }),
    Table.configure({ resizable: true }),
    TableRow,
    TableHeaderWithBackground,
    TableCellWithBackground,
    RejectNestedTableTransactions,
    DedupeBlockIds,
    // 占位符(对齐飞书):空标题显示"几级标题",空文档首段给一句轻提示;其余空块返回空串不显示,
    // 避免每个空行都冒字。showOnlyWhenEditable 默认 true,只读快照视图不显示。
    Placeholder.configure({
      showOnlyCurrent: false,
      placeholder: ({ node, editor }) => {
        if (node.type.name === "heading") {
          const level = Number(node.attrs?.level) || 1;
          const cn = ["", "一级", "二级", "三级", "四级", "五级", "六级"][level] ?? "";
          return `${cn}标题`;
        }
        if (node.type.name === "paragraph" && editor?.isEmpty) {
          return "输入正文,或点左侧 + 插入其他块";
        }
        return "";
      },
    }),
  ];
  return extensions;
}

function readThemeColor(value: unknown): string | null {
  return isAllowedThemeColor(value) ? String(value) : null;
}

const TextColorMark = Mark.create({
  name: "textColor",

  parseHTML() {
    return [{ tag: "span[data-text-color]" }];
  },

  renderHTML({ HTMLAttributes }) {
    return ["span", HTMLAttributes, 0];
  },

  addAttributes() {
    return {
      color: {
        default: null,
        parseHTML: (element) => readThemeColor(element.getAttribute("data-text-color")),
        renderHTML: (attributes) =>
          attributes.color ? { "data-text-color": attributes.color } : {},
      },
    };
  },
});

const tableCellBackgroundAttribute = {
  backgroundColor: {
    default: null,
    parseHTML: (element: HTMLElement) => readThemeColor(element.getAttribute("data-bg-color")),
    renderHTML: (attributes: { backgroundColor?: unknown }) =>
      attributes.backgroundColor ? { "data-bg-color": attributes.backgroundColor } : {},
  },
};

const TABLE_CELL_CONTENT = "(paragraph|heading|blockquote|bulletList|orderedList|horizontalRule|codeBlock|image|diagram|fileAttachment|penNote|taskList|callout|columnList|blockMath)+";

const TableCellWithBackground = TableCell.extend({
  content: TABLE_CELL_CONTENT,

  addAttributes() {
    return {
      ...this.parent?.(),
      ...tableCellBackgroundAttribute,
    };
  },
});

const TableHeaderWithBackground = TableHeader.extend({
  content: TABLE_CELL_CONTENT,

  addAttributes() {
    return {
      ...this.parent?.(),
      ...tableCellBackgroundAttribute,
    };
  },
});

function hasNestedTable(doc: PmModelNode): boolean {
  let nested = false;
  doc.descendants((node) => {
    if (node.type.spec.tableRole !== "cell" && node.type.spec.tableRole !== "header_cell") return !nested;
    node.descendants((child) => {
      if (child.type.spec.tableRole === "table") nested = true;
      return !nested;
    });
    return !nested;
  });
  return nested;
}

const RejectNestedTableTransactions = Extension.create({
  name: "rejectNestedTableTransactions",

  addProseMirrorPlugins() {
    return [new Plugin({
      filterTransaction: (transaction) => !transaction.docChanged || !hasNestedTable(transaction.doc),
    })];
  },
});

const blockTypes = [
  "paragraph",
  "heading",
  "blockquote",
  "bulletList",
  "orderedList",
  "listItem",
  "horizontalRule",
  "codeBlock",
  "table",
  "image",
  "diagram",
  "fileAttachment",
  "penNote",
  "taskList",
  "taskItem",
  "callout",
  "columnList",
  "column",
  "blockMath",
];

const QingagentBlockAttrs = Extension.create({
  name: "qingagentBlockAttrs",

  addGlobalAttributes() {
    return [
      {
        types: blockTypes,
        attributes: {
          blockId: {
            default: null,
            parseHTML: (element) => element.getAttribute("data-block-id"),
            renderHTML: (attrs) => (attrs.blockId ? { "data-block-id": attrs.blockId } : {}),
          },
        },
      },
    ];
  },
});

const QingagentHeadingAttrs = Extension.create({
  name: "qingagentHeadingAttrs",

  addGlobalAttributes() {
    return [
      {
        types: ["heading"],
        attributes: {
          anchor: {
            default: null,
            parseHTML: (element) => element.getAttribute("id"),
            renderHTML: (attrs) => (attrs.anchor ? { id: attrs.anchor } : {}),
          },
        },
      },
    ];
  },
});

const QingagentImage = Image.extend({
  name: "image",

  parseHTML() {
    return [
      {
        tag: "img[src]",
        getAttrs: (element) => {
          const src = element instanceof HTMLElement ? element.getAttribute("src") ?? "" : "";
          return isAllowedImageSrc(src) ? null : false;
        },
      },
    ];
  },

	  addAttributes() {
	    return {
	      src: {
	        default: null,
	        parseHTML: (element) => element.getAttribute("src"),
	      },
	      alt: {
	        default: null,
	        parseHTML: (element) => element.getAttribute("alt"),
	      },
	      title: {
	        default: null,
	        parseHTML: (element) => element.getAttribute("title"),
	      },
	      caption: {
	        default: null,
	        parseHTML: (element) => element.getAttribute("data-caption"),
	      },
	      width: {
	        default: null,
	        parseHTML: (element) => parsePositiveImageSize(element.getAttribute("width") ?? element.style.width),
	      },
	      height: {
	        default: null,
	        parseHTML: (element) => parsePositiveImageSize(element.getAttribute("height") ?? element.style.height),
	      },
	      align: {
	        default: "center",
	        parseHTML: (element) => parseImageAlign(element),
	      },
	      uploading: {
	        default: null,
	        parseHTML: () => null,
	        renderHTML: () => ({}),
	      },
	      progress: {
	        default: null,
	        parseHTML: () => null,
	        renderHTML: () => ({}),
	      },
	      error: {
	        default: null,
	        parseHTML: () => null,
	        renderHTML: () => ({}),
	      },
	      preview: {
	        default: null,
	        parseHTML: () => null,
	        renderHTML: () => ({}),
	      },
	    };
	  },

	  renderHTML({ node, HTMLAttributes }) {
	    return ["img", imageHtmlAttributes({ ...HTMLAttributes, ...node.attrs })];
	  },

  addCommands() {
    return {
      setImage:
        (options) =>
        ({ commands }) => {
          if (!isAllowedImageSrc(options.src)) return false;
          return commands.insertContent({ type: this.name, attrs: options });
        },
    };
  },
	});

type ImageAlign = (typeof PM_IMAGE_ALIGN_VALUES)[number];

function normalizeImageAlign(value: unknown): ImageAlign {
  return PM_IMAGE_ALIGN_VALUES.includes(value as ImageAlign) ? (value as ImageAlign) : "center";
}

function parseImageAlign(element: HTMLElement): ImageAlign {
  const explicit = element.getAttribute("data-align");
  if (PM_IMAGE_ALIGN_VALUES.includes(explicit as ImageAlign)) return explicit as ImageAlign;
  const marginLeft = element.style.marginLeft;
  const marginRight = element.style.marginRight;
  if (marginLeft === "auto" && marginRight === "auto") return "center";
  if (marginLeft === "auto") return "right";
  if (marginRight === "auto") return "left";
  return "center";
}

function parsePositiveImageSize(value: string | null): number | null {
  if (!value) return null;
  const match = value.trim().match(/^(\d+(?:\.\d+)?)(?:px)?$/);
  const n = Number(match?.[1] ?? NaN);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
}

function imageHtmlAttributes(attrs: Record<string, unknown>): Record<string, string> {
  const align = normalizeImageAlign(attrs.align);
  const width = typeof attrs.width === "number" && Number.isFinite(attrs.width) && attrs.width > 0
    ? Math.round(attrs.width)
    : null;
  const height = typeof attrs.height === "number" && Number.isFinite(attrs.height) && attrs.height > 0
    ? Math.round(attrs.height)
    : null;
  const styleParts = ["max-width:100%", "height:auto", "display:block"];
  if (width) styleParts.push(`width:${width}px`);
  if (align === "center") styleParts.push("margin-left:auto", "margin-right:auto");
  if (align === "left") styleParts.push("margin-right:auto");
  if (align === "right") styleParts.push("margin-left:auto");
  const out: Record<string, string> = {
    src: typeof attrs.src === "string" ? attrs.src : "",
    "data-align": align,
    style: styleParts.join("; "),
  };
  if (typeof attrs.alt === "string") out.alt = attrs.alt;
  if (typeof attrs.title === "string") out.title = attrs.title;
  if (typeof attrs.caption === "string" && attrs.caption) out["data-caption"] = attrs.caption;
  if (width) out.width = String(width);
  if (height) out.height = String(height);
  return out;
}

const QingagentTaskItem = TaskItem.extend({
  content: "paragraph block*",
});

type OrderedListStyle = (typeof PM_ORDERED_LIST_STYLES)[number];

function normalizeOrderedListStyle(value: unknown): OrderedListStyle {
  return (PM_ORDERED_LIST_STYLES as readonly unknown[]).includes(value) ? (value as OrderedListStyle) : "decimal";
}

function readOrderedListStyle(element: HTMLElement): OrderedListStyle {
  const css = element.style.listStyleType || element.getAttribute("data-list-style");
  if (css) return normalizeOrderedListStyle(css);
  switch (element.getAttribute("type")) {
    case "a":
      return "lower-alpha";
    case "A":
      return "upper-alpha";
    case "i":
      return "lower-roman";
    case "I":
      return "upper-roman";
    default:
      return "decimal";
  }
}

const QingagentOrderedList = OrderedList.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      listStyle: {
        default: "decimal",
        parseHTML: (element: HTMLElement) => readOrderedListStyle(element),
        renderHTML: (attrs: { listStyle?: unknown }) => {
          const listStyle = normalizeOrderedListStyle(attrs.listStyle);
          return listStyle === "decimal"
            ? { "data-list-style": "decimal" }
            : { "data-list-style": listStyle, style: `list-style-type: ${listStyle}` };
        },
      },
    };
  },
});

/**
 * 诊断 p02:penNote 在 PM spec/validator/AI-IR 编译/提示词全链路被声明为合法块,
 * 唯独可编辑 TipTap schema 没有注册——模型用它、服务端存它,前端 setContent 抛
 * `Unknown node type: penNote`,编辑器渲染成空白(用户看到"整篇被清空")。
 * 这里补齐与 PM spec(penNote: group block, content inline*)对齐的真实节点。
 */
const PenNoteNode = Node.create({
  name: "penNote",
  group: "block",
  content: "inline*",

  parseHTML() {
    return [{ tag: "aside[data-pm-node='penNote']" }];
  },

  renderHTML({ HTMLAttributes }) {
    return ["aside", { ...HTMLAttributes, "data-pm-node": "penNote", class: "pm-pen-note" }, 0];
  },
});

/**
 * 行内公式输入规则加空白守卫:上游规则 /(?<!\$)(\$\$([^$\n]+?)\$\$)(?!\$)/ 会把
 * "$$50 and $$60" 这类美元金额误转成 inlineMath("50 and ")。对齐 markdown-it-katex
 * 启发式:开定界符后、闭定界符前不允许空白(p-loop R1 角度A发现的真实误转)。
 */
const QingagentInlineMath = InlineMath.extend({
  parseHTML() {
    return [
      { tag: 'span[data-type="inline-math"]' },
      { tag: 'span[data-type="inlineMath"]' },
    ];
  },

  addInputRules() {
    return [
      new InputRule({
        find: /(?<!\$)\$\$(?!\s)([^$\n]+?)(?<!\s)\$\$(?!\$)/,
        handler: ({ state, range, match }) => {
          const latex = match[1];
          if (!latex) return;
          state.tr.replaceWith(range.from, range.to, this.type.create({ latex }));
        },
      }),
      new InputRule({
        find: /(?<!\$)\$(?!\s)([^$\n]+?)(?<!\s)\$(?!\$)/,
        handler: ({ state, range, match }) => {
          const latex = match[1];
          if (!latex) return;
          state.tr.replaceWith(range.from, range.to, this.type.create({ latex }));
        },
      }),
    ];
  },
});

const QingagentBlockMath = BlockMath.extend({
  parseHTML() {
    return [
      { tag: 'div[data-type="block-math"]' },
      { tag: 'div[data-type="blockMath"]' },
    ];
  },
});

/**
 * 列表类型切换(对齐飞书快捷输入):已在列表项里时,行首输入另一种前缀即切换整条列表类型——
 * 无序列表里输 "1. " → 有序;有序列表里输 "- " / "* " / "+ " → 无序。
 * priority 设为高于 StarterKit(默认 100),保证本规则先于 StarterKit 的列表 wrapping 规则被
 * handleTextInput 尝试(否则在 bullet 列表里输 "1. " 会被 StarterKit 误包成嵌套有序列表)。
 * 切换复用 tiptap 原生 toggleOrderedList/toggleBulletList(内部 setNodeMarkup + 合并相邻同类
 * 列表),与文档工具栏按钮完全一致;不在对应类型列表内时返回 null 放行——StarterKit 继续负责
 * "空段落里输 '- '/'1. ' 起新列表"。
 */
const QingagentListSwitch = Extension.create({
  name: "qingagentListSwitch",
  priority: 200,
  addInputRules() {
    // 最近的列表祖先是否为指定类型(嵌套列表时只认光标最内层那条)
    const closestListIsType = (state: EditorState, typeName: string) => {
      const { $from } = state.selection;
      for (let depth = $from.depth; depth > 0; depth--) {
        const name = $from.node(depth).type.name;
        if (name === "bulletList" || name === "orderedList") {
          return name === typeName;
        }
      }
      return false;
    };
    const switchRule = (
      find: RegExp,
      fromName: string,
      toggle: "toggleOrderedList" | "toggleBulletList",
    ) =>
      new InputRule({
        find,
        handler: ({ state, range, chain }) => {
          if (!closestListIsType(state, fromName)) return null;
          // 删掉刚输入的前缀,再用原生命令切换列表类型;chain 在 input rule 上下文里只累积
          // 到共享 tr、由 plugin 统一 dispatch。切换成功交给 plugin 提交,失败则返回 null 丢弃整个 tr。
          const c = chain().deleteRange(range);
          const ok = toggle === "toggleOrderedList" ? c.toggleOrderedList().run() : c.toggleBulletList().run();
          return ok ? undefined : null;
        },
      });
    return [
      switchRule(/^1\.\s$/, "bulletList", "toggleOrderedList"),
      switchRule(/^\s*[-*+]\s$/, "orderedList", "toggleBulletList"),
    ];
  },
});

/**
 * Callout 高亮框:emoji + tone(语义色) + 段落内容。样式由前端 .pm-callout 类承载,
 * 节点只保证结构与数据;与 PM spec(callout: content paragraph+)对齐。
 */
export const CalloutNode = Node.create({
  name: "callout",
  group: "block",
  content: "paragraph+",
  defining: true,

  addAttributes() {
    return {
      emoji: {
        default: "💡",
        parseHTML: (element) => element.getAttribute("data-emoji"),
        renderHTML: (attrs) => (attrs.emoji ? { "data-emoji": attrs.emoji } : {}),
      },
      tone: {
        default: "info",
        parseHTML: (element) => {
          const tone = element.getAttribute("data-tone");
          return tone && (PM_CALLOUT_TONES as readonly string[]).includes(tone) ? tone : "info";
        },
        renderHTML: (attrs) => (attrs.tone ? { "data-tone": attrs.tone } : {}),
      },
    };
  },

  parseHTML() {
    // contentElement 限定内容只来自 body 容器,避免把 emoji 装饰 span 当正文解析。
    return [{ tag: "div[data-pm-node='callout']", contentElement: "div.pm-callout-body" }];
  },

  renderHTML({ HTMLAttributes, node }) {
    const tone = typeof node.attrs.tone === "string" ? node.attrs.tone : "info";
    return [
      "div",
      {
        ...HTMLAttributes,
        "data-pm-node": "callout",
        class: `pm-callout pm-callout--${tone}`,
      },
      ["span", { class: "pm-callout-emoji", contenteditable: "false" }, String(node.attrs.emoji ?? "💡")],
      ["div", { class: "pm-callout-body" }, 0],
    ];
  },
});

/**
 * 内容分栏:columnList(顶层容器,含 2+ 个 column)+ column(容纳任意块,带 widthRatio 宽度占比)。
 * 这是 base 节点(静态 flex 并排渲染);分隔线 resize / 拖拽建栏-塌栏由前端注入版承载。
 * isolating:防删除/合并跨栏越界。样式由 .pm-column-list / .pm-column 承载。
 */
export const ColumnNode = Node.create({
  name: "column",
  content: "block+",
  isolating: true,

  addAttributes() {
    return {
      widthRatio: {
        default: null,
        parseHTML: (element) => {
          const v = element.getAttribute("data-width-ratio");
          const n = v ? Number(v) : NaN;
          return Number.isFinite(n) && n > 0 ? n : null;
        },
        renderHTML: (attrs) =>
          attrs.widthRatio != null ? { "data-width-ratio": String(attrs.widthRatio) } : {},
      },
    };
  },

  parseHTML() {
    return [{ tag: "div[data-pm-node='column']" }];
  },

  renderHTML({ HTMLAttributes, node }) {
    const ratio = typeof node.attrs.widthRatio === "number" ? node.attrs.widthRatio : null;
    return [
      "div",
      {
        ...HTMLAttributes,
        "data-pm-node": "column",
        class: "pm-column",
        ...(ratio != null ? { style: `flex: ${ratio} 1 0%` } : {}),
      },
      0,
    ];
  },
});

export const ColumnListNode = Node.create({
  name: "columnList",
  group: "block",
  content: "column column+",
  isolating: true,

  parseHTML() {
    return [{ tag: "div[data-pm-node='columnList']" }];
  },

  renderHTML({ HTMLAttributes }) {
    return ["div", { ...HTMLAttributes, "data-pm-node": "columnList", class: "pm-column-list" }, 0];
  },
});

/**
 * 图表块(diagram):承载 lang(mermaid)+ source 源码 + svg 渲染缓存的原子块。
 * 这是 base 节点(静态:渲染 svg 缓存或源码降级);前端通过 createQingagentExtensions 的
 * diagramExtension 注入带 NodeView 的版本做 mermaid 实时渲染 + 源码编辑。
 * svg 只存 PM JSON(客户端重渲),不进 HTML 序列化(避免 clipboard 巨大)。
 */
const DiagramNode = Node.create({
  name: "diagram",
  group: "block",
  atom: true,

  addAttributes() {
    return {
      lang: {
        default: "mermaid",
        parseHTML: (element) => element.getAttribute("data-lang") ?? "mermaid",
        renderHTML: (attrs) => ({ "data-lang": attrs.lang ?? "mermaid" }),
      },
      source: {
        default: "",
        parseHTML: (element) => element.getAttribute("data-source") ?? element.textContent ?? "",
        renderHTML: (attrs) => ({ "data-source": attrs.source ?? "" }),
      },
      // svg 不参与 HTML 解析/序列化(仅 PM JSON 内携带,前端按 source 重渲)。
      svg: { default: null, parseHTML: () => null, renderHTML: () => ({}) },
      height: {
        default: null,
        parseHTML: (element) => parsePositiveImageSize(element.getAttribute("data-height")),
        renderHTML: (attrs) =>
          typeof attrs.height === "number" && attrs.height > 0
            ? { "data-height": String(Math.round(attrs.height)) }
            : {},
      },
      overlay: {
        default: null,
        parseHTML: (element) => parseJsonAttr(element.getAttribute("data-overlay")),
        renderHTML: (attrs) => {
          const value = stringifyJsonAttr(attrs.overlay);
          return value ? { "data-overlay": value } : {};
        },
      },
    };
  },

  parseHTML() {
    return [{ tag: "div[data-pm-node='diagram']" }];
  },

  renderHTML({ HTMLAttributes, node }) {
    // 静态序列化:输出 data 属性 + 源码文本兜底(无 DOM/客户端时仍可见图表来源)。
    return ["div", { ...HTMLAttributes, "data-pm-node": "diagram", class: "pm-diagram" }, String(node.attrs.source ?? "")];
  },
});

function parseJsonAttr(value: string | null): unknown {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function stringifyJsonAttr(value: unknown): string | null {
  if (value == null) return null;
  try {
    return JSON.stringify(value);
  } catch {
    return null;
  }
}

const FileAttachmentNode = Node.create({
  name: "fileAttachment",
  group: "block",
  atom: true,

  addAttributes() {
    return {
      fileId: { default: null },
      filename: { default: null },
      mimeType: { default: null },
      size: { default: 0 },
    };
  },

  parseHTML() {
    return [{ tag: "a[data-pm-node='fileAttachment']" }];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      "a",
      {
        ...HTMLAttributes,
        "data-pm-node": "fileAttachment",
        href: `/api/v1/files/${HTMLAttributes.fileId}`,
      },
      HTMLAttributes.filename ?? "attachment",
    ];
  },
});
