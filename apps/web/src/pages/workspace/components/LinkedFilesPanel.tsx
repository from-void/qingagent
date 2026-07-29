import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import type { FolderSource, FolderSourceStatus } from "@qingagent/contract-ts";
import type { MaterialParseRow } from "../data/useMaterialParseTracker";
import { toAssetSource } from "../data/sources";
import type { AssetSource, SourceTag } from "../data/sources";
import { FileIcon, fileKind } from "./AssetPanel";

const DEFAULT_ENTRY_LIMIT = 200;
const PANEL_CLOSE_MS = 180;
const FOLDER_ENTRY_TIMEOUT_MS = 15_000;
const FOLDER_ENTRY_TIMEOUT_MESSAGE = "读取超时，请点击重试";
const FOLDER_BRIDGE_UNAVAILABLE_MESSAGE = "此浏览器会话未连接到该文件夹，请断开后重新连接";

function buildFolderIdentity(sessionId: string, folderId: string): string {
  return `${sessionId}\u0000${folderId}`;
}

function buildDirStateKey(folderIdentity: string, relPath: string): string {
  return `${folderIdentity}\u0000${relPath}`;
}

interface FolderEntry {
  name: string;
  kind: "dir" | "file";
  childCount: number | null;
  byteLen: number | null;
}

interface FolderEntriesResponse {
  entries: FolderEntry[];
  truncated: boolean;
  nextCursor: string | null;
}

interface DirState {
  entries: FolderEntry[];
  nextCursor: string | null;
  loading: boolean;
  error: string | null;
}

export interface LinkedFileReference {
  label: string;
  folderId?: string;
  childRelPath?: string;
}

interface LinkedFilesPanelProps {
  materialRows: readonly MaterialParseRow[];
  folderSource: FolderSource | null;
  disabled?: boolean;
  locateFolderSignal?: number;
  /** 解析失败 toast 的「查看素材」动作递增该信号，强制展开素材区。 */
  openMaterialSignal?: number;
  /**
   * 本客户端刚完成一次「关联文件夹」动作的显式信号(每次成功 +1)。
   * 只有它出现过,后续 folderSource 首次到达才自动展开;进入已关联会话的数据加载不会触发。
   */
  folderAttachSignal?: number;
  onReference: (reference: LinkedFileReference) => void;
  onPreviewMaterial?: (source: AssetSource) => void;
  onPreviewFolderFile?: (source: AssetSource) => void;
  onRemoveMaterial?: (source: AssetSource) => void;
  onRetryMaterialParse?: (fileId: string) => void;
  onAttachFolder: () => void;
  onDetachFolder: () => void;
  onToast?: (message: string) => void;
}

