import { PM_IMAGE_ALIGN_VALUES } from "@qingagent/pm-schema";

export type ImageAlign = (typeof PM_IMAGE_ALIGN_VALUES)[number];

export function normalizeImageAlign(value: unknown): ImageAlign {
  return PM_IMAGE_ALIGN_VALUES.includes(value as ImageAlign) ? (value as ImageAlign) : "center";
}
