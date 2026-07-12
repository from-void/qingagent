import type { JSX } from "react";

export type BlockHandleIconName =
  | "paragraph"
  | "heading1"
  | "heading2"
  | "heading3"
  | "bulletList"
  | "orderedList"
  | "quote"
  | "code"
  | "task"
  | "callout"
  | "image"
  | "file"
  | "inlineMath"
  | "blockMath"
  | "diagram"
  | "table"
  | "columns"
  | "divider"
  | "align"
  | "alignLeft"
  | "alignCenter"
  | "alignRight"
  | "copy"
  | "cut"
  | "delete"
  | "insert"
  | "equalColumns"
  | "chevron";

export function BlockHandleIcon({ name }: { name: BlockHandleIconName }) {
  switch (name) {
    case "paragraph":
      return (
        <svg className="bh-svg" viewBox="0 0 16 16" aria-hidden="true">
          <path d="M4 4h8M8 4v8M5.5 12h5" />
        </svg>
      );
    case "heading1":
      return (
        <svg className="bh-svg" viewBox="0 0 16 16" aria-hidden="true">
          <path d="M2.8 12V4M7.2 12V4M2.8 8h4.4M10.8 6l1.5-1.2V12" />
        </svg>
      );
    case "heading2":
      return (
        <svg className="bh-svg" viewBox="0 0 16 16" aria-hidden="true">
          <path d="M2.4 12V4M6.6 12V4M2.4 8h4.2M10 6.3c.3-1 1.1-1.5 2.2-1.5 1.2 0 2 .7 2 1.7 0 .7-.3 1.2-1.1 1.8L10.2 12h4" />
        </svg>
      );
    case "heading3":
      return (
        <svg className="bh-svg" viewBox="0 0 16 16" aria-hidden="true">
          <path d="M2.4 12V4M6.6 12V4M2.4 8h4.2M10.2 4.9h3.7l-2 2.6c1.2.1 2.1.8 2.1 2 0 1.4-1 2.3-2.5 2.3-.8 0-1.4-.2-2-.6" />
        </svg>
      );
    case "bulletList":
      return (
        <svg className="bh-svg" viewBox="0 0 16 16" aria-hidden="true">
          <path d="M5.8 4.5h6.7M5.8 8h6.7M5.8 11.5h6.7" />
          <path d="M3.2 4.5h.1M3.2 8h.1M3.2 11.5h.1" />
        </svg>
      );
    case "orderedList":
      return (
        <svg className="bh-svg bh-svg-ordered" viewBox="0 0 18 18" aria-hidden="true">
          <text x="2.2" y="5.6">1</text>
          <text x="2.2" y="10.5">2</text>
          <text x="2.2" y="15.4">3</text>
          <path d="M7.2 4.5h7.8M7.2 9.4h7.8M7.2 14.3h7.8" />
        </svg>
      );
    case "quote":
      return (
        <svg className="bh-svg" viewBox="0 0 16 16" aria-hidden="true">
          <path d="M5.9 4.3c-1.5 1-2.3 2.2-2.3 3.7v3h3.2V7.8H5.2c.1-.8.5-1.6 1.4-2.5M11.8 4.3c-1.5 1-2.3 2.2-2.3 3.7v3h3.2V7.8h-1.6c.1-.8.5-1.6 1.4-2.5" />
        </svg>
      );
    case "code":
      return (
        <svg className="bh-svg" viewBox="0 0 16 16" aria-hidden="true">
          <path d="M5.9 4.8L2.7 8l3.2 3.2M10.1 4.8L13.3 8l-3.2 3.2M9 3.8L7 12.2" />
        </svg>
      );
    case "task":
      return (
        <svg className="bh-svg" viewBox="0 0 16 16" aria-hidden="true">
          <rect x="2.8" y="3" width="10.4" height="10" rx="1.6" />
          <path d="M5.1 8.2l2 2 4-4.4" />
        </svg>
      );
    case "callout":
      return (
        <svg className="bh-svg" viewBox="0 0 16 16" aria-hidden="true">
          <path d="M8 2.8a5.2 5.2 0 100 10.4A5.2 5.2 0 008 2.8zM8 5.4v3.4M8 11.1h.1" />
        </svg>
      );
    case "image":
      return (
        <svg className="bh-svg" viewBox="0 0 16 16" aria-hidden="true">
          <rect x="2.5" y="2.7" width="11" height="10.6" rx="1.6" />
          <path d="M5.3 6.4h.1M3 11.4l3-3 2.2 2.1 2.1-2.5 3 3.4" />
        </svg>
      );
    case "file":
      return (
        <svg className="bh-svg" viewBox="0 0 16 16" aria-hidden="true">
          <path d="M4 2.5h5.2l2.8 2.8v8.2H4zM9.2 2.5v2.8H12M6.1 8h4M6.1 10.6h3.2" />
        </svg>
      );
    case "inlineMath":
      return (
        <svg className="bh-svg" viewBox="0 0 16 16" aria-hidden="true">
          <path d="M12 4H5.2l3.3 4-3.3 4H12" />
        </svg>
      );
    case "blockMath":
      return (
        <svg className="bh-svg" viewBox="0 0 16 16" aria-hidden="true">
          <rect x="2.5" y="3" width="11" height="10" rx="1.5" />
          <path d="M10.8 5.7H6.3L8.5 8l-2.2 2.3h4.5" />
        </svg>
      );
    case "diagram":
      return (
        <svg className="bh-svg" viewBox="0 0 16 16" aria-hidden="true">
          <rect x="2.4" y="3" width="4" height="3.4" rx="1" />
          <rect x="9.6" y="9.6" width="4" height="3.4" rx="1" />
          <path d="M6.4 4.7h2.4c1.5 0 2.8 1.2 2.8 2.8v2.1M8 11.3H5.7c-1.6 0-2.9-1.2-2.9-2.8V6.4" />
        </svg>
      );
    case "table":
      return (
        <svg className="bh-svg" viewBox="0 0 16 16" aria-hidden="true">
          <rect x="2.5" y="3" width="11" height="10" rx="1.3" />
          <path d="M2.5 6.5h11M2.5 9.5h11M6.2 3v10M9.8 3v10" />
        </svg>
      );
    case "columns":
      return (
        <svg className="bh-svg" viewBox="0 0 16 16" aria-hidden="true">
          <rect x="2.5" y="3" width="4.4" height="10" rx="1.2" />
          <rect x="9.1" y="3" width="4.4" height="10" rx="1.2" />
        </svg>
      );
    case "divider":
      return (
        <svg className="bh-svg" viewBox="0 0 16 16" aria-hidden="true">
          <path d="M2.8 8h10.4" strokeDasharray="1.8 2.4" />
        </svg>
      );
    case "align":
      return (
        <svg className="bh-svg" viewBox="0 0 16 16" aria-hidden="true">
          <path d="M3 4.2h8.5M3 7.4h6.2M3 10.6h8.5M3 13.2h5.2" />
        </svg>
      );
    case "alignLeft":
      return (
        <svg className="bh-svg" viewBox="0 0 16 16" aria-hidden="true">
          <path d="M3 4h9.5M3 7.2h6.5M3 10.4h9.5M3 13h5.8" />
        </svg>
      );
    case "alignCenter":
      return (
        <svg className="bh-svg" viewBox="0 0 16 16" aria-hidden="true">
          <path d="M3 4h10M5 7.2h6M3 10.4h10M5.4 13h5.2" />
        </svg>
      );
    case "alignRight":
      return (
        <svg className="bh-svg" viewBox="0 0 16 16" aria-hidden="true">
          <path d="M3.5 4H13M6.5 7.2H13M3.5 10.4H13M7.2 13H13" />
        </svg>
      );
    case "copy":
      return (
        <svg className="bh-svg" viewBox="0 0 16 16" aria-hidden="true">
          <rect x="5.2" y="3" width="7.4" height="9.4" rx="1.2" />
          <path d="M3.4 5.3v7.7h6.9" />
        </svg>
      );
    case "cut":
      return (
        <svg className="bh-svg" viewBox="0 0 16 16" aria-hidden="true">
          <path d="M4.2 4.2l7.6 7.6M11.8 4.2L7.5 8.5" />
          <circle cx="4" cy="11.8" r="1.4" />
          <circle cx="4" cy="4.2" r="1.4" />
        </svg>
      );
    case "delete":
      return (
        <svg className="bh-svg" viewBox="0 0 16 16" aria-hidden="true">
          <path d="M3 4.6h10M6.2 4.6V3.2h3.6v1.4M4.7 4.6l.6 8.2h5.4l.6-8.2M7 7.1v3.4M9 7.1v3.4" />
        </svg>
      );
    case "insert":
      return (
        <svg className="bh-svg" viewBox="0 0 16 16" aria-hidden="true">
          <rect x="3" y="3" width="10" height="10" rx="1.4" />
          <path d="M8 5.5v5M5.5 8h5" />
        </svg>
      );
    case "equalColumns":
      return (
        <svg className="bh-svg" viewBox="0 0 16 16" aria-hidden="true">
          <rect x="2.5" y="3" width="11" height="10" />
          <path d="M6.2 3v10M9.8 3v10M4 8h.7M7.7 8h.7M11.3 8h.7" />
        </svg>
      );
    case "chevron":
      return (
        <svg className="bh-svg" viewBox="0 0 16 16" aria-hidden="true">
          <path d="M6.2 4.2L10 8l-3.8 3.8" />
        </svg>
      );
    default:
      return null;
  }
}
