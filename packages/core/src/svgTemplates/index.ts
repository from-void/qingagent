import type { SvgTemplate } from "./types.js";
import { compareCardTemplate } from "./compareCard.js";
import { pointsCardTemplate } from "./pointsCard.js";
import { barCardTemplate } from "./barCard.js";

export const SVG_TEMPLATES: Record<string, SvgTemplate<any>> = {
  [compareCardTemplate.id]: compareCardTemplate,
  [pointsCardTemplate.id]: pointsCardTemplate,
  [barCardTemplate.id]: barCardTemplate,
};

export {
  compareCardTemplate,
  pointsCardTemplate,
  barCardTemplate,
};
