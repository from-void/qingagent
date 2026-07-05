import { InkCoalesceVariant } from "./InkCoalesceVariant";
import { InkBloomVariant } from "./InkBloomVariant";
import { ClearPaperSoakVariant } from "./ClearPaperSoakVariant";
import {
  DryFrayInkVariant,
  TideInkVariant,
  TornEdgeInkVariant,
  VeinFlowInkVariant,
} from "./OrganicInkVariants";
import { PaperWashVariant } from "./PaperWashVariant";
import type { SettingsInkVariantComponent, SettingsInkVariantId } from "./types";

const VARIANT_COMPONENTS: Record<SettingsInkVariantId, SettingsInkVariantComponent> = {
  coalesce: InkCoalesceVariant,
  bloom: InkBloomVariant,
  paper: PaperWashVariant,
  tide: TideInkVariant,
  dryFray: DryFrayInkVariant,
  tornEdge: TornEdgeInkVariant,
  veinFlow: VeinFlowInkVariant,
  clearSoak: ClearPaperSoakVariant,
};

export function SettingsInkBackdrop({
  variant,
  active,
  onRevealDone,
}: {
  variant: SettingsInkVariantId;
  active: boolean;
  onRevealDone: () => void;
}) {
  const Component = VARIANT_COMPONENTS[variant];
  return <Component key={variant} active={active} onRevealDone={onRevealDone} />;
}
