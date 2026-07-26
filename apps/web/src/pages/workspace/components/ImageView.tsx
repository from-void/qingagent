import { useEffect, useRef, useState, type CSSProperties } from "react";
import { Node, type CommandProps, type NodeViewProps } from "@tiptap/core";
import { NodeViewWrapper, ReactNodeViewRenderer } from "@tiptap/react";
import { PM_IMAGE_ALIGN_VALUES, isAllowedImageSrc } from "@qingagent/pm-schema";
import { MediaZoomFullscreen } from "./MediaZoomFullscreen";
import { MediaBlockToolbar } from "./MediaBlockToolbar";
import { isSvgSrc, svgFallbackWidth } from "./imageSizing";
import { normalizeImageAlign, type ImageAlign } from "../data/imageAlign";
export { normalizeImageAlign, type ImageAlign } from "../data/imageAlign";
import "./ImageView.css";

// 全屏查看的图样式:SVG 数据 URI 常无固有尺寸,不给定宽会塌成 0 → 全屏一片空白。
// 故 SVG 给一个明确宽度;位图按自然尺寸、限制在视口内。
const fullscreenImgStyle = (src: string): CSSProperties =>
  isSvgSrc(src)
    ? { width: "min(900px, 86vw)", height: "auto", maxHeight: "86vh" }
    : { maxWidth: "92vw", maxHeight: "88vh", width: "auto", height: "auto" };

const MIN_IMAGE_WIDTH = 80;

type ImageCommandOptions = {
  src: string;
  alt?: string | null;
  title?: string | null;
};

function ImageComponent({ node, updateAttributes, editor, selected }: NodeViewProps) {
  const src = String(node.attrs.src ?? "");
  const alt = typeof node.attrs.alt === "string" ? node.attrs.alt : "";
  const caption = typeof node.attrs.caption === "string" ? node.attrs.caption : null;
  const width = positiveSize(node.attrs.width);
  const height = positiveSize(node.attrs.height);
  const align = normalizeImageAlign(node.attrs.align);
  const uploading = node.attrs.uploading === true;
  const uploadError = node.attrs.error === true;
  const progress = normalizeUploadProgress(node.attrs.progress);
  const editable = editor?.isEditable ?? false;
  const frameRef = useRef<HTMLElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const cleanupResizeRef = useRef<(() => void) | null>(null);
  const [previewWidth, setPreviewWidth] = useState<number | null>(width);
  const [fullscreen, setFullscreen] = useState(false);

  useEffect(() => {
    setPreviewWidth(width);
  }, [width]);

  useEffect(() => () => cleanupResizeRef.current?.(), []);

  const shownWidth = svgFallbackWidth(src, previewWidth ?? width);

  return (
    <NodeViewWrapper
      className={`pm-image pm-image--${align}${selected ? " is-selected" : ""}`}
      data-pm-node="image"
      data-align={align}
    >
      <figure
        ref={frameRef}
        className="pm-image-frame"
        style={imageFigureStyle(shownWidth, align)}
      >
        <div className="pm-image-media">
          <img
            ref={imgRef}
            src={src}
            alt={alt}
            width={shownWidth ?? undefined}
            height={height ?? undefined}
            style={{ width: shownWidth ? "100%" : undefined }}
            draggable={false}
          />
          {(uploading || uploadError) ? (
            <div className={`pm-image-upload-overlay${uploadError ? " is-error" : ""}`} contentEditable={false}>
              <div className="pm-image-upload-spinner" aria-hidden="true" />
              <span className="pm-image-upload-text">
                {uploadError ? "上传失败" : progress == null ? "上传中" : `上传中 ${progress}%`}
              </span>
            </div>
          ) : null}
          {editable ? (
            <MediaBlockToolbar
              align={align}
              onAlignChange={(nextAlign) => updateAttributes({ align: nextAlign })}
              onFullscreen={() => setFullscreen(true)}
              ariaLabel="图片操作"
              fullscreenAriaLabel="全屏查看图片"
            />
          ) : null}
          {editable ? (
            <button
              type="button"
              className="pm-image-resize-handle pm-image-chrome"
              aria-label="调整图片宽度"
              contentEditable={false}
              onPointerDown={(event) => {
                event.preventDefault();
                event.stopPropagation();
                const startWidth = resolveCurrentImageWidth(width, imgRef.current);
                const maxWidth = resolveMaxImageWidth(frameRef.current, startWidth);
                const startX = event.clientX;
                let nextWidth = startWidth;
                const onMove = (moveEvent: PointerEvent) => {
                  nextWidth = clamp(Math.round(startWidth + moveEvent.clientX - startX), MIN_IMAGE_WIDTH, maxWidth);
                  setPreviewWidth(nextWidth);
                };
                const onUp = () => {
                  window.removeEventListener("pointermove", onMove);
                  window.removeEventListener("pointerup", onUp);
                  cleanupResizeRef.current = null;
                  updateAttributes({ width: nextWidth, height: null });
                };
                cleanupResizeRef.current?.();
                cleanupResizeRef.current = () => {
                  window.removeEventListener("pointermove", onMove);
                  window.removeEventListener("pointerup", onUp);
                };
                window.addEventListener("pointermove", onMove);
                window.addEventListener("pointerup", onUp, { once: true });
              }}
            />
          ) : null}
        </div>
        {caption ? <figcaption className="pm-image-caption">{caption}</figcaption> : null}
      </figure>
      <MediaZoomFullscreen
        open={fullscreen}
        onClose={() => setFullscreen(false)}
        ariaLabel="图片全屏查看"
        contentClassName="media-zoom-content--image"
      >
        <img src={src} alt={alt} style={fullscreenImgStyle(src)} />
      </MediaZoomFullscreen>
    </NodeViewWrapper>
  );
}

