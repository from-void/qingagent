import { useEffect, useRef, useState } from "react";
import type { DerivativeItem } from "./types";
import { DTYPE_REGISTRY, type DerivativeDtype } from "./dtypeRegistry";

export function DerivTabBar(props: {
  title: string; items: DerivativeItem[]; activeTab: "main" | string;
  onActivate: (id: "main" | string) => void; onCreate: (dtype: DerivativeDtype) => void;
  onRename: (title: string) => void | Promise<void>;
  isStaleDismissed?: (item: DerivativeItem) => boolean;
  /** 非空时禁用「+」新建稿件(如青简编辑中),hover 展示原因。 */
  createDisabledReason?: string | null;
}) {
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draftTitle, setDraftTitle] = useState("");
  const menuRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => { if (!menuRef.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);
  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);
  const beginRename = () => {
    setDraftTitle(props.title || "主文档");
    setEditing(true);
  };
  const availableDescriptors = Object.values(DTYPE_REGISTRY).filter(
    (descriptor) => !props.items.some((item) => item.dtype === descriptor.dtype),
  );
  const regularItems = props.items.filter((item) => item.dtype !== "translate");
  const translationItems = props.items.filter((item) => item.dtype === "translate");
  const hasVisibleStale = (item: DerivativeItem) => item.stale && !props.isStaleDismissed?.(item);
  const submitRename = () => {
    const title = draftTitle.trim();
    setEditing(false);
    if (title && title !== props.title) void props.onRename(title);
  };
  // 顺序:主文档标题 → 衍生 Tab 向右铺开 → 最右「＋」线框(新 Tab 开在标题右侧、＋左侧)。
  return <div className="ws-deriv-tabs" role="tablist">
    <div className={`ws-deriv-tab is-main${props.activeTab === "main" ? " is-active" : ""}`} role="tab" tabIndex={0} onClick={() => props.onActivate("main")} onKeyDown={(event) => {
      if (!editing && (event.key === "Enter" || event.key === " ")) { event.preventDefault(); props.onActivate("main"); }
    }}>
      {editing ? <input ref={inputRef} className="ws-deriv-title-input" value={draftTitle} maxLength={48} aria-label="修改主文档标题" onClick={(event) => event.stopPropagation()} onChange={(event) => setDraftTitle(event.target.value)} onBlur={submitRename} onKeyDown={(event) => {
        if (event.key === "Enter") { event.preventDefault(); submitRename(); }
        if (event.key === "Escape") { event.preventDefault(); setEditing(false); }
      }} /> : <><span>{props.title || "主文档"}</span><button type="button" className="ws-deriv-rename" aria-label="修改标题" title="修改标题" onClick={(event) => { event.stopPropagation(); beginRename(); }}><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M11.1 2.9a1.75 1.75 0 0 1 2.47 2.47L6 12.9l-3.2.77.77-3.2Z"/><path d="m9.7 4.3 2.47 2.47"/></svg></button></>}
    </div>
    {regularItems.map((item) => <button key={item.docId} className={`ws-deriv-tab${props.activeTab === item.docId ? " is-active" : ""}`} role="tab" onClick={() => props.onActivate(item.docId)}>
      <span>{DTYPE_REGISTRY[item.dtype as DerivativeDtype]?.tabLabel ?? item.templateName}</span>{hasVisibleStale(item) ? <i className="ws-deriv-stale-dot" title="源文档已更新" /> : null}
    </button>)}
    {translationItems.length ? <button className={`ws-deriv-tab${props.activeTab === "translate" ? " is-active" : ""}`} role="tab" onClick={() => props.onActivate("translate")}>
      <span>翻译</span>{translationItems.some(hasVisibleStale) ? <i className="ws-deriv-stale-dot" title="源文档已更新" /> : null}
    </button> : null}
    {availableDescriptors.length > 0 ? <div className="ws-deriv-add-wrap" ref={menuRef}>
      <button className={`ws-deriv-add${props.createDisabledReason ? " is-disabled" : ""}`} title={props.createDisabledReason ?? "新建稿件"} aria-label="新建稿件" aria-disabled={props.createDisabledReason ? true : undefined} onClick={() => { if (!props.createDisabledReason) setOpen((value) => !value); }}><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 3v10M3 8h10" /></svg></button>
      {open && !props.createDisabledReason ? <div className="ws-export-menu ws-deriv-menu" role="menu">
        {availableDescriptors.map((descriptor) => <button key={descriptor.dtype} type="button" role="menuitem" className="ws-export-item" onClick={() => { setOpen(false); props.onCreate(descriptor.dtype); }}>{descriptor.label}</button>)}
      </div> : null}
    </div> : null}
  </div>;
}
