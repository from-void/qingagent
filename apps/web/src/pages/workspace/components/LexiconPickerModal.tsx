import { Button } from "@qingagent/ui-kit";
import type { LexiconEntrySummary, LexiconResourceSummary } from "@qingagent/contract-ts";
import { useEffect, useRef, useState } from "react";
import { CaretIcon } from "./icons";

interface LexiconPickerModalProps {
  open: boolean;
  loadLexicons: () => Promise<LexiconResourceSummary[]>;
  loadLexiconEntries: (resourceId: string) => Promise<LexiconEntrySummary[]>;
  loadInstruction: () => Promise<string>;
  saveInstruction: (instruction: string) => Promise<void>;
  onClose: () => void;
  onConfirm: (lexicons: LexiconResourceSummary[], instruction: string) => void;
}

export function LexiconPickerModal({ open, loadLexicons, loadLexiconEntries, loadInstruction, saveInstruction, onClose, onConfirm }: LexiconPickerModalProps) {
  const [lexicons, setLexicons] = useState<LexiconResourceSummary[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeLexicon, setActiveLexicon] = useState<LexiconResourceSummary | null>(null);
  const [entries, setEntries] = useState<LexiconEntrySummary[]>([]);
  const [entriesLoading, setEntriesLoading] = useState(false);
  const [entriesError, setEntriesError] = useState<string | null>(null);
  const [instruction, setInstruction] = useState("");
  const [saving, setSaving] = useState(false);
  const entriesRequestRef = useRef(0);

  useEffect(() => {
    if (!open) return;
    let active = true;
    setLoading(true);
    setError(null);
    entriesRequestRef.current += 1;
    setActiveLexicon(null);
    setEntries([]);
    void Promise.all([loadLexicons(), loadInstruction()]).then(([items, savedInstruction]) => {
      if (!active) return;
      setLexicons(items);
      setSelected(new Set(items.filter((item) => item.enabled !== false).map((item) => item.id)));
      setInstruction(savedInstruction);
    }).catch(() => {
      if (active) setError("词库加载失败，请重试");
    }).finally(() => {
      if (active) setLoading(false);
    });
    return () => { active = false; };
  }, [loadInstruction, loadLexicons, open]);

  const showEntries = (lexicon: LexiconResourceSummary) => {
    const requestId = ++entriesRequestRef.current;
    setActiveLexicon(lexicon);
    setEntries([]);
    setEntriesLoading(true);
    setEntriesError(null);
    void loadLexiconEntries(lexicon.id).then((items) => {
      if (entriesRequestRef.current !== requestId) return;
      setEntries(items);
    }).catch(() => {
      if (entriesRequestRef.current !== requestId) return;
      setEntriesError("词条加载失败，请重试");
    }).finally(() => {
      if (entriesRequestRef.current !== requestId) return;
      setEntriesLoading(false);
    });
  };

  if (!open) return null;

  return (
    <div
      className="ws-folder-modal-overlay"
      role="presentation"
      onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}
    >
      <section className="ws-folder-intro-modal ws-lexicon-modal" role="dialog" aria-modal="true" aria-labelledby="ws-lexicon-title" data-wf="LexiconPickerModal">
        <header className="ws-lexicon-head">
          {activeLexicon ? (
            <button type="button" className="ws-lexicon-back" onClick={() => { entriesRequestRef.current += 1; setActiveLexicon(null); }}><CaretIcon size={13} direction="left" />返回</button>
          ) : <span className="ws-lexicon-head-spacer" />}
          <h2 id="ws-lexicon-title">{activeLexicon ? activeLexicon.name : "选择敏感词词库"}</h2>
          <span className="ws-lexicon-head-count">{activeLexicon ? `${entriesLoading ? activeLexicon.entryCount : entries.length} 词` : ""}</span>
          <button type="button" className="ws-lexicon-close" aria-label="关闭" onClick={onClose}>×</button>
        </header>
        <div className="ws-lexicon-picker">
          {!activeLexicon ? <>
          <p className="ws-lexicon-picker-hint">可同时启用多个词库，审查会按长词优先扫描当前文档。</p>
          <div className="ws-lexicon-list">
            {loading ? <p className="ws-lexicon-empty">正在读取词库…</p> : null}
            {!loading && error ? <p className="ws-lexicon-error" role="alert">{error}</p> : null}
            {!loading && !error && lexicons.length === 0 ? <p className="ws-lexicon-empty">暂无可用词库</p> : null}
            {lexicons.map((lexicon) => (
              <div className="ws-lexicon-option" key={lexicon.id}>
                <label className="ws-lexicon-check" aria-label={`启用${lexicon.name}`}>
                <input
                  className="wf-checkbox"
                  type="checkbox"
                  checked={selected.has(lexicon.id)}
                  onChange={(event) => {
                    const checked = event.currentTarget.checked;
                    setSelected((current) => {
                      const next = new Set(current);
                      if (checked) next.add(lexicon.id); else next.delete(lexicon.id);
                      return next;
                    });
                  }}
                />
                </label>
                <button type="button" className="ws-lexicon-open" onClick={() => showEntries(lexicon)}>
                  <span className="ws-lexicon-copy"><strong>{lexicon.name}</strong>{lexicon.description ? <small>{lexicon.description}</small> : null}</span>
                  <small>{lexicon.entryCount} 词</small>
                  <span className="ws-lexicon-chevron" aria-hidden="true"><CaretIcon size={15} direction="right" /></span>
                </button>
              </div>
            ))}
          </div>
          <label className="ws-lexicon-instruction">
            <span>审查指令</span>
            <textarea
              value={instruction}
              onChange={(event) => setInstruction(event.currentTarget.value)}
              placeholder="例如：专有名词与引用原文里的命中先列出待我确认，不要直接替换"
            />
            <small>与词库搭配的常驻偏好，开始审查时自动保存。</small>
          </label>
          <div className="ws-lexicon-actions">
            <Button type="button" variant="ghost" onClick={onClose}>取消</Button>
            <Button
              type="button"
              variant="primary"
              disabled={loading || saving || selected.size === 0}
              onClick={() => {
                setSaving(true);
                void saveInstruction(instruction).then(() => {
                  onConfirm(lexicons.filter((item) => selected.has(item.id)), instruction);
                }).catch(() => setError("审查指令保存失败，请重试")).finally(() => setSaving(false));
              }}
            >{saving ? "正在保存…" : "开始审查"}</Button>
          </div>
          </> : (
            <div className="ws-lexicon-entry-list" aria-busy={entriesLoading}>
              {entriesLoading ? <p className="ws-lexicon-empty">正在读取词条…</p> : null}
              {!entriesLoading && entriesError ? <p className="ws-lexicon-error" role="alert">{entriesError}</p> : null}
              {!entriesLoading && !entriesError && entries.length === 0 ? <p className="ws-lexicon-empty">暂无词条</p> : null}
              {entries.map((entry, index) => (
                <div className="ws-lexicon-entry" key={`${entry.word}-${index}`} title={entry.note || undefined}>
                  <span className="ws-lexicon-word">{entry.word}</span>
                  {entry.replacement ? <span className="ws-lexicon-replacement">→ {entry.replacement}</span> : <span className="ws-lexicon-mark-only">仅标记</span>}
                </div>
              ))}
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
