import "@qingagent/ui-kit";

import { useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import type { PmDoc } from "@qingagent/pm-schema";
import { ToastProvider } from "../../../src/system";
import { DocumentSnapshotView } from "../../../src/pages/workspace/components/DocumentSnapshotView";
import type { NativePresentationRun } from "../../../src/pages/workspace/data/nativeDiffAnimation";
import {
  pmDocToViewDocumentSnapshot,
  type ViewDocumentSnapshot,
} from "../../../src/pages/workspace/data/protocol";
import "../../../src/app.css";
import "../../../src/pages/workspace/workspace.css";
import "../../../src/pages/workspace/workspace-ink-skin.css";

const DIAGRAM_SOURCE = [
  "flowchart TD",
  "  A[开始] --> B[审核]",
  "  B --> C[完成]",
].join("\n");

function diagramDoc(trailingText = ""): PmDoc {
  return {
    type: "doc",
    attrs: { schemaVersion: 1 },
    content: [
      {
        type: "paragraph",
        attrs: { blockId: "diagram-entry-lead" },
        content: [{ type: "text", text: "图表入口回归" }],
      },
      {
        type: "diagram",
        attrs: {
          blockId: "diagram-entry-fixture",
          lang: "mermaid",
          source: DIAGRAM_SOURCE,
          svg: null,
        },
      },
      ...(trailingText
        ? [{
            type: "paragraph",
            attrs: { blockId: "diagram-entry-tail" },
            content: [{ type: "text", text: trailingText }],
          }]
        : []),
    ],
  } as unknown as PmDoc;
}

function buildNewPathFixture(): {
  doc: ViewDocumentSnapshot;
  run: NativePresentationRun;
} {
  const baseline = pmDocToViewDocumentSnapshot(
    diagramDoc(),
    40,
    "图表终稿基线",
  );
  const doc = pmDocToViewDocumentSnapshot(
    diagramDoc("仍在揭示的终稿正文。".repeat(500)),
    41,
    "刚生成的图表终稿",
  );
  return {
    doc,
    run: {
      id: 41,
      docVersion: doc.version,
      sessionId: "diagram-entry-new-path",
      mode: "whole",
      finalDoc: doc.pmDoc,
      baselineSections: baseline.sections,
      finalSections: doc.sections,
    },
  };
}

function DiagramEntryFixture() {
  const mode = new URLSearchParams(window.location.search).get("mode") ?? "new";
  const fixture = useMemo(() => buildNewPathFixture(), []);
  const [run, setRun] = useState<NativePresentationRun | null>(
    mode === "new" ? fixture.run : null,
  );

  const cancelPresentation = () => {
    document.body.dataset.presentationCanceled = "1";
    setRun(null);
  };

  return (
    <ToastProvider>
      <main id="view-workspace">
        <div className="ws-right">
          <DocumentSnapshotView
            doc={fixture.doc}
            docId={`diagram-entry-${mode}`}
            editable
            interactiveEditable={run === null}
            canInterruptPresentationForEdit={mode === "new" && run !== null}
            showPatches={false}
            acceptedPatches={new Set<string>()}
            rejectedPatches={new Set<string>()}
            onEditorReady={() => undefined}
            presentationRun={run}
            presentationReducedMotion={false}
            onPresentationFinish={() => setRun(null)}
            onPresentationCancel={cancelPresentation}
          />
        </div>
      </main>
    </ToastProvider>
  );
}

createRoot(document.getElementById("root")!).render(<DiagramEntryFixture />);
