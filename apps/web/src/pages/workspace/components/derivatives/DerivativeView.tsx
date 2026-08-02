import { useEffect, useMemo, useRef, useState } from "react";
import { normalizeStoredPmDoc, type PmDoc } from "@qingagent/pm-schema";
import type { ActionCardData } from "@qingagent/contract-ts";
import { useConfirm } from "../../../../system";
import type { ServerStream } from "../../data/serverStream";
import { QingLoading } from "../QingLoading";
import { DerivativeGenerateModal, type DerivativeGenerateParams } from "./DerivativeGenerateModal";
import { getDtypeDescriptor } from "./dtypeRegistry";
import { exportElementAsPng } from "./exportElementAsPng";
import type { XhsCoverTemplate } from "./XhsCover";
import type { DerivativeDocument, DerivativeItem } from "./types";

function textOf(node: unknown): string {
  if (!node || typeof node !== "object") return "";
  const value = node as { text?: unknown; content?: unknown[] };
  return `${typeof value.text === "string" ? value.text : ""}${Array.isArray(value.content) ? value.content.map(textOf).join("") : ""}`;
}

function articleTitle(doc: PmDoc | null, fallback: string): string {
  const heading = doc?.content.find((node) => node.type === "heading" && Number(node.attrs?.level ?? 0) === 1);
  return heading ? textOf(heading) || fallback : fallback;
}