export function LinkedFilesPanel({
  materialRows,
  folderSource,
  disabled = false,
  locateFolderSignal = 0,
  openMaterialSignal = 0,
  folderAttachSignal = 0,
  onReference,
  onPreviewMaterial,
  onPreviewFolderFile,
  onRemoveMaterial,
  onRetryMaterialParse,
  onAttachFolder,
  onDetachFolder,
  onToast,
}: LinkedFilesPanelProps) {
  const hasContent = materialRows.length > 0 || folderSource !== null;
  const [expanded, setExpanded] = useState(false);
  const [renderPanel, setRenderPanel] = useState(false);
  const [closing, setClosing] = useState(false);
  const [hoverInfo, setHoverInfo] = useState("");
  const [uploadsExpanded, setUploadsExpanded] = useState(true);
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(() => new Set());
  const [dirStates, setDirStates] = useState<Record<string, DirState>>({});
  const [located, setLocated] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const folderIdentity = folderSource
    ? buildFolderIdentity(folderSource.sessionId, folderSource.id)
    : null;
  const currentFolderIdentityRef = useRef<string | null>(folderIdentity);
  currentFolderIdentityRef.current = folderIdentity;
  const previousFolderIdentityRef = useRef<string | null>(folderIdentity);
  // 一次性标记:本客户端刚发起的关联动作在等 folderSource 到达后自动展开。
  const pendingAttachExpandRef = useRef(false);
  const entryControllersRef = useRef<Set<AbortController>>(new Set());
  const locateTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastLocateFolderSignalRef = useRef(0);
  const lastOpenMaterialSignalRef = useRef(0);
  const visibleDirStates = useMemo(() => {
    if (!folderIdentity) return {};
    const prefix = `${folderIdentity}\u0000`;
    return Object.fromEntries(
      Object.entries(dirStates)
        .filter(([key]) => key.startsWith(prefix))
        .map(([key, state]) => [key.slice(prefix.length), state]),
    );
  }, [dirStates, folderIdentity]);

  const summary = useMemo(
    () => buildSummary(materialRows, folderSource),
    [folderSource, materialRows],
  );
  const hasParsing = materialRows.some((row) => row.state === "parsing");
  const displayInfo = hoverInfo || summary;

  useEffect(() => {
    if (!expanded) {
      if (!renderPanel) return;
      setClosing(true);
      const timer = setTimeout(() => {
        setRenderPanel(false);
        setClosing(false);
      }, PANEL_CLOSE_MS);
      return () => clearTimeout(timer);
    }
    setRenderPanel(true);
    setClosing(false);
  }, [expanded, renderPanel]);

  useEffect(() => {
    if (hasContent) return;
    setExpanded(false);
    setRenderPanel(false);
    setClosing(false);
    setHoverInfo("");
  }, [hasContent]);

  useEffect(() => {
    if (materialRows.length === 0) setUploadsExpanded(true);
  }, [materialRows.length]);

  useEffect(() => {
    if (
      openMaterialSignal <= 0 ||
      openMaterialSignal === lastOpenMaterialSignalRef.current ||
      materialRows.length === 0
    ) {
      return;
    }
    lastOpenMaterialSignalRef.current = openMaterialSignal;
    setUploadsExpanded(true);
    setExpanded(true);
  }, [materialRows.length, openMaterialSignal]);

  useEffect(() => {
    setDirStates({});
    setExpandedDirs(new Set());
    setHoverInfo("");
    return () => {
      for (const controller of entryControllersRef.current) controller.abort();
      entryControllersRef.current.clear();
    };
  }, [folderIdentity]);

  const flashLocated = useCallback(() => {
    if (locateTimerRef.current) clearTimeout(locateTimerRef.current);
    setLocated(true);
    const scroll = () => rootRef.current?.scrollIntoView?.({ block: "nearest" });
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(scroll);
    else scroll();
    locateTimerRef.current = setTimeout(() => setLocated(false), 1200);
  }, []);

  const loadEntries = useCallback(
    async (relPath: string, cursor: string | null = null) => {
      if (!folderSource || !folderIdentity) return;
      const requestFolderIdentity = folderIdentity;
      const stateKey = buildDirStateKey(requestFolderIdentity, relPath);
      setDirStates((prev) => ({
        ...prev,
        [stateKey]: {
          entries: prev[stateKey]?.entries ?? [],
          nextCursor: prev[stateKey]?.nextCursor ?? cursor,
          loading: true,
          error: null,
        },
      }));
      const params = new URLSearchParams({ path: relPath, limit: String(DEFAULT_ENTRY_LIMIT) });
      if (cursor !== null) params.set("cursor", cursor);
      const controller = new AbortController();
      entryControllersRef.current.add(controller);
      let timedOut = false;
      let timeoutId: ReturnType<typeof setTimeout> | null = null;
      const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => {
          timedOut = true;
          controller.abort();
          reject(new Error(FOLDER_ENTRY_TIMEOUT_MESSAGE));
        }, FOLDER_ENTRY_TIMEOUT_MS);
      });
      try {
        const res = await Promise.race([fetch(
          `/api/v1/sessions/${encodeURIComponent(folderSource.sessionId)}/folder-sources/${encodeURIComponent(folderSource.id)}/entries?${params.toString()}`,
          { signal: controller.signal },
        ), timeoutPromise]);
        if (!res.ok) {
          let message = `读取失败(${res.status})`;
          try {
            const body = await res.json() as { error?: unknown; message?: unknown };
            const raw = typeof body.error === "string" ? body.error : body.message;
            if (typeof raw === "string" && raw.length > 0) message = raw;
          } catch {
            // 忽略非 JSON 错误体。
          }
          throw new Error(message);
        }
        const body = await res.json() as FolderEntriesResponse;
        if (currentFolderIdentityRef.current !== requestFolderIdentity) return;
        setDirStates((prev) => ({
          ...prev,
          [stateKey]: {
            entries: cursor === null
              ? (Array.isArray(body.entries) ? body.entries : [])
              : [...(prev[stateKey]?.entries ?? []), ...(Array.isArray(body.entries) ? body.entries : [])],
            nextCursor: typeof body.nextCursor === "string" && body.nextCursor.length > 0
              ? body.nextCursor
              : null,
            loading: false,
            error: null,
          },
        }));
      } catch (error) {
        if (
          currentFolderIdentityRef.current !== requestFolderIdentity ||
          (controller.signal.aborted && !timedOut)
        ) return;
        const message = normalizeFolderEntryError(timedOut ? FOLDER_ENTRY_TIMEOUT_MESSAGE : error);
        setDirStates((prev) => ({
          ...prev,
          [stateKey]: {
            entries: prev[stateKey]?.entries ?? [],
            nextCursor: prev[stateKey]?.nextCursor ?? cursor,
            loading: false,
            error: message,
          },
        }));
      } finally {
        if (timeoutId) clearTimeout(timeoutId);
        entryControllersRef.current.delete(controller);
      }
    },
    [folderIdentity, folderSource],
  );

  const expandFolderRoot = useCallback(() => {
    if (!folderSource) return;
    setExpanded(true);
    setExpandedDirs((prev) => {
      const next = new Set(prev);
      next.add("");
      return next;
    });
    if (!visibleDirStates[""] || visibleDirStates[""].error) void loadEntries("");
    flashLocated();
  }, [flashLocated, folderSource, loadEntries, visibleDirStates]);

  // 收到关联动作信号后置起一次性待展开标记;必须声明在下面的 identity 效应之前,
  // 保证同一次提交里「信号 +1」与「folderSource 到达」同时发生时也能被看到。
  useEffect(() => {
    if (folderAttachSignal <= 0) return;
    pendingAttachExpandRef.current = true;
  }, [folderAttachSignal]);

  useEffect(() => {
    const prev = previousFolderIdentityRef.current;
    const current = folderIdentity;
    previousFolderIdentityRef.current = current;
    if (prev !== null || current === null) return;
    // 只有本会话内用户亲自关联过文件夹才自动展开;
    // 进入已关联会话时 folderSource 也是 null → 非 null,但没有关联动作,保持收起。
    if (!pendingAttachExpandRef.current) return;
    pendingAttachExpandRef.current = false;
    expandFolderRoot();
  }, [expandFolderRoot, folderIdentity]);

  useEffect(() => {
    if (locateFolderSignal <= lastLocateFolderSignalRef.current) return;
    lastLocateFolderSignalRef.current = locateFolderSignal;
    expandFolderRoot();
  }, [expandFolderRoot, locateFolderSignal]);

  useEffect(() => () => {
    if (locateTimerRef.current) clearTimeout(locateTimerRef.current);
  }, []);

  const toggleDir = useCallback(
    (relPath: string) => {
      const isOpen = expandedDirs.has(relPath);
      const shouldLoad = !isOpen && (
        !visibleDirStates[relPath] || Boolean(visibleDirStates[relPath]?.error)
      );
      setExpandedDirs((prev) => {
        const next = new Set(prev);
        if (next.has(relPath)) {
          next.delete(relPath);
        } else {
          next.add(relPath);
        }
        return next;
      });
      if (shouldLoad) void loadEntries(relPath);
    },
    [expandedDirs, loadEntries, visibleDirStates],
  );

  if (!hasContent) return null;

  if (!renderPanel) {
    return (
      <button
        type="button"
        className="lf-bar"
        data-wf="LinkedFilesBar"
        onClick={() => setExpanded(true)}
      >
        <span className="lf-label">已关联素材</span>
        <span className="lf-summary">
          {hasParsing && <span className="lf-spin" aria-hidden="true" />}
          {summary}
        </span>
        <span className="lf-chev" aria-hidden="true"><ChevronIcon open={false} /></span>
      </button>
    );
  }

  return (
    <div
      className={`lf-panel${closing ? " is-closing" : ""}`}
      data-wf="LinkedFilesPanel"
    >
      <div
        className="lf-bar lf-head"
        data-wf="LinkedFilesPanelHeader"
        role="button"
        tabIndex={0}
        onClick={() => setExpanded(false)}
        onKeyDown={(event) => {
          if (event.key !== "Enter" && event.key !== " ") return;
          event.preventDefault();
          setExpanded(false);
        }}
      >
        <span className="lf-label">已关联素材</span>
        <span className="lf-chev is-open" aria-hidden="true"><ChevronIcon open /></span>
      </div>
      <div className="lf-tree" data-wf="LinkedFilesTree">
        {materialRows.length > 0 && (
          <>
            <UploadRootRow
              count={materialRows.length}
              expanded={uploadsExpanded}
              onHover={setHoverInfo}
              onToggle={() => setUploadsExpanded((value) => !value)}
            />
            {uploadsExpanded && materialRows.map((row) => (
              <MaterialTreeRow
                key={row.id}
                row={row}
                level={1}
                disabled={disabled}
                onHover={setHoverInfo}
                onReference={onReference}
                onPreviewMaterial={onPreviewMaterial}
                onRemoveMaterial={onRemoveMaterial}
                onRetryMaterialParse={onRetryMaterialParse}
              />
            ))}
          </>
        )}
        {folderSource && (
          <>
            <FolderRootRow
              refEl={rootRef}
              source={folderSource}
              expanded={expandedDirs.has("")}
              located={located}
              onHover={setHoverInfo}
              onToggle={() => {
                if (folderSource.status === "connected") toggleDir("");
              }}
              onAttach={onAttachFolder}
              onDetach={onDetachFolder}
            />
            {folderSource.status === "connected" && expandedDirs.has("") && (
              <DirChildren
                relPath=""
                level={1}
                state={visibleDirStates[""]}
                dirStates={visibleDirStates}
                expandedDirs={expandedDirs}
                disabled={disabled}
                onHover={setHoverInfo}
                onToggleDir={toggleDir}
                onLoad={loadEntries}
                onReference={onReference}
                onPreviewFolderFile={onPreviewFolderFile}
                onToast={onToast}
                folderSource={folderSource}
              />
            )}
          </>
        )}
      </div>
      <EllipsisInfo text={displayInfo} />
    </div>
  );
}

