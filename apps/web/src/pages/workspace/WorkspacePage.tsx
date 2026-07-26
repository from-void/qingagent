import "./workspace.css";
import "./workspace-ink-skin.css";
import { WorkspaceChatPane } from "./components/WorkspaceChatPane";
import { WorkspaceDocumentPane } from "./components/WorkspaceDocumentPane";
import { WorkspaceOverlays } from "./components/WorkspaceOverlays";
import { WorkspaceTopbar } from "./components/WorkspaceTopbar";
import { useWorkspacePageController } from "./hooks/useWorkspacePageController";

export * from "./hooks/useWorkspacePageController";

export function WorkspacePage() {
  const controller = useWorkspacePageController();
  const showDocument = controller.hydration.phase !== "waiting";
  const showChat = controller.hydration.phase === "ready";

  return (
    <section
      ref={controller.viewRef}
      data-view="workspace"
      data-wf="WorkspacePage"
      data-content={controller.dataAttrs.content}
      data-tool={controller.dataAttrs.tool}
      id="view-workspace"
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
        className="ws-body"
        data-hydration={controller.hydration.phase}
        data-hydration-reveal={controller.hydration.revealMode}
      >
        {showChat ? (
          <WorkspaceChatPane controller={controller} />
        ) : (
          <div
            className="ws-hydration-left"
            data-wf="WorkspaceHydrationChat"
            aria-hidden="true"
          />
        )}
        {showDocument ? (
          <WorkspaceDocumentPane controller={controller} />
        ) : (
          <div
            className="ws-hydration-right"
            data-wf="WorkspaceHydrationDocument"
            aria-hidden="true"
          />
        )}
        {!showChat && !showDocument ? (
          <div
            className="ws-hydration-canvas"
            data-wf="WorkspaceHydrationCanvas"
            aria-hidden="true"
          />
        ) : null}
      </div>
      <WorkspaceOverlays controller={controller} />
    </section>
  );
}
