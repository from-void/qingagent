import type { ReactNode } from "react";

export type SkillIconKey =
  | "browser"
  | "search"
  | "image"
  | "vision"
  | "calc"
  | "materials"
  | "feishu"
  | "github"
  | "wechat"
  | "diagram"
  | "terminal"
  | "style"
  | "review"
  | "translate"
  | "star";

const ICON_KEYS = new Set<SkillIconKey>([
  "browser",
  "search",
  "image",
  "vision",
  "calc",
  "materials",
  "feishu",
  "github",
  "wechat",
  "diagram",
  "terminal",
  "style",
  "review",
  "translate",
  "star",
]);

export function normalizeSkillIconKey(icon: string | null | undefined): SkillIconKey {
  return ICON_KEYS.has(icon as SkillIconKey) ? (icon as SkillIconKey) : "star";
}

export const SKILL_CARD_ICON_PATHS: Record<SkillIconKey, ReactNode> = {
  browser: (
    <>
      <rect x="2.6" y="3.6" width="14.8" height="12.8" rx="1.6" />
      <path d="M2.6 7.2h14.8" />
      <circle cx="5" cy="5.4" r="0.55" fill="currentColor" stroke="none" />
      <circle cx="7" cy="5.4" r="0.55" fill="currentColor" stroke="none" />
    </>
  ),
  search: (
    <>
      <circle cx="8.6" cy="8.6" r="4.9" />
      <path d="m12.6 12.6 4 4" />
    </>
  ),
  image: (
    <>
      <rect x="3" y="4" width="14" height="12" rx="1.4" />
      <circle cx="7.4" cy="8" r="1.3" />
      <path d="m3.6 14.4 4.2-3.6 3 2.3 2.6-2.4 3.6 3.3" />
    </>
  ),
  vision: (
    <>
      <path d="M2.5 10S5.4 5.2 10 5.2 17.5 10 17.5 10 14.6 14.8 10 14.8 2.5 10 2.5 10Z" />
      <circle cx="10" cy="10" r="2.2" />
    </>
  ),
  calc: (
    <>
      <rect x="3" y="3.6" width="14" height="12.8" rx="1.2" />
      <path d="M3 8h14M3 12h14M8 3.6v12.8" />
    </>
  ),
  materials: (
    <path d="m10 3 7 3.4-7 3.4-7-3.4L10 3ZM3 10l7 3.4 7-3.4M3 13.4 10 16.8l7-3.4" />
  ),
  feishu: (
    <path d="M17 4 3.2 9.4l4.7 1.9M17 4l-2.4 12.2-3.9-4.4M17 4 8 11.3m0 0 .1 4.1 2.3-2.9" />
  ),
  github: (
    <>
      <path d="M7.4 16.6c-3 .9-3-1.5-4.2-1.9m9.6 4.4v-2.6c0-.8-.1-1.1-.6-1.5 2.3-.3 4.6-1.2 4.6-5a3.9 3.9 0 0 0-1-2.7 3.6 3.6 0 0 0-.1-2.7s-.9-.3-2.9 1.1a9.6 9.6 0 0 0-5 0C5.8 4.3 4.9 4.6 4.9 4.6a3.6 3.6 0 0 0-.1 2.7 3.9 3.9 0 0 0-1 2.7c0 3.8 2.3 4.7 4.5 5-.3.3-.5.7-.6 1.2v3.3" />
    </>
  ),
  wechat: (
    <>
      <path d="M7.6 3.6c2.8 0 5 1.9 5 4.2 0 .5-.1 1-.3 1.4" />
      <path d="M7.6 3.6c-2.8 0-5 1.9-5 4.2 0 1.3.7 2.5 1.9 3.3l-.5 1.7 1.9-1a6 6 0 0 0 1.7.2" />
      <circle cx="6" cy="7" r="0.5" fill="currentColor" stroke="none" />
      <circle cx="9.2" cy="7" r="0.5" fill="currentColor" stroke="none" />
      <path d="M13 8.4c2.4 0 4.4 1.7 4.4 3.7 0 1.1-.6 2.1-1.6 2.8l.4 1.5-1.6-.9a5.6 5.6 0 0 1-1.6.2c-2.4 0-4.4-1.6-4.4-3.6S10.6 8.4 13 8.4Z" />
    </>
  ),
  diagram: (
    <>
      <rect x="7.4" y="2.6" width="5.2" height="3.4" rx="0.6" />
      <rect x="2.6" y="14" width="5.2" height="3.4" rx="0.6" />
      <rect x="12.2" y="14" width="5.2" height="3.4" rx="0.6" />
      <path d="M10 6v4M5.2 14v-2.6h9.6V14" />
    </>
  ),
  terminal: (
    <>
      <rect x="2.6" y="3.6" width="14.8" height="12.8" rx="1.4" />
      <path d="m5.6 7.6 2.6 2.4-2.6 2.4M10.4 12.8h4" />
    </>
  ),
  style: (
    <>
      <path d="M4 15.6c-.9-.9-1.4-2.1-1.4-3.4C2.6 7.6 6.7 3 11.4 3c3.3 0 6 2.1 6 4.9 0 2.4-2 4.3-4.5 4.3h-1.6c-.8 0-1.4.6-1.4 1.3 0 .4.1.7.4 1 .2.3.4.6.4 1 0 .8-.7 1.4-1.5 1.4-1.5 0-2.9-.5-3.9-1.3Z" />
      <circle cx="6.6" cy="9" r="0.7" fill="currentColor" stroke="none" />
      <circle cx="10.4" cy="6.6" r="0.7" fill="currentColor" stroke="none" />
      <circle cx="13.8" cy="8.6" r="0.7" fill="currentColor" stroke="none" />
    </>
  ),
  review: (
    <>
      <path d="M5 2.8h7.2L16 6.6v10.6H5z" />
      <path d="M11.8 2.8v3.8H16" />
      <path d="m7.4 11.4 1.6 1.6 3.4-3.6" />
    </>
  ),
  translate: (
    <>
      <path d="M2.8 5h7.4M6.5 3.4V5" />
      <path d="M8.6 5c-.5 3.4-2.6 6-5.8 7.4" />
      <path d="M5 8.6c.9 2 2.6 3.4 4.6 4.2" />
      <path d="m10.6 17 3.2-8 3.2 8M11.9 14.4h4.2" />
    </>
  ),
  star: <path d="M10 2.6 12 8l5.4 2-5.4 2-2 5.4-2-5.4L2.6 10 8 8 10 2.6Z" />,
};

