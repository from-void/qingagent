import { Button } from "@qingagent/ui-kit";
import { useEffect, useState } from "react";

interface SourceCheckModalProps {
  open: boolean;
  loadInstruction: () => Promise<string>;
  saveInstruction: (instruction: string) => Promise<void>;
  onClose: () => void;
  onConfirm: (instruction: string, supplement: string) => void;
}

export const DEFAULT_SOURCE_CHECK_INSTRUCTION =
  "重点核对：时间与日期先后、金额/数字/单位与统计口径、人名职务与机构名、引述内容与素材原文是否一致；素材中查不到依据的断言标记为无据。";

export function buildSourceCheckQuery(instruction: string, supplement: string): string {
  const instructionText = instruction.trim()
    ? `\n来源审查指令（用户长期偏好，必须遵守）：${instruction.trim()}`
    : "";
  const supplementText = supplement.trim() ? `\n本次补充要求：${supplement.trim()}` : "";
  return `对当前文档做来源核查：仅以当前会话素材为依据，核对事实断言、数字、单位和统计口径；将口径漂移、无据或数字失真问题创建为批注组。${instructionText}${supplementText}`;
}

export function SourceCheckModal({ open, loadInstruction, saveInstruction, onClose, onConfirm }: SourceCheckModalProps) {
  const [instruction, setInstruction] = useState("");
  const [supplement, setSupplement] = useState("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let active = true;
    setLoading(true);
    setError(null);
    setSupplement("");
    void loadInstruction().then((value) => {
      if (active) setInstruction(value.trim() ? value : DEFAULT_SOURCE_CHECK_INSTRUCTION);
    }).catch(() => {
      if (active) setError("审查指令加载失败，请重试");
    }).finally(() => {
      if (active) setLoading(false);
    });
    return () => { active = false; };
  }, [loadInstruction, open]);

  if (!open) return null;
  return (
    <div className="ws-folder-modal-overlay" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="ws-folder-intro-modal ws-lexicon-modal" role="dialog" aria-modal="true" aria-labelledby="ws-source-check-title" data-wf="SourceCheckModal">
        <header className="ws-lexicon-head">
          <span className="ws-lexicon-head-spacer" />
          <h2 id="ws-source-check-title">来源核查</h2>
          <span className="ws-lexicon-head-count" />
          <button type="button" className="ws-lexicon-close" aria-label="关闭" onClick={onClose}>×</button>
        </header>
        <div className="ws-lexicon-picker">
          <p className="ws-lexicon-picker-hint">仅对照当前会话素材，优先核查事实、数字、单位和统计口径；默认不联网。</p>
          {error ? <p className="ws-lexicon-error" role="alert">{error}</p> : null}
          <label className="ws-lexicon-instruction">
            <span>审查指令</span>
            <textarea disabled={loading} value={instruction} onChange={(event) => setInstruction(event.currentTarget.value)} placeholder="例如：品牌自述中的约数可保留，金额必须逐字核对" />
            <small>常驻偏好，开始核查时自动保存。</small>
          </label>
          <label className="ws-lexicon-instruction ws-deai-supplement">
            <span>补充要求 <small>（选填）</small></span>
            <textarea value={supplement} onChange={(event) => setSupplement(event.currentTarget.value)} placeholder="例如：这次重点核对经营数据和日期" />
          </label>
          <div className="ws-lexicon-actions">
            <Button type="button" variant="ghost" onClick={onClose}>取消</Button>
            <Button type="button" variant="primary" disabled={loading || saving} onClick={() => {
              setSaving(true);
              setError(null);
              void saveInstruction(instruction).then(() => onConfirm(instruction, supplement)).catch(() => setError("审查指令保存失败，请重试")).finally(() => setSaving(false));
            }}>{saving ? "正在保存…" : "开始核查"}</Button>
          </div>
        </div>
      </section>
    </div>
  );
}
