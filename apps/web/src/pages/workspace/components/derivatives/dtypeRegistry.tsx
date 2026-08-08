import { useRef, type FC, type MutableRefObject, type ReactNode, type Ref } from "react";
import type { PmDoc } from "@qingagent/pm-schema";
import type { ActionCardData, DerivativeDtypeName } from "@qingagent/contract-ts";
import { PmBlockView, PmTextRendererProvider } from "../doc/PmStaticView";
import { PhoneShell } from "./PhoneShell";
import { DesktopShell } from "./DesktopShell";
import { XhsCover, type XhsCoverTemplate } from "./XhsCover";
import "./wechatPreview.css";
import "./xhsPreview.css";
import "./xhsOverrides.css";

/** dtype 集合以 contract 的母子技能映射表为单源:新增类型必须同时补齐本注册表。 */
export type DerivativeDtype = DerivativeDtypeName;

interface PreviewProps { doc: PmDoc; title: string; articleRef: Ref<HTMLElement>; coverTemplate?: XhsCoverTemplate; onCoverTemplateChange?: (template: XhsCoverTemplate) => void }

export interface DtypeDescriptor {
  dtype: DerivativeDtype;
  label: string;
  tabLabel: string;
  templates: { id: string; name: string; detail: string }[];
  queryText: (docId: string, targetLang?: string | null) => string;
  cardTitle: (regenerate: boolean) => string;
  deleteConfirm: { title: string; message: string };
  copyText: (article: HTMLElement | null) => { text: string; html?: string; toast: string };
  exportImageTarget?: (view: HTMLElement | null) => HTMLElement | null;
  PhonePreview?: FC<PreviewProps>;
  DesktopPreview?: FC<PreviewProps>;
  PlainPreview?: FC<PreviewProps>;
}

function PmBody({ doc }: { doc: PmDoc }) { return <>{doc.content.map((node, index) => <PmBlockView key={node.attrs.blockId ?? index} node={node}/>)}</>; }

function WechatArticle({ doc, title, articleRef }: { doc: PmDoc; title: string; articleRef: Ref<HTMLElement> }) {
  return <article ref={articleRef} className="wx-article rich_media_area_primary"><header><h1 className="rich_media_title">{title}</h1><div className="wx-meta rich_media_meta_list"><span className="wx-author rich_media_meta_nickname">青简</span><span className="rich_media_meta_text">刚刚</span><span className="rich_media_meta_text">广东</span></div></header><div id="js_content" className="rich_media_content"><PmBody doc={doc}/></div></article>;
}

function LineIcon({ kind }: { kind: "like" | "share" | "heart" | "comment" }) {
  const paths = {
    like: <path d="M8 20H4V9h4m0 11h8.2a2 2 0 0 0 1.9-1.4l2.3-7A2 2 0 0 0 18.5 9H14l.7-3.5A2.9 2.9 0 0 0 12 2L8 9v11Z"/>,
    share: <><path d="m14 4 6 5-6 5"/><path d="M20 9h-5.5C8.7 9 5 12.1 4 19"/></>,
    heart: <path d="M12 20S4 15.5 4 9.5A4.5 4.5 0 0 1 12 6a4.5 4.5 0 0 1 8 3.5C20 15.5 12 20 12 20Z"/>,
    comment: <><path d="M4 5h16v11H9l-5 4V5Z"/><path d="M12 8v5M9.5 10.5h5"/></>,
  };
  return <svg viewBox="0 0 24 24" aria-hidden="true">{paths[kind]}</svg>;
}

function ChevronBackIcon() {
  return <svg className="preview-chevron" viewBox="0 0 24 24" aria-hidden="true"><path d="m15 3-9 9 9 9"/></svg>;
}

function WechatMoreIcon() {
  return <svg className="wx-more-icon" viewBox="0 0 22 12" aria-hidden="true"><circle cx="3" cy="6" r="2"/><circle cx="11" cy="6" r="2"/><circle cx="19" cy="6" r="2"/></svg>;
}

function XhsShareIcon({ className = "xhs-share-icon" }: { className?: string }) {
  return <svg className={className} viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="m14 4 6 5-6 5"/><path d="M20 9h-5.5C8.7 9 5 12.1 4 19"/></svg>;
}

function WechatToolbar() { return <div className="wx-bottom-toolbar"><div className="wx-toolbar-account"><span className="wx-toolbar-avatar">青</span><strong>青简</strong></div><div className="wx-toolbar-actions"><span><LineIcon kind="like"/><small>赞</small></span><span><LineIcon kind="share"/><small>分享</small></span><span><LineIcon kind="heart"/><small>推荐</small></span><span><LineIcon kind="comment"/><small>写留言</small></span></div></div>; }