export function streamingQingmlToParagraphs(raw: string): string[] {
  const withoutTags = raw
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(?:h[1-6]|p|blockquote|li|ul|ol|pre|table|tr)>/gi, "\n\n")
    .replace(/<[^>]*>/g, "");
  const decoded = withoutTags.replace(
    /&(?:amp|lt|gt|quot|apos|nbsp|#39|#x27|#\d+|#x[0-9a-f]+);/gi,
    (entity) => {
      const named: Record<string, string> = {
        "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": "\"",
        "&apos;": "'", "&#39;": "'", "&#x27;": "'", "&nbsp;": " ",
      };
      const normalized = entity.toLowerCase();
      const namedValue = named[normalized];
      if (namedValue !== undefined) return namedValue;
      const hex = normalized.match(/^&#x([0-9a-f]+);$/i);
      const decimal = normalized.match(/^&#(\d+);$/);
      const codePoint = Number.parseInt(hex?.[1] ?? decimal?.[1] ?? "", hex ? 16 : 10);
      return Number.isInteger(codePoint) && codePoint >= 0 && codePoint <= 0x10ffff
        ? String.fromCodePoint(codePoint)
        : entity;
    },
  );
  return decoded.split(/\n{2,}/).map((paragraph) => paragraph.trim()).filter(Boolean);
}

function RegenIcon() { return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19 8a8 8 0 1 0 .45 6.6"/><path d="M19 4v4h-4"/></svg>; }
function ExportIcon() { return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v11"/><path d="m8 10 4 4 4-4"/><path d="M5 16v4h14v-4"/></svg>; }
function MoreIcon() { return <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/></svg>; }

type TranslationGenerationState = {
  status: "streaming" | "failed" | "aborted";
  text: string;
  reason?: string;
};

const EMPTY_TRANSLATION_GEN = new Map<string, TranslationGenerationState>();

export function DerivativeView(props: {
  sessionId: string; item: DerivativeItem; items?: DerivativeItem[]; stream: ServerStream; streamActive: boolean; generatingInitially?: boolean;
  initialDocument?: DerivativeDocument | null;
  translationGen?: ReadonlyMap<string, TranslationGenerationState>;
  onRefresh: () => Promise<void>; onDeleted: () => void; onToast: (text: string) => void;
  onSendQuery: (text: string, displayCard: ActionCardData) => void;
  activeDocId?: string;
  onActiveDocIdChange?: (docId: string) => void;
  isStaleDismissed?: (item: DerivativeItem) => boolean;
  onDismissStale?: (item: DerivativeItem) => void;
}) {
  const confirm = useConfirm();
  const [selectedDocId, setSelectedDocId] = useState(props.item.docId);
  const effectiveDocId = props.activeDocId ?? selectedDocId;
  const item = props.items?.find((candidate) => candidate.docId === effectiveDocId) ?? props.item;
  const descriptor = getDtypeDescriptor(item.dtype);
  const isTranslation = descriptor.dtype === "translate";
  const translationGen = props.translationGen ?? EMPTY_TRANSLATION_GEN;
  const translationState = translationGen.get(item.docId);
  const [document, setDocument] = useState<DerivativeDocument | null>(
    props.initialDocument ?? null,
  );
  const [mode, setMode] = useState<"phone" | "desktop">("phone");
  const [generating, setGenerating] = useState(Boolean(props.generatingInitially));
  const [generationBefore, setGenerationBefore] = useState<string | null>(item.generatedAt);
  const [generationComplete, setGenerationComplete] = useState(false);
  const [abortedEmpty, setAbortedEmpty] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [translationFlightKeys, setTranslationFlightKeys] = useState<ReadonlySet<string>>(() => new Set());
  const [coverTemplate, setCoverTemplate] = useState<XhsCoverTemplate>(item.coverTemplate ?? "poster");
  const articleRef = useRef<HTMLElement>(null);
  const viewRef = useRef<HTMLElement>(null);
  const exportRef = useRef<HTMLDivElement>(null);
  const moreRef = useRef<HTMLDivElement>(null);
  const streamingTextRef = useRef<HTMLDivElement>(null);
  const streamActiveRef = useRef(props.streamActive);
  const sawActiveRef = useRef(props.streamActive);
  const documentRequestGenerationRef = useRef(0);
  const coverTemplateRequestGenerationRef = useRef(0);
  const translationFlightsRef = useRef(new Map<string, Promise<void>>());
  useEffect(() => {
    if (!props.items?.length || props.items.some((candidate) => candidate.docId === effectiveDocId)) return;
    setSelectedDocId(props.items[0]!.docId);
    props.onActiveDocIdChange?.(props.items[0]!.docId);
  }, [effectiveDocId, props.items, props.onActiveDocIdChange]);
  useEffect(() => {
    props.onActiveDocIdChange?.(item.docId);
  }, [item.docId, props.onActiveDocIdChange]);
  useEffect(() => {
    const requestGeneration = documentRequestGenerationRef.current + 1;
    documentRequestGenerationRef.current = requestGeneration;
    let current = true;
    if (props.initialDocument?.meta.docId === item.docId) {
      setDocument(props.initialDocument);
    } else {
      setDocument((existing) =>
        existing?.meta.docId === item.docId ? existing : null,
      );
    }
    void props.stream
      .getDerivativeDoc(props.sessionId, item.docId)
      .then((next) => {
        if (
          current &&
          documentRequestGenerationRef.current === requestGeneration &&
          next?.meta.docId === item.docId
        ) {
          setDocument(next);
        }
      })
      .catch((error) => {
        if (
          !current ||
          documentRequestGenerationRef.current !== requestGeneration
        ) {
          return;
        }
        console.error("[workspace] load derivative document failed", error);
        props.onToast("稿件加载失败，请重试");
      });
    return () => { current = false; };
  }, [
    item.docId,
    item.generatedAt,
    props.initialDocument,
    props.sessionId,
    props.stream,
  ]);
  useEffect(() => { streamActiveRef.current = props.streamActive; if (props.streamActive) sawActiveRef.current = true; }, [props.streamActive]);
  useEffect(() => { if (generating && generationComplete && !props.streamActive) setGenerating(false); }, [generating, generationComplete, props.streamActive]);
  useEffect(() => { if (item.generatedAt != null || item.sourceVersion != null) setAbortedEmpty(false); }, [item.generatedAt, item.sourceVersion]);
  useEffect(() => {
    coverTemplateRequestGenerationRef.current += 1;
    setCoverTemplate(item.coverTemplate ?? "poster");
  }, [item.coverTemplate, item.docId]);
  useEffect(() => {
    if (!exportOpen) return;
    const close = (event: MouseEvent) => { if (!exportRef.current?.contains(event.target as Node)) setExportOpen(false); };
    window.document.addEventListener("mousedown", close);
    return () => window.document.removeEventListener("mousedown", close);
  }, [exportOpen]);
  useEffect(() => {
    if (!moreOpen) return;
    const close = (event: MouseEvent) => { if (!moreRef.current?.contains(event.target as Node)) setMoreOpen(false); };
    window.document.addEventListener("mousedown", close);
    return () => window.document.removeEventListener("mousedown", close);
  }, [moreOpen]);
  useEffect(() => {
    if (isTranslation || !generating) return;
    let stopped = false;
    const started = Date.now();
    const poll = async () => {
      const next = await props.stream.getDerivativeDoc(props.sessionId, item.docId).catch(() => null);
      if (stopped) return;
      if (next?.meta.docId === item.docId && next.meta.generatedAt && next.meta.generatedAt !== generationBefore) {
        setDocument(next); setGenerationComplete(true); setAbortedEmpty(false); await props.onRefresh();
        if (!streamActiveRef.current) setGenerating(false);
        return;
      }
      if (Date.now() - started > 180_000) { setGenerating(false); props.onToast("生成仍在进行，请稍后查看"); return; }
      if (next === null) {
        window.setTimeout(poll, 2000);
        return;
      }
      if (next.meta.generatedAt === generationBefore && !streamActiveRef.current && (sawActiveRef.current || Date.now() - started >= 4_000)) {
        setGenerating(false);
        if (generationBefore == null) setAbortedEmpty(true);
        else props.onToast("生成已中止，保留原稿");
        void props.onRefresh();
        return;
      }
      window.setTimeout(poll, 2000);
    };
    const timer = window.setTimeout(poll, 2000);
    return () => { stopped = true; window.clearTimeout(timer); };
  }, [generating, generationBefore, isTranslation, item.docId, props.sessionId, props.stream]);
  useEffect(() => {
    if (translationState?.status !== "streaming" || !translationState.text) return;
    const element = streamingTextRef.current;
    if (!element) return;
    element.scrollTop = element.scrollHeight;
  }, [translationState?.status, translationState?.text]);

  const pmDoc = useMemo(() => document && document.docVersion > 0 ? normalizeStoredPmDoc(JSON.parse(document.docPm)) : null, [document]);
  const title = articleTitle(pmDoc, descriptor.label);
  const translationFlightKey = `${props.sessionId}:${item.docId}`;
  const translationSubmitting = translationFlightKeys.has(translationFlightKey);
  const generateTranslationSingleFlight = (docId: string): Promise<void> => {
    const flightKey = `${props.sessionId}:${docId}`;
    const currentFlight = translationFlightsRef.current.get(flightKey);
    if (currentFlight) return currentFlight;
    const flight = Promise.resolve().then(
      () => props.stream.generateTranslations(props.sessionId, [docId]),
    );
    translationFlightsRef.current.set(flightKey, flight);
    setTranslationFlightKeys((current) => new Set(current).add(flightKey));
    const finish = () => {
      if (translationFlightsRef.current.get(flightKey) !== flight) return;
      translationFlightsRef.current.delete(flightKey);
      setTranslationFlightKeys((current) => {
        const next = new Set(current);
        next.delete(flightKey);
        return next;
      });
    };
    void flight.then(finish, finish);
    return flight;
  };
  const beginGenerate = async (params: DerivativeGenerateParams) => {
    try {
      await props.stream.createDerivative(props.sessionId, descriptor.dtype, params.templateId, params.privatePrompt, params.writingStyleId, params.layoutStyleId, item.targetLang ?? undefined);
      await props.onRefresh();
    } catch (error) {
      console.error("[workspace] update derivative params failed", error);
      props.onToast("生成参数保存失败，请重试");
      return;
    }
    if (isTranslation) {
      setModalOpen(false);
      try {
        await generateTranslationSingleFlight(item.docId);
      } catch (error) {
        console.error("[workspace] regenerate translation failed", error);
        props.onToast("重新翻译失败，请重试");
      }
      return;
    }
    const before = item.generatedAt;
    setModalOpen(false); setAbortedEmpty(false); setGenerationComplete(false); setGenerationBefore(before); sawActiveRef.current = props.streamActive; setGenerating(true);
    const templateName = descriptor.templates.find((template) => template.id === params.templateId)?.name ?? params.templateId;
    const lines = item.dtype === "translate" ? [{ label: "语言", value: item.targetLang ?? "目标语言" }, { label: "风格", value: templateName }] : [{ label: "写作风格", value: templateName }];
    if (params.privatePrompt.trim()) lines.push({ label: "补充", value: params.privatePrompt.trim() });
    props.onSendQuery(descriptor.queryText(item.docId, item.targetLang), { title: descriptor.cardTitle(before != null), lines });
  };
  const deleteDraft = async () => {
    setMoreOpen(false);
    if (translationState?.status === "streaming") return;
    if (!await confirm({ ...descriptor.deleteConfirm, confirmLabel: "删除", cancelLabel: "取消" })) return;
    try {
      await props.stream.deleteDerivative(props.sessionId, item.docId);
      props.onDeleted();
    } catch (error) {
      console.error("[workspace] delete derivative failed", error);
      props.onToast("删除失败，请重试");
    }
  };
  const PhonePreview = descriptor.PhonePreview;
  const DesktopPreview = descriptor.DesktopPreview;
  const PlainPreview = descriptor.PlainPreview;
  const copyDraft = () => {
    setExportOpen(false);
    const copy = descriptor.copyText(articleRef.current);
    void navigator.clipboard.writeText(copy.text).then(() => props.onToast(copy.toast)).catch(() => props.onToast("复制失败，请重试"));
  };
  const exportImage = () => {
    setExportOpen(false);
    const target = descriptor.exportImageTarget?.(viewRef.current);
    if (!target) { props.onToast("当前稿件没有可导出的图片"); return; }
    void exportElementAsPng(target, `${descriptor.label}-${item.targetLang ?? title}`).then(() => props.onToast("图片已导出")).catch((error) => {
      console.error("[workspace] export derivative image failed", error);
      props.onToast("图片导出失败，请重试");
    });
  };
  const changeCoverTemplate = (next: XhsCoverTemplate) => {
    const previous = coverTemplate;
    const requestGeneration = coverTemplateRequestGenerationRef.current + 1;
    coverTemplateRequestGenerationRef.current = requestGeneration;
    setCoverTemplate(next);
    void props.stream.updateDerivativeCoverTemplate(props.sessionId, item.docId, next).catch((error) => {
      if (coverTemplateRequestGenerationRef.current !== requestGeneration) {
        return;
      }
      console.error("[workspace] persist cover template failed", error);
      setCoverTemplate((current) => (current === next ? previous : current));
      props.onToast("封面选择保存失败，请重试");
    });
  };
  const previewProps = { doc: pmDoc!, title, articleRef, coverTemplate, onCoverTemplateChange: changeCoverTemplate };
  const toolbar = <div className="ws-deriv-toolbar">
    <div className="ws-deriv-actions">
      <div className="ws-deriv-regen-anchor">
        {item.stale && !props.isStaleDismissed?.(item) ? <div className="workspace-tooltip is-visible ws-deriv-stale-tip" data-placement="top">源文档已更新，可重新生成<button aria-label="关闭提示" onClick={() => props.onDismissStale?.(item)}>×</button></div> : null}
        <button className="ws-docfn-btn" title="重新生成" aria-label="重新生成" onClick={() => setModalOpen(true)}><RegenIcon/></button>
      </div>
      {document?.docVersion ? <div className="ws-export-anchor" ref={exportRef}><button className="ws-docfn-btn" title="导出" aria-label="导出" onClick={() => { setMoreOpen(false); setExportOpen((value) => !value); }}><ExportIcon/></button>
        {exportOpen ? <div className="ws-export-menu" role="menu"><button className="ws-export-item" onClick={copyDraft}>复制文案</button>{descriptor.exportImageTarget ? <button className="ws-export-item" onClick={exportImage}>导出图片</button> : null}</div> : null}
      </div> : null}
      <div className="ws-export-anchor" ref={moreRef}><button className="ws-docfn-btn" title="更多操作" aria-label="更多操作" onClick={() => { setExportOpen(false); setMoreOpen((value) => !value); }}><MoreIcon/></button>
        {moreOpen ? <div className="ws-export-menu" role="menu"><button className="ws-export-item is-danger" disabled={translationState?.status === "streaming"} title={translationState?.status === "streaming" ? "生成中不可删除" : undefined} onClick={() => void deleteDraft()}>删除稿件</button></div> : null}
      </div>
    </div>
  </div>;
  const modal = <DerivativeGenerateModal descriptor={descriptor} sessionId={props.sessionId} stream={props.stream} open={modalOpen} singleTargetLang={item.targetLang ?? undefined} submitting={isTranslation && (translationSubmitting || translationState?.status === "streaming")} initial={{ templateId: item.templateId, writingStyleId: item.writingStyleId, layoutStyleId: item.layoutStyleId, targetLanguages: item.targetLang ? [item.targetLang] : undefined, privatePrompt: item.privatePrompt }} onClose={() => setModalOpen(false)} onGenerate={beginGenerate}/>;

  if (!isTranslation && generating) return <section className="ws-deriv-view is-generating" data-glow-surface="derivative-paper"><div className="ws-editor-glow" data-wf="DerivativeEditorGlow" aria-hidden="true"/><QingLoading reasoning /></section>;
  if (!isTranslation && (abortedEmpty || (item.sourceVersion == null && !document?.meta.generatedAt))) return <section className="ws-deriv-view">{toolbar}<div className="ws-deriv-empty"><strong>{abortedEmpty ? "生成已中止" : "尚未生成"}</strong><div className="ws-deriv-empty-actions"><button className="ws-deriv-primary" onClick={() => setModalOpen(true)}>重新生成</button></div></div>{modal}</section>;
  const translationParagraphs = translationState?.status === "streaming"
    ? streamingQingmlToParagraphs(translationState.text)
    : [];
  return <section ref={viewRef} className={`ws-deriv-view ws-deriv-${descriptor.dtype}${mode === "phone" ? " is-phone" : " is-desktop"}`} data-glow-surface={isTranslation && translationState?.status === "streaming" ? "derivative-paper" : undefined}>
    {isTranslation && translationState?.status === "streaming" ? <div className="ws-editor-glow" data-wf="DerivativeEditorGlow" aria-hidden="true"/> : null}
    {toolbar}
    {isTranslation && props.items?.length ? <div className="ws-deriv-mode ws-translate-segmented" aria-label="译文语言切换">{props.items.map((candidate) => {
      const status = translationGen.get(candidate.docId)?.status;
      return <button key={candidate.docId} className={candidate.docId === item.docId ? "is-active" : ""} onClick={() => { setSelectedDocId(candidate.docId); props.onActiveDocIdChange?.(candidate.docId); setGenerating(false); setAbortedEmpty(false); setGenerationBefore(candidate.generatedAt); }}><span>{candidate.targetLang ?? "译文"}</span>{status ? <i className={`ws-translate-status is-${status}`} aria-hidden="true"/> : null}</button>;
    })}</div> : null}
    {isTranslation && translationState?.status === "streaming" ? <div ref={streamingTextRef} className="ws-deriv-streaming-paper is-generating">{translationParagraphs.length > 0 ? <article className="ws-translate-stream-text" aria-live="polite">{translationParagraphs.map((paragraph, index) => <p key={`${index}-${paragraph.slice(0, 12)}`}>{paragraph}</p>)}</article> : <QingLoading reasoning />}</div>
      : isTranslation && (translationState?.status === "failed" || translationState?.status === "aborted") ? <div className="ws-translate-failed" role="status"><strong>{translationState.status === "aborted" ? "翻译已中止" : "翻译未完成"}</strong><button className="ws-deriv-primary" disabled={translationSubmitting} onClick={() => void generateTranslationSingleFlight(item.docId).catch(() => props.onToast("重新翻译未完成，请重试"))}>{translationSubmitting ? "重试中" : "重试"}</button></div>
        : isTranslation && !pmDoc ? <div className="ws-deriv-empty"><strong>该语言还没有译文</strong><div className="ws-deriv-empty-actions"><button className="ws-deriv-primary" onClick={() => setModalOpen(true)}>生成该语言</button></div></div>
          : pmDoc && PlainPreview ? <PlainPreview {...previewProps}/> : pmDoc && mode === "phone" && PhonePreview ? <><div className="ws-deriv-mode"><button className="is-active" onClick={() => setMode("phone")}>手机</button><button onClick={() => setMode("desktop")}>电脑</button></div><PhonePreview {...previewProps}/></> : pmDoc && DesktopPreview ? <><div className="ws-deriv-mode"><button onClick={() => setMode("phone")}>手机</button><button className="is-active" onClick={() => setMode("desktop")}>电脑</button></div><DesktopPreview {...previewProps}/></> : null}
    {modal}
  </section>;
}
