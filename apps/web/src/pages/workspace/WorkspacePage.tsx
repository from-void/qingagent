import "./workspace.css";
import "./workspace-ink-skin.css";
import "./workspace-responsive.css";
import { WorkspaceEditorSelectionProvider } from "../../system/WorkspaceEditorSelectionCache";
import { WORKSPACE_PAPER_DOM } from "../../system/workspacePaperGeometry";
import { WorkspaceChatPane } from "./components/WorkspaceChatPane";
import { WorkspaceDocumentPane } from "./components/WorkspaceDocumentPane";
import { WorkspaceOverlays } from "./components/WorkspaceOverlays";
import { WorkspaceTopbar } from "./components/WorkspaceTopbar";
import { useWorkspacePageController } from "./hooks/useWorkspacePageController";

export * from "./hooks/useWorkspacePageController";

export function WorkspacePage() {
  const controller = useWorkspacePageController();

  return (
    <WorkspaceEditorSelectionProvider>
      <section
        ref={controller.viewRef}
        data-view="workspace"
        data-wf={WORKSPACE_PAPER_DOM.viewDataWf}
        data-content={controller.dataAttrs.content}
        data-tool={controller.dataAttrs.tool}
        id={WORKSPACE_PAPER_DOM.viewId}
        style={{
          flex: 1,
          display: "flex",
          flexDirection: "column",
          minHeight: 0,
          overflow: "hidden",
        }}
      >
        <WorkspaceTopbar controller={controller} />
        <div
          className={WORKSPACE_PAPER_DOM.bodyClass}
          data-hydration={controller.hydration.phase}
          aria-busy={controller.hydration.phase === "waiting"}
        >
          <WorkspaceChatPane controller={controller} />
          <WorkspaceDocumentPane controller={controller} />
        </div>
        <WorkspaceOverlays controller={controller} />
      </section>
    </WorkspaceEditorSelectionProvider>
  );
}