function UploadRootRow({
  count,
  expanded,
  onHover,
  onToggle,
}: {
  count: number;
  expanded: boolean;
  onHover: (text: string) => void;
  onToggle: () => void;
}) {
  const info = ["上传文件", formatCount(count)].filter(Boolean).join(" · ");
  return (
    <div
      className="lf-row lf-upload-root lf-dir-row"
      data-wf="LinkedUploadsRootRow"
      onClick={onToggle}
      onMouseEnter={() => onHover(info)}
      onMouseLeave={() => onHover("")}
    >
      <span className="lf-tw" aria-hidden="true"><ChevronIcon open={expanded} /></span>
      <span className="lf-foldericon" aria-hidden="true"><FolderIcon /></span>
      <EllipsisText className="lf-name lf-folder-name" text="上传文件" />
      <span className="lf-meta">{formatCount(count)}</span>
    </div>
  );
}

function MaterialTreeRow({
  row,
  level = 0,
  disabled,
  onHover,
  onReference,
  onPreviewMaterial,
  onRemoveMaterial,
  onRetryMaterialParse,
}: {
  row: MaterialParseRow;
  level?: number;
  disabled: boolean;
  onHover: (text: string) => void;
  onReference: (reference: LinkedFileReference) => void;
  onPreviewMaterial?: (source: AssetSource) => void;
  onRemoveMaterial?: (source: AssetSource) => void;
  onRetryMaterialParse?: (fileId: string) => void;
}) {
  const kind = fileKind(row.filename, row.mime ?? undefined);
  const source = row.resource ? toAssetSource(row.resource) : null;
  const info = materialInfo(row);
  const canDelete = source !== null && row.state !== "parsing";
  const canReference = row.state === "ready";
  const canPreview = row.state === "ready" && source !== null && onPreviewMaterial !== undefined;
  const className = [
    "lf-row",
    "lf-file-row",
    level > 0 ? "lf-subrow" : "",
    level > 0 ? levelClass(level) : "",
    row.state === "parsing" ? "is-parsing" : "",
    row.state === "error" ? "is-error" : "",
    canPreview ? "is-previewable" : "",
    canReference || canDelete ? "has-actions" : "",
  ].filter(Boolean).join(" ");
  return (
    <div
      className={className}
      data-wf="LinkedFileRow"
      onClick={() => {
        if (canPreview && source) onPreviewMaterial?.(source);
      }}
      onMouseEnter={() => onHover(info)}
      onMouseLeave={() => onHover("")}
    >
      <span className="lf-tw" aria-hidden="true" />
      {row.state === "parsing" ? (
        <span className="lf-spin" aria-hidden="true" />
      ) : (
        <span className="lf-fileicon"><FileIcon kind={kind} /></span>
      )}
      <EllipsisText className="lf-name" text={row.filename} />
      {row.state === "error" && <span className="lf-badge err">解析失败</span>}
      {row.state === "error" && row.fileId && (
        <button
          type="button"
          className="lf-retry"
          disabled={disabled}
          onClick={(event) => {
            event.stopPropagation();
            onRetryMaterialParse?.(row.fileId!);
          }}
        >
          重试
        </button>
      )}
      {(canReference || canDelete) && (
        <span className="lf-rowacts">
          {canReference && (
            <button
              type="button"
              className="lf-ract"
              disabled={disabled}
              onClick={(event) => {
                event.stopPropagation();
                onReference({ label: row.filename });
              }}
            >
              <RefIcon />
              引用
            </button>
          )}
          {canDelete && (
            <button
              type="button"
              className="lf-ract danger"
              disabled={disabled}
              onClick={(event) => {
                event.stopPropagation();
                if (source) onRemoveMaterial?.(source);
              }}
            >
              <TrashIcon />
              删除
            </button>
          )}
        </span>
      )}
    </div>
  );
}

