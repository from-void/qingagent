import type { KeyboardEvent } from "react";
import type { FolderSource, FolderSourceStatus } from "@qingagent/contract-ts";
import type { FolderCapability, FolderSourceActionKind } from "../../../system";
import "../../../system/skill-menu.css";

interface FileActionMenuProps {
  folderSource: FolderSource | null;
  folderCapability: FolderCapability;
  folderActionPending: FolderSourceActionKind | null;
  onChooseFile: () => void;
  onAttachFolder: () => void;
  onOpenFolderPanel: () => void;
  onDetachFolder: () => void;
}

export function FileActionMenu({
  folderSource,
  folderCapability,
  folderActionPending,
  onChooseFile,
  onAttachFolder,
  onOpenFolderPanel,
  onDetachFolder,
}: FileActionMenuProps) {
  const folderDisabled = !folderCapability.enabled || folderActionPending !== null;
  const folderReason = folderCapability.reason ?? "当前环境暂不支持连接文件夹";
  const folderBusyText = folderActionPending === "attach"
    ? "正在连接文件夹…"
    : folderActionPending === "detach"
      ? "正在断开连接…"
      : null;
  const folderStatusText = folderSource ? folderStatusDescription(folderSource) : null;

  return (
    <div className="qa-skill-menu qa-file-menu" data-wf="WsFileMenu" role="menu">
      <button
        type="button"
        className="qa-file-row"
        role="menuitem"
        onClick={onChooseFile}
        data-wf="WsFileMenuChooseFile"
      >
        <FileLineIcon />
        <span className="qa-file-copy">
          <span className="qa-file-name">选择文件</span>
          <span className="qa-file-desc">PDF / Word / Excel / PPT / 图片…随消息发给 AI</span>
        </span>
      </button>

      {folderSource ? (
        <div
          className="qa-file-row qa-file-folder-row"
          role="menuitem"
          tabIndex={0}
          onClick={onOpenFolderPanel}
          onKeyDown={(event) => handleKeyboardPick(event, onOpenFolderPanel)}
          data-wf="WsFileMenuFolderStatus"
        >
          <FolderLineIcon />
          <span className="qa-file-copy">
            <span className="qa-file-name qa-file-folder-name">
              {folderSource.name}
              {folderSource.status === "connected" && (
                <span className="qa-file-folder-dot" aria-hidden="true" />
              )}
            </span>
            <span className="qa-file-desc">{folderStatusText}</span>
          </span>
          <button
            type="button"
            className="qa-file-row-action"
            onClick={(event) => {
              event.stopPropagation();
              onDetachFolder();
            }}
            disabled={folderActionPending !== null}
            data-wf="WsFileMenuDisconnect"
          >
            断开
          </button>
        </div>
      ) : (
        <button
          type="button"
          className={`qa-file-row${folderDisabled ? " is-disabled" : ""}`}
          role="menuitem"
          onClick={onAttachFolder}
          disabled={folderDisabled}
          data-wf="WsFileMenuAttachFolder"
        >
          <FolderLineIcon />
          <span className="qa-file-copy">
            <span className="qa-file-name">连接本地文件夹</span>
            <span className="qa-file-desc">
              {folderBusyText ?? (folderCapability.enabled
                ? "AI 可直接读取该文件夹，文件不复制不上传"
                : folderReason)}
            </span>
          </span>
        </button>
      )}
    </div>
  );
}

function handleKeyboardPick(event: KeyboardEvent<HTMLElement>, action: () => void): void {
  if (event.key !== "Enter" && event.key !== " ") return;
  event.preventDefault();
  action();
}

function folderStatusDescription(source: FolderSource): string {
  if (source.status === "connected") return "已连接 · 点击查看与管理";
  const label = FOLDER_STATUS_LABELS[source.status] ?? FOLDER_STATUS_LABELS.offline;
  return source.error ? `${label} · ${source.error}` : label;
}

const FOLDER_STATUS_LABELS: Record<FolderSourceStatus, string> = {
  connected: "已连接 · 点击查看与管理",
  offline: "连接已离线",
  missing: "文件夹找不到",
  permission_required: "需要重新授权",
  error: "连接异常",
};

function FileLineIcon() {
  return (
    <svg
      className="qa-file-ico"
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M13.5 3.5H6.5A1.5 1.5 0 0 0 5 5v14a1.5 1.5 0 0 0 1.5 1.5h11A1.5 1.5 0 0 0 19 19V9z" />
      <path d="M13.5 3.5V9H19" />
    </svg>
  );
}

function FolderLineIcon() {
  return (
    <svg
      className="qa-file-ico"
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
    </svg>
  );
}
