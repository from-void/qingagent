import { useEffect, useMemo, useState } from "react";
import type { Editor } from "@tiptap/react";
import { countDocVisibleChars, normalizePmDoc } from "@qingagent/pm-schema";
import type { ViewDocumentSnapshot } from "../data/protocol";

/** 编辑器右下角字数小徽标(debug 取向):
 *  口径与生成验收同一把尺(charCount.countVisibleChars:NFC、去空白、含标点)。
 *  编辑态跟随 editor update(300ms 防抖);非编辑态直接由快照 pmDoc 计算。 */
export function DocWordCount({
  editor,
  doc,
}: {
  editor: Editor | null;
  doc: ViewDocumentSnapshot | null;
}) {
  const [editorCount, setEditorCount] = useState<number | null>(null);

  useEffect(() => {
    if (!editor || editor.isDestroyed) {
      setEditorCount(null);
      return;
    }
    let timer: ReturnType<typeof setTimeout> | null = null;
    const compute = () => {
      if (editor.isDestroyed) return;
      try {
        setEditorCount(countDocVisibleChars(normalizePmDoc(editor.getJSON())));
      } catch {
        // 文档含未知节点时 normalize 可能抛错,徽标静默回退快照口径,不影响编辑
        setEditorCount(null);
      }
    };
    const handleUpdate = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(compute, 300);
    };
    compute();
    editor.on("update", handleUpdate);
    return () => {
      editor.off("update", handleUpdate);
      if (timer) clearTimeout(timer);
    };
  }, [editor]);

  const snapshotCount = useMemo(() => {
    if (!doc?.pmDoc) return null;
    try {
      return countDocVisibleChars(doc.pmDoc);
    } catch {
      return null;
    }
  }, [doc]);

  const count = editorCount ?? snapshotCount;
  if (count === null) return null;

  return (
    <div className="ws-wordcount font-mono" data-wf="DocWordCount" title="正文可见字数（不含空白，含标点）">
      {count} 字
    </div>
  );
}