function FolderRootRow({
  refEl,
  source,
  expanded,
  located,
  onHover,
  onToggle,
  onAttach,
  onDetach,
}: {
  refEl: RefObject<HTMLDivElement>;
  source: FolderSource;
  expanded: boolean;
  located: boolean;
  onHover: (text: string) => void;
  onToggle: () => void;
  onAttach: () => void;
  onDetach: () => void;
}) {
  const connected = source.status === "connected";
  const statusText = folderStatusLabel(source);
  return (
    <div
      ref={refEl}
      className={`lf-row lf-folder-root has-actions${connected ? "" : " is-invalid"}${located ? " is-located" : ""}`}
      data-wf="LinkedFolderRootRow"
      onClick={onToggle}
      onMouseEnter={() => onHover(buildFolderHoverInfo(source))}
      onMouseLeave={() => onHover("")}
    >
      <span className="lf-tw" aria-hidden="true">
        {connected && <ChevronIcon open={expanded} />}
      </span>
      <span className="lf-foldericon" aria-hidden="true"><FolderIcon /></span>
      <span className="lf-folder-label">
        <EllipsisText className="lf-name lf-folder-name" text={source.name} />
        <span className="lf-folder-status">
          <span className={`lf-folder-dot${connected ? "" : " is-off"}`} aria-hidden="true" />
          <span className="lf-folder-status-text">{statusText}</span>
        </span>
      </span>
      <span className="lf-rowacts">
        {!connected && (
          <button
            type="button"
            className="lf-ract"
            onClick={(event) => {
              event.stopPropagation();
              onAttach();
            }}
          >
            重新连接
          </button>
        )}
        <button
          type="button"
          className="lf-ract danger"
          onClick={(event) => {
            event.stopPropagation();
            onDetach();
          }}
        >
          断开
        </button>
      </span>
    </div>
  );
}

