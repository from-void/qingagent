import { createContext, useContext, useRef } from "react";
import type { ReactNode } from "react";

export interface StoredWorkspaceEditorSelection {
  json: unknown;
}

export type WorkspaceEditorSelectionCache = Map<
  string,
  StoredWorkspaceEditorSelection
>;

const WorkspaceEditorSelectionCacheContext =
  createContext<WorkspaceEditorSelectionCache | null>(null);

/**
 * 选区缓存必须位于路由之上：WorkspacePage 回首页时会完整卸载，
 * 但同一次应用生命周期内再次打开文档仍应能恢复原选区。
 */
export function WorkspaceEditorSelectionProvider({
  children,
}: {
  children: ReactNode;
}) {
  const cacheRef = useRef<WorkspaceEditorSelectionCache>();
  if (!cacheRef.current) {
    cacheRef.current = new Map();
  }
  return (
    <WorkspaceEditorSelectionCacheContext.Provider value={cacheRef.current}>
      {children}
    </WorkspaceEditorSelectionCacheContext.Provider>
  );
}

export function useWorkspaceEditorSelectionCache(): WorkspaceEditorSelectionCache {
  const cache = useContext(WorkspaceEditorSelectionCacheContext);
  if (!cache) {
    throw new Error("WorkspaceEditorSelectionProvider 尚未挂载");
  }
  return cache;
}
