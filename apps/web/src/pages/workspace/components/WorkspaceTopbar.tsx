import { HistoryIcon } from "./RightPane";
import {
  HISTORY_ENTRY_ENABLED,
  type WorkspacePageController,
} from "../hooks/useWorkspacePageController";

export function WorkspaceTopbar({
  controller,
}: {
  controller: WorkspacePageController;
}) {
  const {
    handleBackHome,
    showToast,
  } = controller;

  return (
    <>
      {/* 推翻旧标题栏:改为左上角浮动箭头返回(动线回首页),无横贯顶栏 */}
      <button
        type="button"
        className="ws-back-home"
        title="返回首页"
        onClick={handleBackHome}
      >
        ←
      </button>

      {/* 文档纸顶部带:右上角图标按钮(无文字)—— 历史 / 导出 */}
      <div className="ws-doc-topbar" data-wf="WorkspaceDocTopbar">
        {/* 历史版本功能暂未迭代,先隐藏入口(及"即将上线"toast);后端已就绪,功能做完把 false 翻开即可。 */}
        {HISTORY_ENTRY_ENABLED && (
          <button
            type="button"
            className="ws-doc-btn"
            title="查看历史记录"
            onClick={() => showToast("历史版本功能即将上线")}
          >
            <HistoryIcon />
          </button>
        )}
      </div>
    </>
  );
}
