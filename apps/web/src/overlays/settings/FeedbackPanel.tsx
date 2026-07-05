import { useCallback, useEffect, useState } from "react";

// 「提需求」跳转的反馈站(独立网页,后续单独承载);「报bug」排查不了时的联系邮箱。
const FEEDBACK_URL = "https://feedback.qingagent.com";
const SUPPORT_EMAIL = "support@qingagent.com";
// 列出最近多少篇文档供勾选;默认预勾选最近几篇。
const MAX_DOCS = 20;
const DEFAULT_CHECKED = 5;

interface SessionRow {
  id: string;
  title: string;
  updatedAt: string | null;
}

export function FeedbackPanel() {
  const [docs, setDocs] = useState<SessionRow[]>([]);
  const [checked, setChecked] = useState<Set<string>>(() => new Set());
  const [includeContent, setIncludeContent] = useState(false);
  const [loading, setLoading] = useState(true);
  const [exporting, setExporting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const res = await fetch("/api/v1/data/sessions", { signal: controller.signal });
        if (!res.ok) throw new Error(`sessions failed: ${res.status}`);
        const body = (await res.json()) as { sessions: SessionRow[] };
        if (controller.signal.aborted) return;
        const recent = (body.sessions ?? []).slice(0, MAX_DOCS);
        setDocs(recent);
        // 默认预勾选最近 DEFAULT_CHECKED 篇(用户可自行增减)。
        setChecked(new Set(recent.slice(0, DEFAULT_CHECKED).map((s) => s.id)));
      } catch {
        if (!controller.signal.aborted) setDocs([]);
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    })();
    return () => controller.abort();
  }, []);

  const toggleDoc = useCallback((id: string) => {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const exportReport = useCallback(async () => {
    setExporting(true);
    setMessage(null);
    const privacyLevel = includeContent ? "L2" : "L1";
    const sessionIds = Array.from(checked);
    try {
      if (window.electron?.isDesktop && typeof window.electron.exportDiagnostics === "function") {
        const result = await window.electron.exportDiagnostics({ privacyLevel, sessionIds });
        setMessage(result.saved ? "报错记录已导出" : "已取消导出");
      } else {
        const res = await fetch("/api/v1/diagnostics/export", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ privacyLevel, sessionIds }),
        });
        if (!res.ok) throw new Error(`export failed: ${res.status}`);
        const blob = await res.blob();
        downloadBlob(blob, filenameFromContentDisposition(res.headers.get("content-disposition")));
        setMessage("报错记录已下载");
      }
    } catch {
      setMessage("导出失败，请稍后重试");
    } finally {
      setExporting(false);
    }
  }, [includeContent, checked]);

  return (
    <div className="settings-feedback" data-wf="FeedbackPanel">
      {/* 卡片一:提需求 —— 跳转独立反馈站 */}
      <section className="fb-card">
        <div className="sm-title">提需求</div>
        <p className="fb-desc">有想要的功能或改进建议？到反馈站告诉我们，帮助青简做得更好。</p>
        <div className="fb-actions">
          <a
            className="sm-btn primary"
            href={FEEDBACK_URL}
            target="_blank"
            rel="noopener noreferrer"
            data-wf="FeedbackRequestLink"
          >
            去提需求
          </a>
        </div>
      </section>

      {/* 卡片二:报 bug —— 勾选文档,导出报错记录 */}
      <section className="fb-card">
        <div className="sm-title">报 bug</div>
        <p className="fb-desc">遇到问题？勾选出问题的文档，导出一份运行记录发给我们排查。</p>

        <div className="fb-doclist" data-wf="FeedbackDocList">
          {loading ? (
            <div className="sm-empty">读取文档列表中</div>
          ) : docs.length === 0 ? (
            <div className="sm-empty">暂无文档</div>
          ) : (
            docs.map((d) => (
              <label key={d.id} className="fb-doc">
                <input
                  type="checkbox"
                  checked={checked.has(d.id)}
                  onChange={() => toggleDoc(d.id)}
                />
                <span className="fb-doc-title">{d.title}</span>
                <span className="fb-doc-date">{formatDate(d.updatedAt)}</span>
              </label>
            ))
          )}
        </div>

        <label className="fb-check" data-wf="FeedbackIncludeContent">
          <input
            type="checkbox"
            checked={includeContent}
            onChange={(event) => setIncludeContent(event.target.checked)}
          />
          <span className="fb-check-label">
            一并导出聊天记录与正文
            <em className="fb-check-hint">勾选后能帮助更快定位问题；不勾选则只导出运行记录，不含正文与对话。</em>
          </span>
        </label>

        <div className="fb-actions">
          <button
            type="button"
            className="sm-btn primary"
            data-wf="FeedbackExportButton"
            disabled={exporting || checked.size === 0}
            onClick={exportReport}
          >
            {exporting ? "导出中" : "导出报错记录"}
          </button>
        </div>
        {message ? <div className="sm-message">{message}</div> : null}
        <p className="fb-contact">
          排查不了或不方便导出？发邮件联系我们：
          <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>
        </p>
      </section>
    </div>
  );
}

function formatDate(iso: string | null): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}.${m}.${d}`;
}

function filenameFromContentDisposition(value: string | null): string {
  if (!value) return "qingagent-diag-v1.zip";
  const utf8 = /filename\*=UTF-8''([^;]+)/i.exec(value)?.[1];
  if (utf8) {
    try {
      return decodeURIComponent(utf8);
    } catch {
      return utf8;
    }
  }
  return /filename="([^"]+)"/i.exec(value)?.[1] ?? "qingagent-diag-v1.zip";
}

function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