function WechatPhonePreview(props: PreviewProps) {
  return <PhoneShell><div className="wx-phone-content"><div className="wx-navbar"><span className="wx-back"><ChevronBackIcon/></span><strong>{props.title}</strong><span className="wx-more"><WechatMoreIcon/></span></div><div className="wx-phone-scroll"><WechatArticle {...props}/></div><WechatToolbar/></div></PhoneShell>;
}

function WechatDesktopPreview(props: PreviewProps) {
  return <DesktopShell><div className="wx-desktop" data-content-width="760"><WechatArticle {...props}/></div></DesktopShell>;
}

function XhsArticle({ doc, title, articleRef, coverTemplate = "poster", onCoverTemplateChange = () => undefined }: PreviewProps) {
  const localRef = useRef<HTMLElement | null>(null);
  const setRef = (node: HTMLElement | null) => {
    localRef.current = node;
    if (typeof articleRef === "function") articleRef(node);
    else if (articleRef) (articleRef as MutableRefObject<HTMLElement | null>).current = node;
  };
  return <article ref={setRef} className="xhs-article"><XhsCover title={title} template={coverTemplate} onTemplateChange={onCoverTemplateChange}/><h1>{title}</h1><div className="xhs-body"><PmTextRendererProvider renderText={renderXhsTopicText}><PmBody doc={doc}/></PmTextRendererProvider></div></article>;
}