export function ReadonlyImageFigure({
  src,
  alt,
  caption,
  width,
  height,
  align,
}: {
  src: string;
  alt: string;
  caption?: string | null;
  width?: number | null;
  height?: number | null;
  align?: string | null;
}) {
  const normalizedAlign = normalizeImageAlign(align);
  const safeWidth = svgFallbackWidth(src, positiveSize(width));
  const safeHeight = positiveSize(height);
  const [fullscreen, setFullscreen] = useState(false);
  return (
    <figure
      className={`pm-image-readonly pm-image-frame pm-image--${normalizedAlign}`}
      data-align={normalizedAlign}
      style={imageFigureStyle(safeWidth, normalizedAlign)}
    >
      <div className="pm-image-media">
        <img
          src={src}
          alt={alt}
          width={safeWidth ?? undefined}
          height={safeHeight ?? undefined}
          style={{ width: safeWidth ? "100%" : undefined }}
        />
        <button
          type="button"
          className="pm-image-fullscreen-btn"
          aria-label="全屏查看图片"
          onMouseDown={(event) => {
            event.preventDefault();
            event.stopPropagation();
            setFullscreen(true);
          }}
        >
          ⛶ 全屏
        </button>
      </div>
      {caption ? <figcaption className="pm-image-caption">{caption}</figcaption> : null}
      <MediaZoomFullscreen
        open={fullscreen}
        onClose={() => setFullscreen(false)}
        ariaLabel="图片全屏查看"
        contentClassName="media-zoom-content--image"
      >
        <img src={src} alt={alt} style={fullscreenImgStyle(src)} />
      </MediaZoomFullscreen>
    </figure>
  );
}

export const ImageCM = Node.create({
  name: "image",
  group: "block",
  atom: true,
  draggable: true,

  parseHTML() {
    return [
      {
        tag: "img[src]",
        getAttrs: (element: HTMLElement | string) => {
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
        parseHTML: (element: HTMLElement) => element.getAttribute("src"),
      },
      alt: {
        default: null,
        parseHTML: (element: HTMLElement) => element.getAttribute("alt"),
      },
      title: {
        default: null,
        parseHTML: (element: HTMLElement) => element.getAttribute("title"),
      },
      caption: {
        default: null,
        parseHTML: (element: HTMLElement) => element.getAttribute("data-caption"),
      },
      width: {
        default: null,
        parseHTML: (element: HTMLElement) => parsePositiveImageSize(element.getAttribute("width") ?? element.style.width),
      },
      height: {
        default: null,
        parseHTML: (element: HTMLElement) => parsePositiveImageSize(element.getAttribute("height") ?? element.style.height),
      },
      align: {
        default: "center",
        parseHTML: (element: HTMLElement) => parseImageAlign(element),
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

  renderHTML({ node, HTMLAttributes }: { node: { attrs: Record<string, unknown> }; HTMLAttributes: Record<string, unknown> }) {
    return ["img", imageHtmlAttributes({ ...HTMLAttributes, ...node.attrs })];
  },

  addNodeView() {
    return ReactNodeViewRenderer(ImageComponent as never, {
      stopEvent: ({ event }) => {
        const target = event.target as HTMLElement | null;
        return Boolean(target?.closest(".pm-image-chrome, .pm-image-toolbar, .pm-image-fullscreen-btn, .media-zoom-fullscreen"));
      },
    });
  },

  addCommands() {
    return {
      setImage:
        (options: ImageCommandOptions) =>
        ({ commands }: CommandProps) => {
          if (!isAllowedImageSrc(options.src)) return false;
          return commands.insertContent({ type: this.name, attrs: { align: "center", ...options } });
        },
    };
  },
});

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

export function imageFigureStyle(width: number | null | undefined, align: ImageAlign): CSSProperties {
  return {
    width: width ? `${width}px` : "fit-content",
    maxWidth: "100%",
    marginTop: 16,
    marginBottom: 16,
    marginLeft: align === "center" || align === "right" ? "auto" : 0,
    marginRight: align === "center" || align === "left" ? "auto" : 0,
  };
}

function positiveSize(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round(value) : null;
}

function normalizeUploadProgress(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.max(0, Math.min(100, Math.round(value)));
}

function parsePositiveImageSize(value: string | null): number | null {
  if (!value) return null;
  const match = value.trim().match(/^(\d+(?:\.\d+)?)(?:px)?$/);
  const n = Number(match?.[1] ?? NaN);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
}

function imageHtmlAttributes(attrs: Record<string, unknown>): Record<string, string> {
  const align = normalizeImageAlign(attrs.align);
  const width = positiveSize(attrs.width);
  const height = positiveSize(attrs.height);
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

function resolveCurrentImageWidth(width: number | null, image: HTMLImageElement | null): number {
  if (width) return width;
  const rectWidth = image?.getBoundingClientRect().width ?? 0;
  if (rectWidth > 0) return Math.round(rectWidth);
  if (image?.naturalWidth) return image.naturalWidth;
  return 240;
}

function resolveMaxImageWidth(frame: HTMLElement | null, fallback: number): number {
  const parentWidth = frame?.parentElement?.getBoundingClientRect().width ?? 0;
  const frameWidth = frame?.getBoundingClientRect().width ?? 0;
  const maxWidth = Math.max(parentWidth, frameWidth, fallback, MIN_IMAGE_WIDTH);
  return Math.round(maxWidth);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
