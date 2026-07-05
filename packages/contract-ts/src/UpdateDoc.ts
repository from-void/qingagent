import type { LegacySection } from "./LegacySection";
import type { PmDoc } from "./PmDoc";

export type UpdateDoc = {
  sessionId: string;
  expectedDocumentSnapshot: number;
  legacySections?: Array<LegacySection>;
  doc?: PmDoc;
  clientMutationId: string;
};