export const SKILL_MENU_ICON_PATHS: Record<SkillIconKey, ReactNode> = {
  browser: (
    <>
      <rect x="3" y="4.5" width="18" height="15" rx="2" />
      <path d="M3 9h18" />
      <path d="M12 12.5v4.2" />
      <path d="m9.8 14.8 2.2 2.2 2.2-2.2" />
    </>
  ),
  search: (
    <>
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.4-3.4" />
    </>
  ),
  image: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <circle cx="8.5" cy="9.5" r="1.5" />
      <path d="m5 18 5-5 4 4 2-2 3 3" />
    </>
  ),
  vision: (
    <>
      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z" />
      <circle cx="12" cy="12" r="3" />
    </>
  ),
  calc: (
    <>
      <rect x="4" y="4" width="16" height="16" rx="2" />
      <path d="M4 9h16M4 14h16M9 4v16" />
    </>
  ),
  materials: (
    <path d="m12 3.5 8 3.9-8 3.9-8-3.9 8-3.9ZM4 12l8 3.9 8-3.9M4 16.2l8 3.9 8-3.9" />
  ),
  feishu: (
    <>
      <path d="m9.5 14.5 5-5" />
      <path d="m11 7.8 1-1a3.6 3.6 0 0 1 5.1 5.1l-1 1" />
      <path d="m13 16.2-1 1a3.6 3.6 0 0 1-5.1-5.1l1-1" />
    </>
  ),
  github: (
    <path d="M9 19c-3.6 1.1-3.6-1.8-5-2.2m11.5 5.3v-3.1c0-.9-.1-1.3-.7-1.8 2.8-.3 5.5-1.4 5.5-6a4.7 4.7 0 0 0-1.2-3.2 4.3 4.3 0 0 0-.1-3.2s-1.1-.4-3.5 1.3a11.5 11.5 0 0 0-6 0C6.9 4.4 5.8 4.8 5.8 4.8a4.3 4.3 0 0 0-.1 3.2 4.7 4.7 0 0 0-1.2 3.2c0 4.6 2.7 5.7 5.4 6-.4.4-.6.9-.7 1.5V22" />
  ),
  wechat: (
    <>
      <path d="M9 4c3.4 0 6.1 2.3 6.1 5.1 0 .6-.1 1.2-.4 1.7" />
      <path d="M9 4C5.6 4 2.9 6.3 2.9 9.1c0 1.6.9 3.1 2.3 4L4.6 15l2.3-1.2c.6.2 1.3.3 2.1.3" />
      <circle cx="7.1" cy="8.2" r="0.7" fill="currentColor" stroke="none" />
      <circle cx="11" cy="8.2" r="0.7" fill="currentColor" stroke="none" />
      <path d="M15.6 10.1c2.9 0 5.3 2 5.3 4.5 0 1.4-.8 2.6-2 3.4l.5 1.8-2-1.1c-.6.2-1.3.3-2 .3-2.9 0-5.3-2-5.3-4.4s2.4-4.5 5.5-4.5Z" />
    </>
  ),
  diagram: (
    <>
      <rect x="9" y="3" width="6" height="4" rx="0.8" />
      <rect x="3" y="17" width="6" height="4" rx="0.8" />
      <rect x="15" y="17" width="6" height="4" rx="0.8" />
      <path d="M12 7v5M6 17v-3h12v3" />
    </>
  ),
  terminal: (
    <>
      <rect x="3" y="4.5" width="18" height="15" rx="2" />
      <path d="m7 9 3 3-3 3M13 15h5" />
    </>
  ),
  style: (
    <>
      <path d="M5 18.6c-1.2-1.1-1.9-2.7-1.9-4.4C3.1 8.6 8.2 3 14 3c4 0 7.2 2.6 7.2 6 0 3-2.5 5.3-5.6 5.3h-2c-.9 0-1.7.7-1.7 1.6 0 .5.2.9.5 1.2.3.4.5.8.5 1.3 0 1-.9 1.8-1.9 1.8-1.9 0-3.6-.6-4.9-1.6Z" />
      <circle cx="8" cy="11" r="0.9" fill="currentColor" stroke="none" />
      <circle cx="12.8" cy="8" r="0.9" fill="currentColor" stroke="none" />
      <circle cx="16.8" cy="10.4" r="0.9" fill="currentColor" stroke="none" />
    </>
  ),
  review: (
    <>
      <path d="M6 3h9l4 4v14H6z" />
      <path d="M15 3v4h4" />
      <path d="m9 13.6 2 2 4-4.4" />
    </>
  ),
  translate: (
    <>
      <path d="M3 6h9M7.6 4v2" />
      <path d="M10.4 6c-.6 4.2-3.2 7.4-7.2 9.1" />
      <path d="M6 10.6c1.1 2.5 3.2 4.2 5.7 5.2" />
      <path d="m12.8 21 4-10 4 10M14.4 17.6h5.2" />
    </>
  ),
  star: <path d="M12 3l2.1 5.2L19.5 9l-4 3.4 1.2 5.6L12 15.2 7.3 18l1.2-5.6-4-3.4 5.4-.8z" />,
};
