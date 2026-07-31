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
 * 选区缓存只在当前 WorkspacePage 会话内存活：页面内编辑器实例重建时复用，
 * Workspace 路由卸载时随页面一起清空，不把纯编辑器高亮带过路由。
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
