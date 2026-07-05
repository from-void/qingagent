import type { JSX } from "react";

export const SETTINGS_INK_VARIANTS = [
  "coalesce",
  "bloom",
  "paper",
  "tide",
  "dryFray",
  "tornEdge",
  "veinFlow",
  "clearSoak",
] as const;

export type SettingsInkVariantId = (typeof SETTINGS_INK_VARIANTS)[number];

export const SETTINGS_INK_VARIANT_LABEL: Record<SettingsInkVariantId, string> = {
  coalesce: "墨球聚合",
  bloom: "层染湿墨",
  paper: "宣纸渗染",
  tide: "潮墨外涌",
  dryFray: "干边毛躁",
  tornEdge: "撕边墨池",
  veinFlow: "墨脉流展",
  clearSoak: "清宣吸墨",
};

export interface SettingsInkVariantProps {
  active: boolean;
  onRevealDone: () => void;
}

export type SettingsInkVariantComponent = (props: SettingsInkVariantProps) => JSX.Element;
