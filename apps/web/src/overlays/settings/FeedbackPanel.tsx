import { useCallback, useEffect, useState } from "react";
import { useToast } from "../../system/ToastProvider";
import { useDelayedVisible } from "../../system/useDelayedVisible";
import { attachCapabilityEnabled } from "../../system/backendConnectionStore";

// 「提需求」跳转的反馈站(独立网页,后续单独承载);「报bug」排查不了时的联系邮箱。
const FEEDBACK_URL = "https://qingagent.com/feedback";
const SUPPORT_EMAIL = "support@qingagent.com";
// 列出最近多少篇文档供勾选;默认预勾选最近几篇。
const MAX_DOCS = 20;
const DEFAULT_CHECKED = 5;
// 完整落盘路径需要留足阅读时间，不能沿用普通动作提示 2.4s 的默认时长。
const EXPORTED_PATH_TOAST_DURATION_MS = 8_000;

interface SessionRow {
  id: string;
  title: string;
  updatedAt: string | null;
}

export function FeedbackPanel() {
  const diagnosticsExportEnabled = attachCapabilityEnabled("diagnosticsExport");
  const [docs, setDocs] = useState<SessionRow[]>([]);
  const [checked, setChecked] = useState<Set<string>>(() => new Set());
  const [includeContent, setIncludeContent] = useState(false);
  const [loading, setLoading] = useState(true);
  // 首拉通常几毫秒就回来,「读取文档列表中」一挂载就渲染 = 闪一帧;延迟 250ms 才显形。
  const showLoading = useDelayedVisible(loading);
  const [loadFailed, setLoadFailed] = useState(false);
  const [exporting, setExporting] = useState(false);
  const toast = useToast();

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        // 用未门控的 /home(首页同源),而非 /data/sessions——后者是 dataAdmin 路由,
        // 未设 QINGAGENT_ENABLE_DEBUG 时返回 404,导致报 bug 页永远「暂无文档」。
        const res = await fetch("/api/v1/home", { signal: controller.signal });
        if (!res.ok) throw new Error(`home failed: ${res.status}`);
        const body = (await res.json()) as {
          recent_sessions?: { id: string; title: string; updated_at?: string | null }[];
        };
        if (controller.signal.aborted) return;
        const recent: SessionRow[] = (body.recent_sessions ?? [])
          .slice(0, MAX_DOCS)
          .map((s) => ({ id: s.id, title: s.title, updatedAt: s.updated_at ?? null }));
        setLoadFailed(false);
        setDocs(recent);
        // 默认预勾选最近 DEFAULT_CHECKED 篇(用户可自行增减)。
        setChecked(new Set(recent.slice(0, DEFAULT_CHECKED).map((s) => s.id)));
      } catch {
        if (!controller.signal.aborted) {
          setDocs([]);
          setChecked(new Set());
          setIncludeContent(false);
          setLoadFailed(true);
        }
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
    // 列表失败时服务端以空 sessionIds 回退最近会话；此时没有明确文档授权，只允许 L1。
    const privacyLevel = loadFailed ? "L1" : includeContent ? "L2" : "L1";
    const sessionIds = loadFailed ? [] : Array.from(checked);
    try {
      if (window.electron?.isDesktop && typeof window.electron.exportDiagnostics === "function") {
        const result = await window.electron.exportDiagnostics({ privacyLevel, sessionIds });
        if (!result.saved) throw new Error(`diagnostics export failed: ${result.reason}`);
        toast.show({
          message: `报错记录已导出至：${result.path}`,
          tone: "success",
          durationMs: EXPORTED_PATH_TOAST_DURATION_MS,
        });
      } else {
        const res = await fetch("/api/v1/diagnostics/export", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ privacyLevel, sessionIds }),
        });
        if (!res.ok) throw new Error(`export failed: ${res.status}`);
        const blob = await res.blob();
        downloadBlob(blob, filenameFromContentDisposition(res.headers.get("content-disposition")));
        toast.show({ message: "报错记录已开始下载", tone: "success" });
      }
    } catch {
      toast.show({ message: "导出失败，未生成文件，请稍后重试", tone: "error" });
    } finally {
      setExporting(false);
    }
  }, [includeContent, checked, loadFailed, toast]);

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
            showLoading ? <div className="sm-empty">读取文档列表中</div> : null
          ) : loadFailed ? (
            <div className="sm-empty">文档列表暂时无法加载，仍可导出系统日志和最近会话诊断</div>
          ) : docs.length === 0 ? (
            <div className="sm-empty">暂无文档</div>
          ) : (
            docs.map((d) => (
              <label key={d.id} className="fb-doc">
                <input
                  className="wf-checkbox"
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
            className="wf-checkbox"
            type="checkbox"
            checked={includeContent}
            disabled={loadFailed}
            onChange={(event) => setIncludeContent(event.target.checked)}
          />
          <span className="fb-check-label">
            一并导出聊天记录与正文
            <em className="fb-check-hint">
              {loadFailed
                ? "文档列表加载失败时仅导出 L1 诊断，不含正文与对话。"
                : "勾选后能帮助更快定位问题；不勾选则只导出运行记录，不含正文与对话。"}
            </em>
          </span>
        </label>

        <div className="fb-actions">
          <button
            type="button"
            className="sm-btn primary"
            data-wf="FeedbackExportButton"
            disabled={!diagnosticsExportEnabled || exporting || (!loadFailed && checked.size === 0)}
            title={diagnosticsExportEnabled ? undefined : "当前青简引擎暂不支持导出诊断"}
            onClick={exportReport}
          >
            {exporting ? "导出中" : "导出报错记录"}
          </button>
        </div>
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
