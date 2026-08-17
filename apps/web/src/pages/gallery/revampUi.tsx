import type { ReactNode } from "react";
import type {
  AskUserAnswer,
  AskUserQuestion,
  MessagePart,
  QrCardBody,
  ToolCallSpec,
  WriteDraftCardBody,
} from "@qingagent/contract-ts";
import { ChatMessageList, renderSimpleMarkdown } from "../workspace/components/ChatMessageList";
import { DraftMiniCard } from "../workspace/components/DraftMiniCard";
import { QrCard } from "../workspace/components/QrCard";
import { BrowserViewPart } from "../workspace/components/BrowserViewPart";
import { ExternalLinkIcon } from "../../system/icons";
// 范围内的工具卡(检索/配图/识图/命令/通用工具条)直接复用生产统一组件,
// 不再在画廊里重复实现一套——彻底消除 demo 与生产漂移(单一真源)。
import {
  TOOL_LABELS,
  UCommand,
  UReadImage,
  UResearch,
  USvg,
  UnifiedToolCall,
  UProcessFold,
  UToolBar,
} from "../workspace/components/chatUnified";
import "../workspace/components/chatUnified.css";
import "./revampUi.css";

// 工具中文名沿用生产单一真源(含 run_js/run_python→「运行代码」等改名);
// 画廊历史上叫 IMPROVED_LABELS,保留此别名给 GalleryPage 引用。
export const IMPROVED_LABELS = TOOL_LABELS;
export { UCommand, UReadImage, UResearch, USvg, UToolBar };

// 用户未要求改的元素 → 保持老样式:直接渲染生产组件(单 part 经 ChatMessageList,
// 用 .u-flat 把外层 .ws-chat/.wf-msg.agent 折叠掉,使其内联融入改造流)。
function OldPart({ part }: { part: MessagePart }) {
  const msg = { id: "x", role: { kind: "agent" } as const, ts: "", parts: [part], chips: null };
  return <div className="u-flat"><ChatMessageList messages={[msg]} streamActive={false} debugMode /></div>;
}

const host = (u: string) => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return u; } };
const Dots = () => <span className="u-dots"><span /><span /><span /></span>;

// ═══════════ 画廊专属卡(生产里走别的组件,仅 demo 用) ═══════════
export function UDraft({ body }: { body: WriteDraftCardBody }) {
  return <DraftMiniCard body={body} />;
}

export function UQr({ data }: { data: QrCardBody }) {
  return <QrCard data={data} />;
}

export function UAskUser({ questions, answers }: { questions: AskUserQuestion[]; answers: Record<string, AskUserAnswer | undefined> }) {
  const answerData = Object.fromEntries(
    Object.entries(answers).filter((entry): entry is [string, AskUserAnswer] => entry[1] != null),
  );
  const spec: ToolCallSpec = {
    id: "demo-ask",
    name: "askUser",
    render: { kind: "rightForm" },
    status: { kind: "done" },
    body: {
      kind: "askUser",
      data: { id: "demo-ask", mode: { kind: "fullpage" }, purpose: null, source: null, rationale: null, questions },
    },
    result: { kind: "askUserAnswers", data: answerData },
  };
  return <OldPart part={{ kind: "toolCall", data: spec }} />;
}

export function USource({ label, srcUrl, thumb }: { label: string; srcUrl: string | null; thumb: string | null }) {
  return (
    <a className="u-source" href={srcUrl ?? undefined} target="_blank" rel="noreferrer noopener">
      {thumb && <img className="u-source-thumb" src={thumb} alt={label} />}
      <div className="u-source-main">
        <div className="u-source-title"><span className="u-source-tag">链接</span>{label}</div>
        {srcUrl && <div className="u-source-host">{host(srcUrl)} <ExternalLinkIcon size={11} /></div>}
      </div>
    </a>
  );
}

export function UPatch({ count, label }: { count?: number; label?: string }) {
  return <div className="u-bar"><span className="u-lbl">{label ?? `已修改 ${count} 处`}</span></div>;
}

export function UCitation({ id, anchor }: { id: string; anchor: string }) {
  return <span className="u-cite">¶ {id}#{anchor}</span>;
}

// 兼容旧 gallery API,内部复用生产 UProcessFold。
export function UTurnFold({ parts, defaultOpen = false }: { parts: MessagePart[]; defaultOpen?: boolean }) {
  const steps = parts.filter((p) => p.kind === "toolCall").length;
  return (
    <UProcessFold steps={steps} defaultOpen={defaultOpen}>
      {parts.map((p, i) => <URevampPart key={i} part={p} />)}
    </UProcessFold>
  );
}

// ═══════════ 改造对话流:把 MessagePart 映射到统一组件 ═══════════
export function URevampPart({ part }: { part: MessagePart }) {
  switch (part.kind) {
    case "text": {
      const b = part.data.body.trim();
      return b ? <div style={{ marginBottom: 2 }}>{renderSimpleMarkdown(b)}</div> : null;
    }
    case "code":
      return <pre className="u-detail">{part.data.body}</pre>;
    case "citation":
      return <OldPart part={part} />; // 引用:未要求改 → 老样式
    case "patchSummary":
      return <UPatch count={part.data.count} />;
    case "image":
      return <BrowserViewPart data={part.data} />; // 链接/来源:结果产出,未要求改 → 老样式
    case "thinking":
      return (
        <div className="u-bar">
          <span className="u-ico"><Dots /></span>
          <span className="u-lbl">已深度思考</span>
          <span className="u-spacer" />
          <span className="u-meta">{part.data.steps.join("").length} 字</span>
        </div>
      );
    case "toolCall": {
      const spec = part.data;
      const b = spec.body;
      // 草稿/二维码/问卷 fullpage 保持生产专用组件;其它工具统一走生产 chatUnified。
      if (b.kind === "writeDraftCard") return <DraftMiniCard body={b.data} />;
      if (b.kind === "qrCard") return <QrCard data={b.data} />;
      if (b.kind === "askUser" && b.data.mode.kind === "fullpage") return <OldPart part={part} />;
      return <UnifiedToolCall spec={spec} />;
    }
  }
}
