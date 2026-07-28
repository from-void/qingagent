import { countGraphemes, truncateGraphemes } from "@qingagent/contract-ts";
import { useEffect } from "react";
import { createPortal } from "react-dom";
import "./longText.css";

// 粘贴文本超过此长度或行数即折叠成"长文本小条"(类 ChatGPT 长文本附件)。
export const LONGTEXT_CHAR_THRESHOLD = 600;
export const LONGTEXT_LINE_THRESHOLD = 12;

export function shouldCollapsePastedText(text: string): boolean {
  if (countGraphemes(text) >= LONGTEXT_CHAR_THRESHOLD) return true;
  return text.split(/\r\n|\r|\n/).length >= LONGTEXT_LINE_THRESHOLD;
}

/** 字数(去空白),用于小条与全屏标题。 */
export function countChars(text: string): number {
  return countGraphemes(text.replace(/\s/g, ""));
}

/** hover 预览卡片里展示的截断预览(前若干行,限长 + 省略号)。 */
export function longTextPreview(text: string, maxLines = 10, maxChars = 500): string {
  const normalized = text.replace(/\r\n?/g, "\n");
  const lines = normalized.split("\n");
  let out = lines.slice(0, maxLines).join("\n");
  const omittedLines = lines.length > maxLines;
  const omittedChars = countGraphemes(out) > maxChars;
  if (omittedChars) out = truncateGraphemes(out, maxChars);
  if (omittedLines || omittedChars) {
    out = out.replace(/\s+$/, "") + " …";
  }
  return out;
}

const LONGTEXT_CHIP_SVG =
  '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 3.5h8L18.5 8v12.5A1 1 0 0 1 17.5 21h-11A1 1 0 0 1 5.5 20V4.5A1 1 0 0 1 6.5 3.5Z"/><path d="M13.5 3.5V8H18"/><path d="M8.5 12.5h7M8.5 15.5h7M8.5 18h4"/></svg>';

/**
 * 长文本"小条" chip(单行,不换行)。原文存 data-text;hover 出预览卡片(.lt-pop,
 * pointer-events:none 让点击穿透到小条);点击小条本体 → 调用方打开全屏。
 * 同时带 chat-chip 基类,让 workspace ChatInput 的 .chat-chip 查询/删除逻辑能识别它。
 */
export function buildLongTextChip(text: string): HTMLSpanElement {
  const chip = document.createElement("span");
  chip.className = "chat-chip chat-chip-longtext";
  chip.setAttribute("contenteditable", "false");
  chip.dataset.kind = "longtext";
  chip.dataset.text = text;
  chip.dataset.label = "长文本";
  chip.dataset.suffix = `${countChars(text)} 字`;
  chip.title = "查看全文";

  const ico = document.createElement("span");
  ico.className = "c-ico";
  ico.innerHTML = LONGTEXT_CHIP_SVG;
  chip.appendChild(ico);

  const label = document.createElement("span");
  label.className = "c-label";
  label.textContent = "长文本";
  chip.appendChild(label);

  const tag = document.createElement("span");
  tag.className = "c-tag";
  tag.textContent = chip.dataset.suffix;
  chip.appendChild(tag);

  const pop = document.createElement("span");
  pop.className = "lt-pop";
  pop.setAttribute("contenteditable", "false");
  const popText = document.createElement("span");
  popText.className = "lt-pop-text";
  popText.textContent = longTextPreview(text);
  pop.appendChild(popText);
  const popHint = document.createElement("span");
  popHint.className = "lt-pop-hint";
  popHint.textContent = "点击查看全文";
  pop.appendChild(popHint);
  chip.appendChild(pop);

  const x = document.createElement("span");
  x.className = "c-x";
  x.title = "移除";
  x.textContent = "×";
  chip.appendChild(x);
  return chip;
}

/**
 * 点击事件命中长文本小条本体(非 × 移除键)时返回该 chip,供调用方打开全屏;否则 null。
 */
export function longTextChipFromClick(target: HTMLElement): HTMLElement | null {
  if (target.classList.contains("c-x")) return null;
  return target.closest(".chat-chip-longtext") as HTMLElement | null;
}

/**
 * 从剪贴板收集图片文件,并重命名为唯一名(避免多张截图同名 image.png 被去重吞掉)。
 * 无文件项时兜底从 HTML 内联 data:image 取第一张(右键复制网页图等来源)。
 */
export function collectClipboardImageFiles(data: DataTransfer | null): File[] {
  if (!data) return [];
  const out: File[] = [];
  // 仅用索引区分,不依赖时间戳(避免 SSR/测试期 Date 限制);毫秒级唯一性已由调用次序保证。
  const stamp = `${data.files?.length ?? 0}-${Math.round(performance.now())}`;
  const files = data.files ? Array.from(data.files) : [];
  let idx = 0;
  for (const f of files) {
    if (f.type.startsWith("image/")) {
      const ext = (f.type.split("/")[1] || "png").replace("jpeg", "jpg").replace("svg+xml", "svg");
      out.push(new File([f], `粘贴图片-${stamp}-${++idx}.${ext}`, { type: f.type || "image/png" }));
    }
  }
  if (out.length === 0) {
    const html = data.getData("text/html") || "";
    const m = html.match(/<img\b[^>]*\bsrc\s*=\s*["'](data:image\/[a-zA-Z+]+;base64,[^"']+)["']/i);
    if (m?.[1]) {
      const file = dataUrlToImageFile(m[1], stamp);
      if (file) out.push(file);
    }
  }
  return out;
}

function dataUrlToImageFile(dataUrl: string, stamp: string): File | null {
  try {
    const [head, body] = dataUrl.split(",");
    if (!head || !body) return null;
    const mime = head.match(/data:([^;]+)/)?.[1] || "image/png";
    const bin = atob(body);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const ext = (mime.split("/")[1] || "png").replace("jpeg", "jpg").replace("svg+xml", "svg");
    return new File([bytes], `粘贴图片-${stamp}.${ext}`, { type: mime });
  } catch {
    return null;
  }
}

/** 长文本全屏查看浮层(portal 到 body,避免被 transform/backdrop-filter 祖先困住)。 */
export function LongTextFullscreen({ text, onClose }: { text: string; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [onClose]);

  return createPortal(
    <div className="lt-full" role="dialog" aria-modal="true" onMouseDown={onClose}>
      <div className="lt-full-panel" onMouseDown={(e) => e.stopPropagation()}>
        <div className="lt-full-head">
          <span className="lt-full-title">粘贴的长文本 · {countChars(text)} 字</span>
          <button type="button" className="lt-full-close" onClick={onClose} aria-label="关闭">
            ×
          </button>
        </div>
        <div className="lt-full-body">{text}</div>
      </div>
    </div>,
    document.body,
  );
}
