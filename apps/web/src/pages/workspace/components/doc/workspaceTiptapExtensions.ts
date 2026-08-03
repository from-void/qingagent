import { createQingagentExtensions } from "@qingagent/pm-schema/tiptap";
import type { Extensions } from "@tiptap/core";
import { CodeBlockCM } from "../CodeBlockView";
import { CalloutCM } from "../CalloutView";
import { ColumnCM, ColumnListCM } from "../ColumnView";
import { ListItemDnDExtension } from "../ListItemDnD";
import { BlockCollapseExtension } from "../BlockCollapse";
import { DiagramCM } from "../DiagramView";
import { ImageCM } from "../ImageView";
import { DocFindDecorations } from "../../data/docFindPm";
import { NativePresentationDecorations } from "../../data/nativePresentationPm";
import { PatchDecorations } from "../../data/patchDecorations";
import { TableAxisSelectionExtension } from "../../data/tableToolbar";
import { TableStickyColumnExtension } from "../../data/tableStickyColumn";
import { WorkspaceEditingShortcuts } from "./workspaceEditingShortcuts";

export const MATH_CLICK_EVENT = "qingagent:math-click";

export function createWorkspaceTiptapExtensions(options: {
  docId: string | null;
  forceExpandCollapse: boolean;
  canRequestDiagramInteraction: () => boolean;
  requestDiagramInteraction: () => Promise<boolean>;
}): Extensions {
  return [
  ...createQingagentExtensions({
	    codeBlockExtension: CodeBlockCM,
	    imageExtension: ImageCM,
	    diagramExtension: DiagramCM.configure({
        canRequestDiagramInteraction: options.canRequestDiagramInteraction,
        requestDiagramInteraction: options.requestDiagramInteraction,
      }),
    calloutExtension: CalloutCM,
    columnListExtension: ColumnListCM,
    columnExtension: ColumnCM,
    onMathClick: (info) => {
      window.dispatchEvent(new CustomEvent(MATH_CLICK_EVENT, { detail: info }));
    },
  }),
  ListItemDnDExtension,
  WorkspaceEditingShortcuts,
  TableAxisSelectionExtension,
  TableStickyColumnExtension,
  BlockCollapseExtension.configure({
    docId: options.docId,
    forceExpanded: options.forceExpandCollapse,
  }),
  DocFindDecorations,
  NativePresentationDecorations,
  PatchDecorations,
  ];
}
