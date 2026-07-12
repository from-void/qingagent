import type { Material } from "./bridgeCore";
import { getSession } from "./sessionRegistry";

/** Look up a material by ID within a specific session. */
export function findMaterial(sessionId: string, materialId: string): Material | undefined {
  return getSession(sessionId)?.materials.get(materialId);
}