function DirChildren({
  relPath,
  level,
  state,
  dirStates,
  expandedDirs,
  folderSource,
  disabled,
  onHover,
  onToggleDir,
  onLoad,
  onReference,
  onPreviewFolderFile,
  onToast,
}: {
  relPath: string;
  level: number;
  state: DirState | undefined;
  dirStates: Record<string, DirState>;
  expandedDirs: Set<string>;
  folderSource: FolderSource;
  disabled: boolean;
  onHover: (text: string) => void;
  onToggleDir: (relPath: string) => void;
  onLoad: (relPath: string, cursor?: string | null) => void;
  onReference: (reference: LinkedFileReference) => void;
  onPreviewFolderFile?: (source: AssetSource) => void;
  onToast?: (message: string) => void;
}) {
  if (!state || state.loading) {
    return (
      <div className={`lf-row lf-subrow ${levelClass(level)} is-loading`} data-wf="LinkedFolderLoading">
        <span className="lf-tw" />
        <span className="lf-spin" aria-hidden="true" />
        <span className="lf-name">读取中…</span>
      </div>
    );
  }
  if (state.error) {
    return (
      <div className={`lf-row lf-subrow ${levelClass(level)} is-error`} data-wf="LinkedFolderError">
        <span className="lf-tw" />
        <span className="lf-name">读取失败：{state.error}</span>
        <button
          type="button"
          className="lf-retry"
          disabled={disabled}
          onClick={() => onLoad(relPath, state.nextCursor)}
        >
          重试
        </button>
      </div>
    );
  }
  return (
    <>
      {state.entries.map((entry) => {
        const childRelPath = relPath ? `${relPath}/${entry.name}` : entry.name;
        if (entry.kind === "dir") {
          const isOpen = expandedDirs.has(childRelPath);
          return (
            <div key={childRelPath}>
              <div
                className={`lf-row lf-subrow lf-dir-row ${levelClass(level)}`}
                data-wf="LinkedFolderEntryRow"
                onClick={() => onToggleDir(childRelPath)}
                onMouseEnter={() => onHover(dirEntryInfo(childRelPath, entry))}
                onMouseLeave={() => onHover("")}
              >
                <span className="lf-tw" aria-hidden="true"><ChevronIcon open={isOpen} /></span>
                <span className="lf-foldericon" aria-hidden="true"><FolderIcon /></span>
                <EllipsisText className="lf-name" text={entry.name} />
                <span className="lf-meta">{formatCount(entry.childCount)}</span>
              </div>
              {isOpen && (
                <DirChildren
                  relPath={childRelPath}
                  level={level + 1}
                  state={dirStates[childRelPath]}
                  dirStates={dirStates}
                  expandedDirs={expandedDirs}
                  folderSource={folderSource}
                  disabled={disabled}
                  onHover={onHover}
                  onToggleDir={onToggleDir}
                  onLoad={onLoad}
                  onReference={onReference}
                  onPreviewFolderFile={onPreviewFolderFile}
                  onToast={onToast}
                />
              )}
            </div>
          );
        }
        const previewSource = onPreviewFolderFile
          ? buildFolderFileAssetSource(folderSource, childRelPath, entry)
          : null;
        const canPreview = previewSource !== null;
        return (
          <div
            key={childRelPath}
            className={`lf-row lf-subrow lf-file-row has-actions has-one-action ${canPreview ? "is-previewable" : ""} ${levelClass(level)}`}
            data-wf="LinkedFolderFileRow"
            onClick={() => {
              if (previewSource) {
                onPreviewFolderFile?.(previewSource);
                return;
              }
              onToast?.("该文件不支持预览");
            }}
            onMouseEnter={() => onHover(fileEntryInfo(childRelPath, entry))}
            onMouseLeave={() => onHover("")}
          >
            <span className="lf-tw" />
            <span className="lf-fileicon"><FileIcon kind={fileKind(entry.name)} /></span>
            <EllipsisText className="lf-name" text={entry.name} />
            <span className="lf-rowacts">
              <button
                type="button"
                className="lf-ract"
                disabled={disabled}
                onClick={(event) => {
                  event.stopPropagation();
                  onReference({
                    label: entry.name,
                    folderId: folderSource.id,
                    childRelPath,
                  });
                }}
              >
                <RefIcon />
                引用
              </button>
            </span>
          </div>
        );
      })}
      {state.nextCursor !== null && (
        <button
          type="button"
          className={`lf-row lf-subrow lf-more ${levelClass(level)}`}
          data-wf="LinkedFolderMore"
          disabled={disabled || state.loading}
          onClick={() => onLoad(relPath, state.nextCursor)}
        >
          <span className="lf-tw" />
          <span className="lf-name">还有更多项…点击继续加载</span>
        </button>
      )}
    </>
  );
}

