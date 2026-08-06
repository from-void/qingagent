import { Extension, type Editor } from "@tiptap/core";
import { Plugin } from "@tiptap/pm/state";

type ListItemType = "listItem" | "taskItem";

function selectedListItemType(editor: Editor): ListItemType | null {
  const { $from } = editor.state.selection;
  for (let depth = $from.depth; depth > 0; depth -= 1) {
    const name = $from.node(depth).type.name;
    if (name === "listItem" || name === "taskItem") return name;
  }
  return null;
}

export function handleWorkspaceEditingShortcut(editor: Editor, event: KeyboardEvent): boolean {
  const hasMod = event.ctrlKey || event.metaKey;

  // TipTap/ProseMirror 的字符 keymap 依赖 event.key/keyCode。部分 Electron WebView
  // 只稳定提供物理 code，导致通用重做组合无声失效；在工作区扩展里把两种组合显式补齐。
  if (
    hasMod &&
    !event.altKey &&
    event.code === "KeyZ" &&
    event.shiftKey
  ) {
    return editor.commands.redo();
  }
  if (
    hasMod &&
    !event.altKey &&
    event.code === "KeyY" &&
    !event.shiftKey
  ) {
    return editor.commands.redo();
  }

  // ProseMirror keymap 只认 event.key；AltGr/非美式布局会把 Ctrl+Alt+C 改写成 ©/ç。
  if (
    event.code === "KeyC"
    && hasMod
    && event.altKey
    && !event.shiftKey
  ) {
    return editor.commands.toggleCodeBlock();
  }

  // 某些内嵌 WebView/输入法事件只给物理 code，event.key 会是 Unidentified。
  if (
    event.code !== "Tab"
    || event.ctrlKey
    || event.metaKey
    || event.altKey
  ) {
    return false;
  }

  const itemType = selectedListItemType(editor);
  if (!itemType) return false;
  return event.shiftKey
    ? editor.commands.liftListItem(itemType)
    : editor.commands.sinkListItem(itemType);
}

export const WorkspaceEditingShortcuts = Extension.create({
  name: "workspaceEditingShortcuts",
  priority: 1_100,

  addProseMirrorPlugins() {
    const editor = this.editor;
    return [
      new Plugin({
        props: {
          handleKeyDown: (_view, event) => handleWorkspaceEditingShortcut(editor, event),
        },
      }),
    ];
  },
});
