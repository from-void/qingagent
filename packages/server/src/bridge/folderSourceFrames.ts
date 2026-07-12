import type { BridgeFrame } from "@qingagent/contract-ts";
import { folderSourcesToWire, type SessionState } from "./bridgeCore";

export function folderSourcesChangedFrame(session: SessionState): BridgeFrame {
  return {
    kind: "folderSourcesChanged",
    data: {
      sessionId: session.sessionId,
      sources: folderSourcesToWire(session.folderSources.values()),
    },
  };
}
