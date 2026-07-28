import { useEffect, useRef, useState } from "react";
import type { AssetSource } from "../data/sources";
import { FileIcon, fileKind } from "./AssetPanel";

export interface AssetPreviewProps {
  source: AssetSource;
  /** Active session ID, required for scoped material text fetching. */
  sessionId: string | null;
  onClose: () => void;
  /** 用户编辑并保存摘要时回调(materialId, 新摘要)。不传则摘要只读。 */
  onEditSummary?: (materialId: string, summary: string) => boolean;
  summaryEditDisabled?: boolean;
  /** 退场中:由父级在 previewSource 清空后短暂保留挂载并置 true,触发出场动画再卸载。 */
  closing?: boolean;
}

/** Determine the content preview mode from tag + mimeType. */
function previewMode(
  source: AssetSource,
): "pdf" | "image" | "text" | "unsupported" {
  if (source.tag === "pdf" || source.mimeType?.startsWith("application/pdf")) {
    return "pdf";
  }
  if (
    source.tag === "png" ||
    source.mimeType?.startsWith("image/")
  ) {
    return "image";
  }
  if (
    source.tag === "yuque" ||
    source.tag === "feishu" ||
    source.mimeType?.startsWith("text/") ||
    source.mimeType?.includes("json") ||
    source.mimeType?.includes("markdown")
  ) {
    return "text";
  }
  // If there is body text from static data, show as text
  if (source.bodyText) return "text";
  return "unsupported";
}

export function AssetPreview({
  source,
  sessionId,
  onClose,
  onEditSummary,
  summaryEditDisabled = false,
  closing = false,
}: AssetPreviewProps) {
  const mode = previewMode(source);
  const showSummary = !source.preview;

  return (
    <div
      className={`fd-right-preview${closing ? " is-closing" : ""}`}
      data-wf="AssetPreview"
      role="region"
      aria-label="素材预览"
    >
      <div className="fd-rp-head">
        <span className="fd-rp-ficon" aria-hidden="true">
          <FileIcon kind={fileKind(source.name, source.mimeType)} />
        </span>
        <span className="fd-rp-title">{source.name}</span>
        <button
          type="button"
          className="fd-rp-x"
          aria-label="关闭预览"
          onClick={onClose}
        >
          ×
        </button>
      </div>
      <div className="fd-rp-body">
        {source.sourceUrl && (
          <div>
            <div className="fd-rp-section-label">来源</div>
            <a
              href={source.sourceUrl}
              target="_blank"
              rel="noreferrer"
              style={{
                display: "block",
                fontSize: 12.5,
                color: "var(--ink-2)",
                wordBreak: "break-all",
                textDecoration: "underline",
                textUnderlineOffset: 3,
              }}
            >
              {source.sourceUrl}
            </a>
          </div>
        )}
        {showSummary && (
          onEditSummary ? (
            <SummaryEditor
              key={source.id}
              source={source}
              onEditSummary={onEditSummary}
              disabled={summaryEditDisabled}
            />
          ) : (
            source.abstract && (
              <div>
                <div className="fd-rp-section-label">摘要</div>
                <div className="fd-rp-abs">{source.abstract}</div>
              </div>
            )
          )
        )}

        <PreviewContent source={source} sessionId={sessionId} mode={mode} />
      </div>
    </div>
  );
}

/** 摘要区:直接是输入框,光标定进去就能改,失焦(blur)自动保存(内容变了才发命令)。
 *  按 source.id 作 key 重挂载,切换素材时自动重置。 */
