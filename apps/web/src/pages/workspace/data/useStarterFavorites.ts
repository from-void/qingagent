// 模板收藏:客户端级持久化(非文档级),跨所有文档/会话共享。
// web 用 localStorage;桌面端同样走 localStorage(渲染进程内),日后如需跨端同步再抽后端。
import { useCallback, useEffect, useState } from "react";

const STORAGE_KEY = "qingagent:starter-favorites";

function readFavorites(): string[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function writeFavorites(ids: string[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(ids));
  } catch {
    // 存储不可用(隐私模式等)时静默降级:本次会话内存态仍可用
  }
}

export interface StarterFavorites {
  /** 已收藏的模板 id 列表(保持加入顺序) */
  ids: string[];
  isFavorite: (id: string) => boolean;
  toggle: (id: string) => void;
}

export function useStarterFavorites(): StarterFavorites {
  const [ids, setIds] = useState<string[]>(() => (typeof localStorage !== "undefined" ? readFavorites() : []));

  // 跨标签页/多处入口同步:监听 storage 事件,保持收藏一致。
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === STORAGE_KEY) setIds(readFavorites());
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const isFavorite = useCallback((id: string) => ids.includes(id), [ids]);

  const toggle = useCallback((id: string) => {
    setIds((prev) => {
      const next = prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id];
      writeFavorites(next);
      return next;
    });
  }, []);

  return { ids, isFavorite, toggle };
}
