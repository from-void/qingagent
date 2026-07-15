import { Button } from "@qingagent/ui-kit";
import type { StyleTemplateItem } from "@qingagent/contract-ts";
import { useEffect, useRef, useState } from "react";

interface DeaiReviewModalProps {
  open: boolean;
  loadTemplates: () => Promise<StyleTemplateItem[]>;
  loadTemplate: (id: string) => Promise<StyleTemplateItem>;
  saveTemplate: (input: { name: string; detail: string; prompt: string }) => Promise<StyleTemplateItem>;
  onClose: () => void;
  onConfirm: (template: StyleTemplateItem, supplement: string) => void;
}

export function buildDeaiReviewQuery(template: Pick<StyleTemplateItem, "id" | "name">, supplement: string): string {
  const supplementText = supplement.trim() ? `。补充要求:${supplement.trim()}` : "";
  return `对当前文档做去AI味处理,使用模板「${template.name}」(id: ${template.id})${supplementText}`;
}

export function DeaiReviewModal({ open, loadTemplates, loadTemplate, saveTemplate, onClose, onConfirm }: DeaiReviewModalProps) {
  const [templates, setTemplates] = useState<StyleTemplateItem[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [activeTemplate, setActiveTemplate] = useState<StyleTemplateItem | null>(null);
  const [editName, setEditName] = useState("");
  const [editPrompt, setEditPrompt] = useState("");
  const [supplement, setSupplement] = useState("");
  const [loading, setLoading] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestRef = useRef(0);

  useEffect(() => {
    if (!open) return;
    let active = true;
    setLoading(true);
    setError(null);
    setActiveTemplate(null);
    setSupplement("");
    void loadTemplates().then((items) => {
      if (!active) return;
      setTemplates(items);
      setSelectedId(items[0]?.id ?? "");
    }).catch(() => {
      if (active) setError("模板加载失败，请重试");
    }).finally(() => {
      if (active) setLoading(false);
    });
    return () => { active = false; };
  }, [loadTemplates, open]);

  const showTemplate = (template: StyleTemplateItem) => {
    const requestId = ++requestRef.current;
    setDetailLoading(true);
    setError(null);
    void loadTemplate(template.id).then((loaded) => {
      if (requestRef.current !== requestId) return;
      setActiveTemplate(loaded);
      setEditName(`${loaded.name}（自定义）`);
      setEditPrompt(loaded.prompt);
    }).catch(() => {
      if (requestRef.current === requestId) setError("模板详情加载失败，请重试");
    }).finally(() => {
      if (requestRef.current === requestId) setDetailLoading(false);
    });
  };

  if (!open) return null;
  const selected = templates.find((item) => item.id === selectedId) ?? null;

  return (
    <div className="ws-folder-modal-overlay" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="ws-folder-intro-modal ws-lexicon-modal ws-deai-modal" role="dialog" aria-modal="true" aria-labelledby="ws-deai-title" data-wf="DeaiReviewModal">
        <header className="ws-lexicon-head">
          {activeTemplate ? <button type="button" className="ws-lexicon-back" onClick={() => { requestRef.current += 1; setActiveTemplate(null); }}>‹ 返回</button> : <span className="ws-lexicon-head-spacer" />}
          <h2 id="ws-deai-title">{activeTemplate ? activeTemplate.name : "去AI味"}</h2>
          <span className="ws-lexicon-head-count">{activeTemplate ? "模板详情" : ""}</span>
          <button type="button" className="ws-lexicon-close" aria-label="关闭" onClick={onClose}>×</button>
        </header>
        <div className="ws-lexicon-picker">
          {!activeTemplate ? <>
            <p className="ws-lexicon-picker-hint">选择处理强度；可进入详情查看规则、编辑后另存为个人模板。</p>
            <div className="ws-lexicon-list ws-deai-template-list" role="radiogroup" aria-label="去AI味模板">
              {loading ? <p className="ws-lexicon-empty">正在读取模板…</p> : null}
              {!loading && error ? <p className="ws-lexicon-error" role="alert">{error}</p> : null}
              {!loading && !error && templates.length === 0 ? <p className="ws-lexicon-empty">暂无可用模板</p> : null}
              {templates.map((template) => (
                <div className={`ws-lexicon-option ws-deai-template${selectedId === template.id ? " is-selected" : ""}`} key={template.id}>
                  <label className="ws-lexicon-check" aria-label={`选择${template.name}`}>
                    <input type="radio" name="deai-template" checked={selectedId === template.id} onChange={() => setSelectedId(template.id)} />
                  </label>
                  <button type="button" className="ws-lexicon-open" onClick={() => showTemplate(template)}>
                    <span className="ws-lexicon-copy"><strong>{template.name}</strong><small>{template.detail}</small></span>
                    <span className="ws-lexicon-chevron" aria-hidden="true">›</span>
                  </button>
                </div>
              ))}
            </div>
            <label className="ws-lexicon-instruction ws-deai-supplement">
              <span>补充要求 <small>（选填）</small></span>
              <textarea value={supplement} onChange={(event) => setSupplement(event.currentTarget.value)} placeholder="例如：保留品牌口号；引用原话不要改" />
            </label>
            <div className="ws-lexicon-actions">
              <Button type="button" variant="ghost" onClick={onClose}>取消</Button>
              <Button type="button" variant="primary" disabled={loading || !selected} onClick={() => { if (selected) onConfirm(selected, supplement); }}>开始处理</Button>
            </div>
          </> : (
            <div className="ws-deai-detail" aria-busy={detailLoading}>
              {error ? <p className="ws-lexicon-error" role="alert">{error}</p> : null}
              <p className="ws-deai-source">{activeTemplate.detail}</p>
              <label className="ws-lexicon-instruction">
                <span>另存名称</span>
                <input value={editName} onChange={(event) => setEditName(event.currentTarget.value)} />
              </label>
              <label className="ws-lexicon-instruction">
                <span>模板规则</span>
                <textarea value={editPrompt} onChange={(event) => setEditPrompt(event.currentTarget.value)} />
                <small>编辑不会覆盖预制模板；点击“另存模板”会创建个人副本。</small>
              </label>
              <div className="ws-lexicon-actions">
                <Button type="button" variant="ghost" onClick={() => setActiveTemplate(null)}>返回选择</Button>
                <Button type="button" variant="primary" disabled={saving || !editName.trim() || !editPrompt.trim()} onClick={() => {
                  setSaving(true);
                  setError(null);
                  void saveTemplate({ name: editName.trim(), detail: activeTemplate.detail, prompt: editPrompt.trim() }).then((saved) => {
                    setTemplates((items) => [...items, saved]);
                    setSelectedId(saved.id);
                    setActiveTemplate(null);
                  }).catch(() => setError("模板另存失败，请重试")).finally(() => setSaving(false));
                }}>{saving ? "正在另存…" : "另存模板"}</Button>
              </div>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