function SummaryEditor({
  source,
  onEditSummary,
  disabled,
}: {
  source: AssetSource;
  onEditSummary: (materialId: string, summary: string) => boolean;
  disabled: boolean;
}) {
  const [value, setValue] = useState(source.abstract);
  const savedRef = useRef(source.abstract);
  useEffect(() => {
    setValue(source.abstract);
    savedRef.current = source.abstract;
  }, [source.abstract]);

  const save = () => {
    const next = value.trim();
    if (next === savedRef.current) return; // 没改不发命令
    if (onEditSummary(source.id, next)) {
      savedRef.current = next;
    } else {
      setValue(savedRef.current);
    }
  };

  return (
    <div>
      <div className="fd-rp-section-label">摘要</div>
      <textarea
        className="fd-rp-sum-ta"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onBlur={save}
        disabled={disabled}
        placeholder="点此直接编辑摘要…"
        rows={3}
      />
    </div>
  );
}

function PreviewContent({
  source,
  sessionId,
  mode,
}: {
  source: AssetSource;
  sessionId: string | null;
  mode: "pdf" | "image" | "text" | "unsupported";
}) {
  const contentUrl = previewContentUrl(source);

  if (mode === "pdf" && contentUrl) {
    if (source.fileId && !source.preview) {
      return <PdfWithTextTabs source={source} sessionId={sessionId} pdfUrl={contentUrl} />;
    }
    return <PdfFrame source={source} pdfUrl={contentUrl} />;
  }

  if (mode === "image" && contentUrl) {
    return (
      <div>
        <div className="fd-rp-section-label">图片预览</div>
        <img
          src={contentUrl}
          alt={source.name}
          style={{
            maxWidth: "100%",
            borderRadius: 0,
            border: "1px solid var(--line-1)",
          }}
        />
      </div>
    );
  }

  if (mode === "text") {
    return <TextPreview source={source} sessionId={sessionId} />;
  }

  return (
    <div>
      <div className="fd-rp-section-label">预览</div>
      <div className="fd-rp-body-text" style={{ color: "var(--ink-3)", fontStyle: "italic" }}>
        预览不可用
      </div>
    </div>
  );
}

function previewContentUrl(source: AssetSource): string | null {
  if (source.preview?.kind === "url") return source.preview.url;
  if (source.fileId) return `/api/v1/files/${source.fileId}`;
  return null;
}

function PdfFrame({ source, pdfUrl }: { source: AssetSource; pdfUrl: string }) {
  const { objectUrl, loading, unavailable } = useValidatedPdfUrl(pdfUrl);
  return (
    <div>
      <div className="fd-rp-section-label">PDF 原件</div>
      {loading ? (
        <PreviewStatus>加载中...</PreviewStatus>
      ) : unavailable || !objectUrl ? (
        <PreviewStatus unavailable>预览不可用</PreviewStatus>
      ) : (
        <PdfIframe source={source} objectUrl={objectUrl} />
      )}
    </div>
  );
}

/** PDF 素材:tab 切换「PDF 原件」/「提取文本」(提取文本 = 后端存的素材正文全文)。 */
function PdfWithTextTabs({
  source,
  sessionId,
  pdfUrl,
}: {
  source: AssetSource;
  sessionId: string | null;
  pdfUrl: string;
}) {
  // 默认展示「提取文本」:正文流式渲染、整页顺滑滚动;PDF 原件 iframe 很卡(浏览器 PDF viewer),
  // 改成点了才渲染,默认就不加载它。
  const [tab, setTab] = useState<"pdf" | "text">("text");
  const tabBtn = (key: "pdf" | "text", label: string) => (
    <button
      type="button"
      onClick={() => setTab(key)}
      style={{
        padding: "4px 14px",
        borderRadius: 0,
        border: "1px solid var(--line-1)",
        background: tab === key ? "var(--ink-1)" : "transparent",
        color: tab === key ? "#fff" : "var(--ink-2)",
        cursor: "pointer",
        fontSize: 13,
        fontFamily: "var(--font-display)",
      }}
    >
      {label}
    </button>
  );
  // 全文/摘要缓存在父级:切 tab 时下面的展示层(TextPane)可随 key 自由重挂播动画,而正文不丢。
  const { text, summary, loading, unavailable } = useMaterialText(source, sessionId);
  return (
    <div style={{ display: "flex", flexDirection: "column" }}>
      <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
        {tabBtn("pdf", "PDF 原件")}
        {tabBtn("text", "提取文本")}
      </div>
      {/* key={tab}:切 tab 时整块重挂 → 触发淡入滑入动画;数据在父级缓存,不会丢正文。 */}
      <div key={tab} className="fd-tab-pane">
        {tab === "pdf" ? (
          <PdfFrame source={source} pdfUrl={pdfUrl} />
        ) : (
          <TextPane
            text={text}
            summary={summary}
            loading={loading}
            unavailable={unavailable}
            abstract={source.abstract}
          />
        )}
      </div>
    </div>
  );
}

