import { useEffect, useRef, useState, type RefObject } from "react";
import type { PmDoc, PmNode } from "@qingagent/pm-schema";
import { chatInputBus } from "../../../system/chatInputBus";
import { useSkills } from "../../../overlays/settings/useSkills";
import { useSessionStore } from "../../../stores/sessionStore";
import type { ToastShow } from "../../../system/ToastProvider";

// 导出二级菜单:确定性格式(PDF/Word/TXT)直接走后端导出下载;
// 平台技能(飞书,启用了才显示)点了发 query 回对话,交给 agent 走流程。

interface Fmt {
  id: "pdf" | "docx" | "html" | "markdown" | "txt";
  label: string;
  ext: string;
  savedToast: string;
  startedToast: string;
}

const FORMATS: Fmt[] = [
  {
    id: "pdf",
    label: "导出 PDF",
    ext: "pdf",
    savedToast: "PDF 已保存",
    startedToast: "PDF 已开始下载",
  },
  {
    id: "docx",
    label: "导出 Word",
    ext: "docx",
    savedToast: "Word 已保存",
    startedToast: "Word 已开始下载",
  },
  {
    id: "html",
    label: "导出 HTML",
    ext: "html",
    savedToast: "HTML 已保存",
    startedToast: "HTML 已开始下载",
  },
  {
    id: "markdown",
    label: "导出 Markdown",
    ext: "md",
    savedToast: "Markdown 已保存",
    startedToast: "Markdown 已开始下载",
  },
  {
    id: "txt",
    label: "导出 TXT",
    ext: "txt",
    savedToast: "TXT 已保存",
    startedToast: "TXT 已开始下载",
  },
];
const SPECIALIZED_DIAGRAM_OVERLAY_NOTICE = "specialized-diagram-overlay";

// 平台技能 → 导出项;skill 名对应 useSkills 返回的 name,启用了才出现。
const PLATFORM_TARGETS: Array<{ skill: string; label: string; query: string }> = [
  {
    skill: "feishu",
    label: "导出到飞书",
    query: "请把当前文档导出/同步到飞书云文档;如果需要我指定目标空间,或格式不兼容,先问我确认。",
  },
];

export interface ExportMenuProps {
  anchorRef?: RefObject<HTMLElement>;
  onClose: () => void;
  onAction: ToastShow;
  prepareDrawioForExport?: (
    onProgress: (current: number, total: number) => void,
  ) => Promise<void>;
  flushPendingDocSave?: () => Promise<void>;
  getLatestPmDoc?: () => PmDoc | null;
}

