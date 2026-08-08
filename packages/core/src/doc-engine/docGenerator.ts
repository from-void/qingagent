import type { LegacySection, DocumentSnapshot, BridgeFrame } from "@qingagent/contract-ts";
import { legacySectionsToPm, type PmDoc } from "@qingagent/pm-schema";

/**
 * Build a DocumentSnapshot from sections and version number.
 */
export function buildDocumentSnapshot(
  version: number,
  doc: PmDoc,
): DocumentSnapshot {
  return {
    version,
    ts: new Date().toISOString(),
    doc,
  };
}

/**
 * Emit progressive documentSnapshotWritten frames.
 * We emit one frame per batch of sections to show progressive loading.
 */
export function* emitDocumentSnapshotFrames(
  sections: LegacySection[],
  version: number,
): Generator<BridgeFrame> {
  const batchSize = 3;
  for (let i = 0; i < sections.length; i += batchSize) {
    const partialSections = sections.slice(0, i + batchSize);
    const doc = buildDocumentSnapshot(
      version,
      legacySectionsToPm(partialSections as never),
    );
    yield { kind: "documentSnapshotWritten", data: { doc } };
  }

  // Always emit the final complete version
  if (sections.length % batchSize !== 0) {
    // Already emitted above in the last iteration
  }
}