/** 顶部"摘要"(source.abstract)与接口返回的 summary 同源(都是 material.summary),
 *  内容相同时只显示一处,避免同一段摘要在"摘要"和"AI 摘要"两个区块渲染两遍。 */
export function shouldShowAiSummary(summary: string | null, abstract: string): boolean {
  return Boolean(summary) && summary !== abstract;
}

/** 拉取素材正文全文 + AI 摘要。内部 Material 全文只能从接口拿；bodyText 仅供
 *  没有 scoped 请求上下文的静态来源使用。调用方把结果放在父级缓存，切 tab 时不丢正文。 */
function useMaterialText(source: AssetSource, sessionId: string | null) {
  const previewTextUrl = source.preview?.kind === "url"
    ? source.preview.textUrl ?? source.preview.url
    : null;
  const fetchesInternalMaterial = !previewTextUrl && Boolean(source.id && sessionId);
  const staticBodyText = !previewTextUrl && !fetchesInternalMaterial
    ? source.bodyText ?? ""
    : "";
  const [text, setText] = useState<string>(staticBodyText);
  const [summary, setSummary] = useState<string | null>(null);
  const [loading, setLoading] = useState(fetchesInternalMaterial || Boolean(previewTextUrl));
  const [unavailable, setUnavailable] = useState(false);
  const strictTextContentType = source.preview?.kind === "url" &&
    source.preview.strictTextContentType === true;

  useEffect(() => {
    if (previewTextUrl) {
      let cancelled = false;
      setLoading(true);
      setText("");
      setSummary(null);
      setUnavailable(false);
      fetch(previewTextUrl)
        .then((res) => {
          if (!res.ok) throw new Error("not found");
          if (strictTextContentType && !isTextualContentType(res.headers.get("Content-Type"))) {
            throw new Error("unsupported text preview");
          }
          return res.text();
        })
        .then((body) => {
          if (cancelled) return;
          setText(body);
        })
        .catch(() => {
          if (cancelled) return;
          setText("");
          setSummary(null);
          setUnavailable(true);
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
      return () => {
        cancelled = true;
      };
    }

    if (!source.id || !sessionId) {
      setText(staticBodyText);
      setSummary(null);
      setLoading(false);
      setUnavailable(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setText("");
    setSummary(null);
    setUnavailable(false);
    fetch(`/api/v1/materials/${source.id}/text?sessionId=${encodeURIComponent(sessionId)}`)
      .then((res) => {
        if (!res.ok) throw new Error("not found");
        return res.json() as Promise<{ text: string; summary: string | null }>;
      })
      .then((data) => {
        if (cancelled) return;
        setText(data.text ?? "");
        setSummary(data.summary ?? null);
      })
      .catch(() => {
        if (cancelled) return;
        setText("");
        setSummary(null);
        setUnavailable(true);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [
    previewTextUrl,
    sessionId,
    source.id,
    source.updatedAt,
    staticBodyText,
    strictTextContentType,
  ]);

  return { text, summary, loading, unavailable };
}

function useValidatedPdfUrl(pdfUrl: string): {
  objectUrl: string | null;
  loading: boolean;
  unavailable: boolean;
} {
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [unavailable, setUnavailable] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let createdObjectUrl: string | null = null;
    setObjectUrl(null);
    setLoading(true);
    setUnavailable(false);

    fetch(pdfUrl)
      .then(async (response) => {
        if (!response.ok) throw new Error("pdf unavailable");
        if (!isPdfContentType(response.headers.get("Content-Type"))) {
          throw new Error("invalid pdf content type");
        }
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (!hasPdfSignature(bytes.subarray(0, 1024))) {
          throw new Error("invalid pdf signature");
        }
        return new Blob([bytes], { type: "application/pdf" });
      })
      .then((blob) => {
        if (cancelled) return;
        createdObjectUrl = URL.createObjectURL(blob);
        setObjectUrl(createdObjectUrl);
      })
      .catch(() => {
        if (cancelled) return;
        setObjectUrl(null);
        setUnavailable(true);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
      if (createdObjectUrl) URL.revokeObjectURL(createdObjectUrl);
    };
  }, [pdfUrl]);

  return { objectUrl, loading, unavailable };
}

function isPdfContentType(contentType: string | null): boolean {
  return (contentType ?? "").split(";", 1)[0]?.trim().toLowerCase() === "application/pdf";
}

function hasPdfSignature(bytes: Uint8Array): boolean {
  const signature = [0x25, 0x50, 0x44, 0x46, 0x2d];
  return bytes.some((_, start) =>
    start + signature.length <= bytes.length &&
    signature.every((value, offset) => bytes[start + offset] === value),
  );
}

function PreviewStatus({
  children,
  unavailable = false,
}: {
  children: string;
  unavailable?: boolean;
}) {
  return (
    <div
      className="fd-rp-body-text"
      style={{
        color: unavailable ? "var(--ink-3)" : "var(--ink-4)",
        fontStyle: unavailable ? "italic" : undefined,
      }}
    >
      {children}
    </div>
  );
}

function PdfIframe({
  source,
  objectUrl,
}: {
  source: AssetSource;
  objectUrl: string;
}) {
  return (
    <iframe
      src={objectUrl}
      title={source.name}
      style={{
        width: "100%",
        height: "80vh",
        minHeight: 560,
        border: "1px solid var(--line-1)",
        borderRadius: 0,
      }}
    />
  );
}

function isTextualContentType(contentType: string | null): boolean {
  const lower = (contentType ?? "").toLowerCase();
  return lower.startsWith("text/") ||
    lower.includes("json") ||
    lower.includes("markdown") ||
    lower.includes("csv") ||
    lower.includes("tab-separated-values");
}

/** 纯展示:AI 摘要 + 正文(只读)。数据由调用方传入,自身可被自由重挂做动画。 */
function TextPane({
  text,
  summary,
  loading,
  unavailable,
  abstract,
}: {
  text: string;
  summary: string | null;
  loading: boolean;
  unavailable: boolean;
  abstract: string;
}) {
  const showAiSummary = shouldShowAiSummary(summary, abstract);
  return (
    <div>
      {showAiSummary && (
        <div style={{ marginBottom: 14 }}>
          <div className="fd-rp-section-label">AI 摘要</div>
          <div className="fd-rp-abs">{summary}</div>
        </div>
      )}
      <div className="fd-rp-section-label">正文（只读）</div>
      {loading ? (
        <div className="fd-rp-body-text" style={{ color: "var(--ink-4)" }}>
          加载中...
        </div>
      ) : unavailable ? (
        <div className="fd-rp-body-text" style={{ color: "var(--ink-3)", fontStyle: "italic" }}>
          预览不可用
        </div>
      ) : (
        <div className="fd-rp-body-text">{text || "暂无内容"}</div>
      )}
    </div>
  );
}

/** 独立文本素材(非 PDF)的预览:自己拉全文。 */
function TextPreview({ source, sessionId }: { source: AssetSource; sessionId: string | null }) {
  const { text, summary, loading, unavailable } = useMaterialText(source, sessionId);
  return (
    <TextPane
      text={text}
      summary={summary}
      loading={loading}
      unavailable={unavailable}
      abstract={source.abstract}
    />
  );
}
