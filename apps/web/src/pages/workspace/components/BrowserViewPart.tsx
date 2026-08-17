import { useState } from "react";
import type { ImagePart } from "@qingagent/contract-ts";
import { ExternalLinkIcon } from "./icons";

interface BrowserViewPartProps {
  data: ImagePart;
}

/** 从 URL 提取主机名展示;非法 URL 原样返回。 */
export function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

export function BrowserViewPart({ data }: BrowserViewPartProps) {
  const [expanded, setExpanded] = useState(false);

  // 无预览图(站点没有 og:image 或图片下载失败)→ 简化文字卡:
  // 只保留标题 + 域名一行,可点击打开原网页;不渲染图片区。
  // 链接/来源卡:带图与不带图统一同一套结构与字号(demo 链接卡),前缀「链接」标签。
  const meta = (
    <div className="ws-link-card-meta">
      <div className="ws-link-card-title">
        <span className="ws-link-tag">链接</span>
        {data.label}
      </div>
      {data.sourceUrl && (
        <div className="ws-link-card-host">
          {hostnameOf(data.sourceUrl)}
          <span className="ws-link-arrow"><ExternalLinkIcon size={11} /></span>
        </div>
      )}
    </div>
  );

  if (!data.src) {
    return (
      <button
        type="button"
        className="ws-link-card"
        title={data.sourceUrl ? "打开原网页" : undefined}
        onClick={() => {
          if (data.sourceUrl) {
            window.open(data.sourceUrl, "_blank", "noopener,noreferrer");
          }
        }}
      >
        {meta}
      </button>
    );
  }

  const imgSrc = data.srcKind === "base64"
    ? `data:image/jpeg;base64,${data.src}`
    : data.src;

  return (
    <>
      <button
        type="button"
        className="ws-link-card"
        title={data.sourceUrl ? "打开原网页" : undefined}
        onClick={() => {
          // 有原始网页链接 → 点击直接跳转原网页;否则退化为图片放大预览。
          if (data.sourceUrl) {
            window.open(data.sourceUrl, "_blank", "noopener,noreferrer");
            return;
          }
          setExpanded(true);
        }}
      >
        <img className="ws-link-card-img" src={imgSrc} alt={data.label} loading="lazy" />
        {meta}
      </button>

      {expanded && (
        <div
          role="dialog"
          onClick={() => setExpanded(false)}
          onKeyDown={(e) => {
            if (e.key === "Escape") setExpanded(false);
          }}
          tabIndex={0}
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 9999,
            background: "rgba(0,0,0,0.75)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            cursor: "zoom-out",
          }}
        >
          <img
            src={imgSrc}
            alt={data.label}
            style={{ maxWidth: "90vw", maxHeight: "90vh", borderRadius: 8, boxShadow: "0 4px 24px rgba(0,0,0,0.3)" }}
          />
        </div>
      )}
    </>
  );
}