type FolderFilePreviewMode = "text" | "image" | "pdf";

interface FolderFilePreviewSpec {
  mode: FolderFilePreviewMode;
  tag: SourceTag;
  mimeType: string;
  label: string;
  maxBytes: number;
}

const FOLDER_TEXT_PREVIEW_MAX_BYTES = 1_048_576;
const FOLDER_BINARY_PREVIEW_MAX_BYTES = 20 * 1_024 * 1_024;

function buildFolderFileAssetSource(
  folderSource: FolderSource,
  relPath: string,
  entry: FolderEntry,
): AssetSource | null {
  const spec = folderFilePreviewSpec(entry.name);
  if (!spec) return null;
  const url = buildFolderFilePreviewUrl(folderSource, relPath, spec.maxBytes);
  const byteLabel = entry.byteLen != null ? `${entry.byteLen} 字节` : "";
  return {
    id: `folder:${folderSource.id}:${relPath}`,
    tag: spec.tag,
    name: entry.name,
    meta: [spec.label, byteLabel].filter(Boolean).join(" · "),
    abstract: "",
    bodyText: "",
    mimeType: spec.mimeType,
    preview: {
      kind: "url",
      url,
      textUrl: spec.mode === "text" ? url : undefined,
      strictTextContentType: spec.mode === "text",
    },
  };
}

