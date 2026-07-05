import type { ReactNode } from "react";

export type SkillIconKey =
  | "browser"
  | "search"
  | "image"
  | "vision"
  | "calc"
  | "materials"
  | "feishu"
  | "star";

const ICON_KEYS = new Set<SkillIconKey>([
  "browser",
  "search",
  "image",
  "vision",
  "calc",
  "materials",
  "feishu",
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
  star: <path d="M12 3l2.1 5.2L19.5 9l-4 3.4 1.2 5.6L12 15.2 7.3 18l1.2-5.6-4-3.4 5.4-.8z" />,
};
