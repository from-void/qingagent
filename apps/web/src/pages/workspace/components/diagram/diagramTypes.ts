import type { DiagramOverlay } from "@qingagent/diagram-engine";

export interface DiagramVisualChange {
  source?: string;
  overlay?: DiagramOverlay | null;
}
