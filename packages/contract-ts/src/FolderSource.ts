export type FolderSourceProvider = "desktop-local" | "browser-fs-access";

export type FolderSourceStatus =
  | "connected"
  | "offline"
  | "missing"
  | "permission_required"
  | "error";

/** 下发给前端/模型的 wire 形态：不得包含桌面真实绝对路径，pathLabel 只能是可辨识的摘要路径。 */
export interface FolderSource {
  id: string;
  sessionId: string;
  provider: FolderSourceProvider;
  name: string;
  pathLabel: string | null;
  mountName: string;
  mountPath: string;
  readOnly: true;
  fileCount: number | null;
  fileCountCapped: boolean;
  status: FolderSourceStatus;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

/** 服务端运行/持久化记录；受信字段绝不下发给模型提示。 */
export interface FolderSourceRecord extends FolderSource {
  desktopRootPath?: string;
  browserHandleKey?: string;
  browserClientSourceId?: string;
}

export type AttachFolder = {
  sessionId: string;
  source:
    | { provider: "desktop-local"; selectionToken: string }
    | {
        provider: "browser-fs-access";
        clientSourceId: string;
        name: string;
        browserHandleKey: string;
      };
};

export type DetachFolder = {
  sessionId: string;
  folderId: string;
};

export type FolderSourcesChanged = {
  sessionId: string;
  sources: FolderSource[];
};

export type FolderSourceOperationResult =
  | { ok: true; op: "attach" | "detach"; folderId: string }
  | {
      ok: false;
      op: "attach" | "detach";
      reason:
        | "agent_busy"
        | "unsupported_environment"
        | "not_found"
        | "too_many_sources"
        | "permission_denied"
        | "invalid_path"
        | "bridge_offline"
        | "unknown";
    };
