import type { TemplateIconId } from "../data/templates";

// 模板卡线性水墨图标(无 emoji),随卡片墨色 currentColor 着色。

const COMMON = {
  viewBox: "0 0 32 32",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.4,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

export function TemplateIcon({ id }: { id: TemplateIconId }) {
  switch (id) {
    case "brush":
      return (
        <svg {...COMMON}>
          <path d="M21 4l7 7-9.5 9.5-7-7z" />
          <path d="M11.5 13.5l-5 5c-1.6 1.6-2 4-2.5 6 2-.5 4.4-.9 6-2.5l5-5" />
          <path d="M5 30c1.5-.6 2.4-1.5 3-3" />
        </svg>
      );
    case "target":
      return (
        <svg {...COMMON}>
          <circle cx="14" cy="14" r="9" />
          <circle cx="14" cy="14" r="3.4" />
          <line x1="27" y1="27" x2="20.5" y2="20.5" />
        </svg>
      );
    case "link":
      return (
        <svg {...COMMON}>
          <path d="M13 19l6-6" />
          <path d="M11 15l-2.5 2.5a4.6 4.6 0 0 0 6.5 6.5L17.5 21.5" />
          <path d="M21 17l2.5-2.5a4.6 4.6 0 0 0-6.5-6.5L14.5 10.5" />
        </svg>
      );
    case "doc":
    default:
      return (
        <svg {...COMMON}>
          <path d="M18 4H9a2 2 0 0 0-2 2v20a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V11z" />
          <path d="M18 4v7h7" />
          <line x1="11" y1="16" x2="21" y2="16" />
          <line x1="11" y1="20" x2="21" y2="20" />
          <line x1="11" y1="24" x2="17" y2="24" />
        </svg>
      );
  }
}