function renderXhsTopicText(text: string): ReactNode {
  return text.split(/(#[\p{L}\p{N}_-]+)/gu).map((part, index) =>
    part.startsWith("#") ? <span key={index} className="xhs-topic">{part}</span> : part,
  );
}

function XhsNav() { return <div className="xhs-navbar"><span className="xhs-back"><ChevronBackIcon/></span><span className="xhs-avatar">青</span><strong>青简</strong><button type="button">关注</button><span className="xhs-share" aria-label="分享"><XhsShareIcon/></span></div>; }
function XhsIcon({ kind }: { kind: "like" | "collect" | "comment" | "share" }) {
  if (kind === "share") return <XhsShareIcon className="xhs-action-icon"/>;
  const paths = {
    like: <path d="M12 20.3S4.2 16 4.2 9.9c0-3.8 4.7-5.6 7.8-2.5 3.1-3.1 7.8-1.3 7.8 2.5 0 6.1-7.8 10.4-7.8 10.4Z"/>,
    collect: <path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2-5.6-2.9-5.6 2.9 1.1-6.2L3 9.6l6.2-.9L12 3Z"/>,
    comment: <path d="M4 5.5h16v10.8H9.2L4 20V5.5Z"/>,
  };
  return <svg className="xhs-action-icon" viewBox="0 0 24 24" aria-hidden="true">{paths[kind]}</svg>;
}
function XhsInteraction() { return <div className="xhs-interaction"><span>说点什么…</span><i><XhsIcon kind="like"/><small>128</small></i><i><XhsIcon kind="collect"/><small>56</small></i><i><XhsIcon kind="comment"/><small>23</small></i><i aria-label="分享"><XhsIcon kind="share"/></i></div>; }

function XhsPhonePreview(props: PreviewProps) {
  return <PhoneShell><div className="xhs-phone-content"><XhsNav/><div className="xhs-phone-scroll"><XhsArticle {...props}/></div><XhsInteraction/></div></PhoneShell>;
}

function XhsDesktopPreview(props: PreviewProps) {
  return <DesktopShell><div className="xhs-desktop"><div className="xhs-desktop-card" data-design-size="1040x642"><div className="xhs-desktop-media"><XhsCover title={props.title} template={props.coverTemplate ?? "poster"} onTemplateChange={props.onCoverTemplateChange ?? (() => undefined)}/></div><div className="xhs-desktop-content"><XhsNav/><div className="xhs-desktop-scroll"><XhsArticle {...props}/><div className="xhs-note-meta">3小时前 广东</div><div className="xhs-comments"><strong>共 0 条评论</strong><span>暂无评论</span></div></div><XhsInteraction/></div></div></div></DesktopShell>;
}

function TranslationPreview({ doc, articleRef }: PreviewProps) {
  return <article ref={articleRef} className="ws-translate-article doc-typography"><PmBody doc={doc}/></article>;
}

// 硬触发脚手架:只描述工具序列(防"承诺句停机"复发),具体纪律由 derivative_brief 返回的
// skillGuidance(衍生稿撰写子技能)承载,不在这里写死。
const routeSuffix = "先调 derivative_brief,按返回的 skillGuidance 纪律与模板、补充指令改写源文,再用 generate_derivative 提交。";

export function buildTranslationDisplayCard(languages: string[], style: string, privatePrompt: string): ActionCardData {
  const lines = [{ label: "语言", value: languages.join("、") }, { label: "风格", value: style }];
  if (privatePrompt.trim()) lines.push({ label: "补充", value: privatePrompt.trim() });
  return { title: "翻译文档", lines, status: "done" };
}

export interface TranslationQueryTarget {
  docId: string;
  targetLang: string;
}

/** 一条可见用户指令承载全部语种；doc_id 只负责沿用现有衍生稿路由，不引入新定位协议。 */
export function buildTranslationAgentQuery(
  targets: readonly TranslationQueryTarget[],
  regenerate = false,
): string {
  if (targets.length === 0) throw new Error("翻译目标不能为空");
  const languages = targets.map((target) => target.targetLang).join("、");
  const instruction = regenerate && targets.length === 1
    ? `重新生成${languages}翻译`
    : `把主文档翻译成${languages}`;
  const destinations = targets
    .map((target) => `${target.targetLang}写入衍生稿(doc_id: ${target.docId})`)
    .join("，");
  return `${instruction}。${destinations}。按上述顺序逐个处理：对每篇稿件${routeSuffix}`;
}

export const DTYPE_REGISTRY = {
  gzh: {
    dtype: "gzh", label: "公众号稿", tabLabel: "公众号文章",
    templates: [{ id: "gzh-opinion", name: "深度观点文", detail: "观点鲜明、论证完整，适合行业读者深度阅读。" }, { id: "gzh-tutorial", name: "干货教程文", detail: "步骤清楚、示例具体，方便读者直接照做。" }, { id: "gzh-story", name: "故事叙事文", detail: "用冲突和转折承载观点，增强阅读张力。" }],
    queryText: (docId) => `为衍生稿(doc_id: ${docId})生成公众号稿:${routeSuffix}`,
    cardTitle: (regenerate) => `${regenerate ? "重新" : ""}生成公众号稿`,
    deleteConfirm: { title: "删除这篇公众号稿？", message: "删除后不可恢复" },
    copyText: (article) => ({
      text: article?.innerText?.trim() ?? article?.textContent?.trim() ?? "",
      html: article?.outerHTML ?? "",
      toast: "已复制公众号排版",
    }),
    exportImageTarget: (view) => view?.querySelector<HTMLElement>(".wx-article") ?? null,
    PhonePreview: WechatPhonePreview, DesktopPreview: WechatDesktopPreview,
  },
  xhs: {
    dtype: "xhs", label: "小红书稿", tabLabel: "小红书笔记",
    templates: [{ id: "xhs-recommend", name: "种草安利", detail: "真实体验式安利，兼顾痛点、效果与可信度。" }, { id: "xhs-checklist", name: "干货清单", detail: "收藏向清单结构，重点突出且操作信息具体。" }, { id: "xhs-experience", name: "亲历分享", detail: "按亲历过程展开，用失败、细节与结果建立真实感。" }],
    queryText: (docId) => `为衍生稿(doc_id: ${docId})生成小红书稿:${routeSuffix}`,
    cardTitle: (regenerate) => `${regenerate ? "重新" : ""}生成小红书稿`,
    deleteConfirm: { title: "删除这篇小红书稿？", message: "删除后不可恢复" },
    copyText: (article) => {
      const title = article?.querySelector(":scope > h1")?.textContent?.trim() ?? "";
      // 列表项由 PmStaticView 渲染为 li > p；只收实际文字块，避免父 li 与子 p 各复制一次。
      const blocks = Array.from(
        article?.querySelectorAll(".xhs-body p, .xhs-body h2, .xhs-body h3") ?? [],
      ).map((node) => node.textContent?.trim()).filter(Boolean);
      return {
        text: `${title}\n\n${blocks.join("\n\n")}`,
        toast: "已复制小红书文案",
      };
    },
    exportImageTarget: (view) => view?.querySelector<HTMLElement>(".xhs-desktop-media .xhs-cover, .xhs-cover") ?? null,
    PhonePreview: XhsPhonePreview, DesktopPreview: XhsDesktopPreview,
  },
  translate: {
    dtype: "translate", label: "翻译", tabLabel: "翻译",
    templates: [
      { id: "translate-faithful", name: "忠实精准", detail: "结构对应、术语括注、不增不减" },
      { id: "translate-native", name: "母语化改写", detail: "像目标语言母语者写的" },
      { id: "translate-business", name: "正式商务", detail: "书面商务文体、敬语规范" },
    ],
    queryText: (docId, targetLang) => buildTranslationAgentQuery([{
      docId,
      targetLang: targetLang ?? "目标语言",
    }], true),
    cardTitle: (regenerate) => `${regenerate ? "重新" : ""}翻译文档`,
    deleteConfirm: { title: "删除这份译文？", message: "只删除当前语言，删除后不可恢复" },
    copyText: (article) => ({ text: article?.innerText.trim() ?? "", toast: "已复制译文" }),
    PlainPreview: TranslationPreview,
  },
} satisfies Record<DerivativeDtype, DtypeDescriptor>;

export function getDtypeDescriptor(dtype: string): DtypeDescriptor {
  return DTYPE_REGISTRY[dtype as DerivativeDtype] ?? DTYPE_REGISTRY.gzh;
}