function buildFolderFilePreviewUrl(
  folderSource: Pick<FolderSource, "sessionId" | "id">,
  relPath: string,
  maxBytes: number,
): string {
  const params = new URLSearchParams({
    path: relPath,
    maxBytes: String(maxBytes),
  });
  return `/api/v1/sessions/${encodeURIComponent(folderSource.sessionId)}/folder-sources/${encodeURIComponent(folderSource.id)}/file?${params.toString()}`;
}

function folderFilePreviewSpec(name: string): FolderFilePreviewSpec | null {
  const ext = fileExtension(name);
  if (ext === "pdf") {
    return {
      mode: "pdf",
      tag: "pdf",
      mimeType: "application/pdf",
      label: "PDF",
      maxBytes: FOLDER_BINARY_PREVIEW_MAX_BYTES,
    };
  }
  const imageMimes: Record<string, string> = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    svg: "image/svg+xml",
  };
  const imageMime = imageMimes[ext];
  if (imageMime) {
    return {
      mode: "image",
      tag: "png",
      mimeType: imageMime,
      label: "图片",
      maxBytes: FOLDER_BINARY_PREVIEW_MAX_BYTES,
    };
  }
  const textMimes: Record<string, string> = {
    txt: "text/plain; charset=utf-8",
    md: "text/markdown; charset=utf-8",
    markdown: "text/markdown; charset=utf-8",
    csv: "text/csv; charset=utf-8",
    tsv: "text/tab-separated-values; charset=utf-8",
    json: "application/json; charset=utf-8",
    log: "text/plain; charset=utf-8",
  };
  const textMime = textMimes[ext];
  if (textMime) {
    return {
      mode: "text",
      tag: "yuque",
      mimeType: textMime,
      label: "文本",
      maxBytes: FOLDER_TEXT_PREVIEW_MAX_BYTES,
    };
  }
  return null;
}

function fileExtension(name: string): string {
  const last = name.split("/").pop() ?? name;
  const index = last.lastIndexOf(".");
  return index >= 0 ? last.slice(index + 1).toLowerCase() : "";
}

function levelClass(level: number): string {
  if (level <= 1) return "lvl1";
  if (level === 2) return "lvl2";
  return "lvl3";
}

function EllipsisText({ className, text }: { className: string; text: string }) {
  const titleProps = useEllipsisTitle<HTMLSpanElement>(text);
  return (
    <span
      ref={titleProps.ref}
      className={className}
      title={titleProps.title}
      onMouseEnter={titleProps.onMouseEnter}
    >
      {text}
    </span>
  );
}

function EllipsisInfo({ text }: { text: string }) {
  const titleProps = useEllipsisTitle<HTMLDivElement>(text);
  return (
    <div
      ref={titleProps.ref}
      className="lf-info"
      data-wf="LinkedFilesInfo"
      title={titleProps.title}
      onMouseEnter={titleProps.onMouseEnter}
    >
      {text}
    </div>
  );
}