export function ExportMenu({
  anchorRef,
  onClose,
  onAction,
  prepareDrawioForExport,
  flushPendingDocSave,
  getLatestPmDoc,
}: ExportMenuProps) {
  const sessionId = useSessionStore((s) => s.currentSessionId);
  const sessionTitle = useSessionStore((s) => s.currentSessionTitle);
  const { skills } = useSkills();
  const [busy, setBusy] = useState<Fmt["id"] | null>(null);
  const [busyText, setBusyText] = useState("生成中…");
  const ref = useRef<HTMLDivElement>(null);

  // 点菜单外 / Esc 关闭
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (ref.current?.contains(target) || anchorRef?.current?.contains(target)) {
        return;
      }
      onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [anchorRef, onClose]);

  const download = async (f: Fmt) => {
    if (!sessionId) {
      onAction("会话未就绪");
      return;
    }
    setBusy(f.id);
    setBusyText("生成中…");
    try {
      if (f.id === "pdf" || f.id === "docx" || f.id === "html") {
        try {
          await prepareDrawioForExport?.((current, total) => {
            setBusyText(`正在渲染图表 ${current}/${total}`);
          });
        } catch (error) {
          // 补缓存本身异常也不能阻断导出；服务端仍会对未补成的块回退源码。
          console.warn("[export-menu] drawio cache preparation failed", error);
        }
        setBusyText("生成中…");
      }
      await flushPendingDocSave?.();
      // 分栏只在 markdown 拍平:把"有损"提示并进导出成功 toast(而非单独先弹一条——
      // 那条会被随后的 doneToast 立即覆盖、用户根本看不到,e2e V1/V2 三次确认)。
      const lossyColumns =
        f.id === "markdown" && docHasNodeType(getLatestPmDoc?.() ?? null, "columnList");
      const res = await fetch(`/api/v1/export/${encodeURIComponent(sessionId)}?format=${f.id}`);
      if (!res.ok) {
        // 文档为空时后端回 409;给个明确文案,别再笼统报"导出失败"。
        if (res.status === 409) {
          onAction("还没有可导出的内容");
          return;
        }
        throw new Error(`Export failed: ${res.status}`);
      }
      const specializedDiagramOverlayFallback =
        res.headers.get("X-Qingagent-Export-Notice") === SPECIALIZED_DIAGRAM_OVERLAY_NOTICE;
      const filename = `${safeFilename(sessionTitle || "qingagent-export")}_${dateStamp()}.${f.ext}`;
      if (window.electron?.isDesktop) {
        if (!window.electron.saveExportDownload) {
          throw new Error("Desktop export download bridge unavailable");
        }
        setBusyText("正在保存…");
        const result = await window.electron.saveExportDownload({
          filename,
          format: f.id,
          // Electron IPC 可稳定克隆 TypedArray；DOM Blob 不能由主进程解码。
          bytes: new Uint8Array(await res.arrayBuffer()),
        });
        if (!result.saved) {
          // 保存失败时先收起导出菜单，避免菜单层遮住全局 qa-toast。
          onClose();
          onAction(
            result.reason === "cancelled"
              ? "导出已取消"
              : "导出未保存 · 请重试",
          );
          return;
        }
        const message = exportResultMessage(
          f.savedToast,
          lossyColumns,
          specializedDiagramOverlayFallback,
        );
        onAction({
          message,
          durationMs: lossyColumns || specializedDiagramOverlayFallback ? 7000 : 5000,
          action: window.electron.revealExportDownload
            ? {
                label: "打开所在文件夹",
                onClick: () => revealSavedExport(result.revealToken, onAction),
              }
            : undefined,
        });
      } else {
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        try {
          const a = document.createElement("a");
          a.href = url;
          a.download = filename;
          document.body.appendChild(a);
          a.click();
          a.remove();
          onAction(
            exportResultMessage(
              f.startedToast,
              lossyColumns,
              specializedDiagramOverlayFallback,
            ),
            lossyColumns || specializedDiagramOverlayFallback ? 7000 : 3200,
          );
        } finally {
          URL.revokeObjectURL(url);
        }
      }
      onClose();
    } catch (err) {
      console.error("[export-menu] download failed", err);
      // 异常与显式失败保持一致：先收起菜单，确保全局 qa-toast 可见。
      onClose();
      onAction("导出失败 · 请重试");
    } finally {
      setBusy(null);
    }
  };

  const toPlatform = (label: string, query: string) => {
    onClose();
    onAction(`已发起 · ${label}`);
    // 发回对话、由 agent 走平台流程(飞书 skill 等),文档已在 agent 上下文里。
    chatInputBus.send(query);
  };

  const platforms = PLATFORM_TARGETS.filter((p) => skills.some((s) => s.name === p.skill && s.enabled));

  return (
    <div ref={ref} className="ws-export-menu" role="menu" data-wf="ExportMenu">
      {FORMATS.map((f) => (
        <button
          key={f.id}
          type="button"
          role="menuitem"
          className="ws-export-item"
          disabled={busy !== null}
          onClick={() => void download(f)}
          data-wf={`ExportFormat-${f.id}`}
        >
          {busy === f.id ? <><span className="ws-export-spinner" aria-hidden="true" />{busyText}</> : f.label}
        </button>
      ))}
      {platforms.length > 0 && <div className="ws-export-sep" aria-hidden="true" />}
      {platforms.map((p) => (
        <button
          key={p.skill}
          type="button"
          role="menuitem"
          className="ws-export-item ws-export-item--platform"
          onClick={() => toPlatform(p.label, p.query)}
          data-wf={`ExportPlatform-${p.skill}`}
        >
          {p.label}
        </button>
      ))}
    </div>
  );
}

function exportResultMessage(
  base: string,
  lossyColumns: boolean,
  specializedDiagramOverlayFallback: boolean,
): string {
  if (lossyColumns) {
    return `${base} · 分栏已拍平为纵向；需保留并排版式请导出 HTML 或 PDF。`;
  }
  if (specializedDiagramOverlayFallback) {
    return `${base} · 专有图表已保留完整语义，画布布局未应用。`;
  }
  return base;
}

function revealSavedExport(revealToken: string, onAction: ToastShow): void {
  const reveal = window.electron?.revealExportDownload;
  if (!reveal) {
    onAction("无法定位导出文件");
    return;
  }
  void reveal(revealToken)
    .then((revealed) => {
      if (!revealed) onAction("文件已被移动或删除");
    })
    .catch(() => {
      onAction("无法定位导出文件");
    });
}

export function docHasNodeType(doc: PmDoc | null, type: PmNode["type"]): boolean {
  if (!doc) return false;
  return doc.content.some((node) => nodeHasType(node, type));
}

function nodeHasType(node: PmNode, type: PmNode["type"]): boolean {
  if (node.type === type) return true;
  const content = (node as { content?: readonly PmNode[] }).content;
  return Array.isArray(content) && content.some((child) => nodeHasType(child, type));
}

function dateStamp(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}${m}${d}`;
}

function safeFilename(value: string): string {
  return (
    value
      .trim()
      .replace(/[\\/:*?"<>|]/g, "_")
      .replace(/\s+/g, "_")
      .slice(0, 80) || "qingagent-export"
  );
}