function useEllipsisTitle<T extends HTMLElement>(text: string) {
  const ref = useRef<T>(null);
  const [title, setTitle] = useState<string | undefined>(undefined);

  useEffect(() => {
    setTitle(undefined);
  }, [text]);

  const onMouseEnter = useCallback(() => {
    const node = ref.current;
    setTitle(node && node.scrollWidth > node.clientWidth ? text : undefined);
  }, [text]);

  return { ref, title, onMouseEnter };
}

function buildSummary(rows: readonly MaterialParseRow[], folderSource: FolderSource | null): string {
  const fileCount = rows.length;
  const errorCount = rows.filter((row) => row.state === "error").length;
  const parsing = rows.some((row) => row.state === "parsing");
  const parts: string[] = [];
  if (fileCount > 0) {
    if (parsing) parts.push(`${fileCount} 个素材 · 解析中`);
    else if (errorCount > 0) parts.push(`${fileCount} 个素材(${errorCount} 个失败)`);
    else parts.push(`${fileCount} 个素材`);
  }
  if (folderSource) {
    if (folderSource.status === "connected") {
      parts.push(`文件夹「${folderSource.name}」`);
      const fileCount = formatFolderFileCount(folderSource);
      if (fileCount) parts.push(fileCount);
    }
    else parts.push("文件夹已失效");
  }
  return parts.join(" · ");
}

function materialInfo(row: MaterialParseRow): string {
  if (row.state === "parsing") return `${row.filename} · 正在解析`;
  if (row.state === "error") return `${row.filename} · 解析失败`;
  const byteLabel = row.resource?.byteLen != null ? `${row.resource.byteLen} 字` : "";
  return [row.filename, byteLabel].filter(Boolean).join(" · ");
}

export function buildFolderHoverInfo(source: FolderSource): string {
  const status = folderStatusText(source);
  if (source.status === "connected") return status.description;
  return source.error ?? status.description;
}

function folderStatusLabel(source: FolderSource): string {
  const status = folderStatusText(source);
  return status.badge;
}

function folderStatusText(source: Pick<FolderSource, "status" | "error">): { badge: string; description: string } {
  const labels: Record<FolderSourceStatus, { badge: string; description: string }> = {
    connected: { badge: "已连接", description: "已连接" },
    offline: { badge: "离线", description: "连接已离线" },
    missing: { badge: "路径失效", description: "找不到原路径，可能已移动或删除" },
    permission_required: { badge: "需授权", description: "需要重新授权" },
    error: { badge: "异常", description: "连接异常" },
  };
  return labels[source.status] ?? labels.offline;
}

function formatCount(count: number | null, capped = false): string {
  if (count == null) return "";
  return `${count}${capped ? "+" : ""} 项`;
}

function formatFolderFileCount(source: Pick<FolderSource, "fileCount" | "fileCountCapped">): string | null {
  if (source.fileCount == null) return null;
  return `${source.fileCount}${source.fileCountCapped ? "+" : ""} 个文件`;
}

function normalizeFolderEntryError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (message === FOLDER_ENTRY_TIMEOUT_MESSAGE) return FOLDER_ENTRY_TIMEOUT_MESSAGE;
  const lower = message.toLowerCase();
  if (message.includes("未连接") || lower.includes("bridge")) return FOLDER_BRIDGE_UNAVAILABLE_MESSAGE;
  return message;
}

function dirEntryInfo(relPath: string, entry: FolderEntry): string {
  return [relPath, formatCount(entry.childCount)].filter(Boolean).join(" · ");
}

function fileEntryInfo(relPath: string, entry: FolderEntry): string {
  const byteLabel = entry.byteLen != null ? `${entry.byteLen} 字节` : "";
  return [relPath, byteLabel].filter(Boolean).join(" · ");
}

function ChevronIcon({ open }: { open: boolean }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {open ? <path d="M6 9l6 6 6-6" /> : <path d="M9 6l6 6-6 6" />}
    </svg>
  );
}

function FolderIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
    </svg>
  );
}

function RefIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="4" />
      <path d="M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-3.9 7.9" />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 6h18M8 6V4h8v2m-1 0v14a1 1 0 0 1-1 1H10a1 1 0 0 1-1-1V6M10 11v6M14 11v6" />
    </svg>
  );
}
