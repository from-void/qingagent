import { useEffect, useRef, useState } from "react";
import type { UsageSummaryRow } from "@qingagent/contract-ts";
import { CaretIcon } from "../../system/icons";
import { aggregateUsageRows, effectiveCacheHitRate } from "./usageMetrics";
import type { BalanceState } from "./modelSettingsTypes";
import type { ModelProvider } from "./visitorKeyStore";

export type UsageRow = UsageSummaryRow;
export type UsageView = "day" | "session" | "total";
export type UsageMode = "simple" | "expert";

const USAGE_MODE_STORAGE_KEY = "qingagent:model-usage-mode";

export interface UsageGroup {
  key: string;
  label: string;
  rows: UsageRow[];
  summary: UsageRow;
  children?: UsageGroup[];
}

export function readUsageMode(): UsageMode {
  if (typeof window === "undefined") return "simple";
  try {
    return window.localStorage.getItem(USAGE_MODE_STORAGE_KEY) === "expert" ? "expert" : "simple";
  } catch {
    return "simple";
  }
}

export function persistUsageMode(mode: UsageMode): void {
  try {
    window.localStorage.setItem(USAGE_MODE_STORAGE_KEY, mode);
  } catch {
    // 浏览器禁用存储时仍允许本次会话内切换，不用 toast 打断查看。
  }
}

export function buildUsageGroups(rows: UsageRow[], view: UsageView): UsageGroup[] {
  const buckets = new Map<string, UsageRow[]>();
  for (const row of rows) {
    const key = view === "total" ? "total" : row.bucket;
    const bucketRows = buckets.get(key);
    if (bucketRows) bucketRows.push(row);
    else buckets.set(key, [row]);
  }

  return Array.from(buckets, ([key, bucketRows]) => {
    const groupKey = `${view}:${key}`;
    return {
      key: groupKey,
      label: view === "session"
        ? bucketRows.find((row) => row.label)?.label || "未命名草稿"
        : view === "total"
          ? "全部用量"
          : key,
      rows: bucketRows,
      summary: aggregateUsageRows(key, bucketRows),
      ...(view === "day"
        ? { children: buildDayDocumentGroups(groupKey, bucketRows) }
        : {}),
    };
  });
}

function buildDayDocumentGroups(dayKey: string, rows: UsageRow[]): UsageGroup[] {
  const documents = new Map<string, UsageRow[]>();
  for (const row of rows) {
    const key = row.documentId ?? `legacy:${row.documentTitle ?? "unknown"}`;
    const documentRows = documents.get(key);
    if (documentRows) documentRows.push(row);
    else documents.set(key, [row]);
  }
  return Array.from(documents, ([documentId, documentRows]) => ({
    key: `${dayKey}:document:${documentId}`,
    label: documentRows.find((row) => row.documentTitle)?.documentTitle || "未命名草稿",
    rows: documentRows,
    summary: aggregateUsageRows(documentRows[0]?.bucket ?? "", documentRows),
  }));
}

export function UsageTableRow({
  row,
  label,
  mode,
  kind,
  expanded = false,
  childCount = 0,
  onToggle,
}: {
  row: UsageRow;
  label: string;
  mode: UsageMode;
  kind: "group" | "document" | "detail";
  expanded?: boolean;
  childCount?: number;
  onToggle?: () => void;
}) {
  const cacheRate = mode === "simple" ? effectiveCacheHitRate(row) : row.cacheHitRate;
  const hitRate = cacheRate == null ? null : Math.round(cacheRate * 100);
  const isExpandable = mode === "expert" && kind !== "detail";
  const rowClass = kind === "detail"
    ? "md-usage-detail-row"
    : kind === "document"
      ? "md-usage-document-row"
      : "md-usage-group-row";
  const dataWf = kind === "detail"
    ? "UsageDetailRow"
    : kind === "document"
      ? "UsageDocumentRow"
      : "UsageGroupRow";
  const peakMultiplier = row.peakPricingMultiplierMin === row.peakPricingMultiplierMax
    ? `${row.peakPricingMultiplierMin}×`
    : `${row.peakPricingMultiplierMin}～${row.peakPricingMultiplierMax}×`;

  return (
    <tr
      className={rowClass}
      data-wf={dataWf}
    >
      <td className={kind === "detail" ? "md-detail-spacer" : `md-cell-title md-cell-title--${kind}`}>
        {isExpandable ? (
          <button
            type="button"
            className={`md-usage-group-toggle${kind === "document" ? " md-usage-group-toggle--document" : ""}`}
            aria-expanded={expanded}
            onClick={onToggle}
          >
            <span className="md-usage-group-arrow" aria-hidden="true"><CaretIcon size={13} direction="right" /></span>
            <span className="md-usage-group-label">{label}</span>
          </button>
        ) : label}
      </td>
      {mode === "expert" && (
        <td>{row.modelId === "__multiple__" ? "多模型" : modelLabel(row.modelId)}</td>
      )}
      {mode === "expert" && (
        <td className={kind === "detail" ? "font-mono md-callsite-detail" : "md-callsite-summary"}>
          {kind === "detail" ? row.callSite : `${childCount} 个调用点`}
        </td>
      )}
      {mode === "expert" && (
        <td
          className="font-mono"
          title={`共 ${row.calls} 次，精确 ${row.recordedCalls} 次，估算 ${row.estimatedCalls ?? 0} 次，结果未知 ${row.billingUnknownCalls ?? 0} 次，未接 wire ${row.missingCalls} 次`}
        >
          {`${Math.round(row.coverageRate * 100)}% · ${row.recordedCalls}/${row.calls}`}
        </td>
      )}
      <td className="font-mono">{formatTokens(row.inputTokens)}</td>
      <td className="font-mono">{formatTokens(row.outputTokens)}</td>
      <td className="font-mono">
        {hitRate === null ? (mode === "simple" ? "—" : "未知") : `${hitRate}%`}
      </td>
      {mode === "expert" && (
        <td className="font-mono">{formatCompactTokens(row.coldStartMissTokens ?? 0)}</td>
      )}
      <td className="font-mono md-cost-cell">
        <span>{row.costCny != null ? `¥${row.costCny.toFixed(3)}` : "—"}</span>
        {(row.estimatedCostCny ?? 0) > 0 ? (
          <small title="按已发送 prompt 与中止前已收 delta 本地估算">
            估 {`¥${row.estimatedCostCny!.toFixed(3)}`}
          </small>
        ) : null}
        {(row.peakPricedCalls ?? 0) > 0 ? (
          <small title="DeepSeek 按调用开始时的北京时间高峰窗口计价，倍率已计入上方金额">
            高峰 {peakMultiplier} · {row.peakPricedCalls} 次
          </small>
        ) : null}
      </td>
    </tr>
  );
}

export function HelpMark({ label, text }: { label: string; text: string }) {
  return (
    <button type="button" className="md-th-help" aria-label={`${label}:${text}`} title={text}>
      ?
    </button>
  );
}

// 数字 count-up:从上一个值平滑涨到目标(easeOutCubic);尊重 prefers-reduced-motion。
export function AnimatedNumber({
  value,
  format,
  durationMs = 900,
}: {
  value: number;
  format: (n: number) => string;
  durationMs?: number;
}) {
  const [display, setDisplay] = useState(0);
  const fromRef = useRef(0);
  const rafRef = useRef<number | null>(null);
  useEffect(() => {
    const reduce =
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    const from = fromRef.current;
    const to = value;
    if (reduce || from === to) {
      fromRef.current = to;
      setDisplay(to);
      return;
    }
    const start = performance.now();
    const tick = (now: number) => {
      const p = Math.min(1, (now - start) / durationMs);
      const eased = 1 - Math.pow(1 - p, 3);
      setDisplay(from + (to - from) * eased);
      if (p < 1) {
        rafRef.current = requestAnimationFrame(tick);
      } else {
        fromRef.current = to;
        setDisplay(to);
      }
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [value, durationMs]);
  return <>{format(display)}</>;
}

// 金额降级:小额 3 位 / 个位 2 位 / 过百 1 位 / 过万切"万",窄区域不溢出。
export function fmtMoney(n: number): string {
  if (!Number.isFinite(n)) return "—";
  if (n >= 10000) return `¥${(n / 10000).toFixed(2)}万`;
  if (n >= 100) return `¥${n.toFixed(1)}`;
  if (n >= 1) return `¥${n.toFixed(2)}`;
  return `¥${n.toFixed(3)}`;
}

// 字数降级:过万切"万字"
export function fmtWords(n: number): string {
  if (n >= 10000) return `${(n / 10000).toFixed(1)}万字`;
  return `${Math.round(n).toLocaleString()} 字`;
}

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function formatCompactTokens(n: number): string {
  if (n >= 1_000_000) return `${Number((n / 1_000_000).toFixed(2))}M`;
  if (n >= 1_000) return `${Number((n / 1_000).toFixed(1))}k`;
  return String(n);
}

// 只给已知的官方档位起中文短名;不认识的模型(第三方中转别名等)原样显示 id——
// 猜成「V4 Flash」会让模型多选里两个不同模型顶着同一个名字,分不清也点不明白。
export function modelLabel(modelId: string): string {
  switch (modelId) {
    case "deepseek-v4-flash":
      return "V4 Flash";
    case "deepseek-v4-pro":
      return "V4 PRO";
    case "kimi-for-coding":
      return "K2.7 Code";
    case "k3":
      return "K3";
    default:
      return modelId;
  }
}

// 按模型分布饼图:conic-gradient 分段 + 图例配色
export const PIE_COLORS = ["var(--qj-cinnabar)", "#7e9e8e", "#d8a657", "#9a8cb5"];
export function pieGradient(dist: Array<{ pct: number }>): string {
  let acc = 0;
  const stops = dist.map((m, i) => {
    const start = acc;
    acc += m.pct;
    return `${PIE_COLORS[i % PIE_COLORS.length]} ${start.toFixed(2)}% ${acc.toFixed(2)}%`;
  });
  return `conic-gradient(${stops.join(", ")})`;
}
export function toYMD(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// 连通性:自动 checkBalance 的结果 → 色点色调 + 中文文案(无 emoji)。
export function deriveConnectivity(
  balance: BalanceState | null,
  loading: boolean,
  provider: ModelProvider,
  probeVisible = true,
): { tone: "ok" | "bad" | "idle"; text: string } {
  // probeVisible=false:首拉在途且还没超过延迟阈值,先给中性「已配置」,别闪"正在检测连接…"
  const probing = { tone: "idle" as const, text: probeVisible ? "正在检测连接…" : "已配置" };
  if (loading) return probing;
  if (balance === null) {
    return provider === "kimi"
      ? { tone: "idle", text: "已配置 · Kimi 连接测试需手动触发" }
      : probing;
  }
  if (balance.permissionDenied) return { tone: "bad", text: "Kimi 套餐或模型权限不足" };
  if (balance.keyInvalid) return { tone: "bad", text: "key 无效,请检查" };
  if (balance.ok) return { tone: "ok", text: "已连通" };
  return { tone: "idle", text: balance.error ? `暂时无法连接 · ${balance.error}` : "暂时无法连接" };
}

// 近 N 天消耗:从 day 数据汇总 costCny / tokens / calls。
export function summarizeRecentDays(
  rows: UsageRow[] | null,
  days: number,
): {
  cost: number;
  estimatedCost: number;
  tokens: number;
  estimatedTokens: number;
  calls: number;
  recordedCalls: number;
  estimatedCalls: number;
  missingCalls: number;
  billingUnknownCalls: number;
  coverageRate: number;
  hasPriced: boolean;
} | null {
  if (rows === null) return null;
  if (rows.length === 0) {
    return {
      cost: 0,
      estimatedCost: 0,
      tokens: 0,
      estimatedTokens: 0,
      calls: 0,
      recordedCalls: 0,
      estimatedCalls: 0,
      missingCalls: 0,
      billingUnknownCalls: 0,
      coverageRate: 0,
      hasPriced: false,
    };
  }
  // bucket 是本地日历日 YYYY-MM-DD；窗口固定为“今天及之前 N-1 天”，不按有数据日期倒推。
  const today = new Date();
  const start = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  start.setDate(start.getDate() - Math.max(0, days - 1));
  const startYmd = toYMD(start);
  const endYmd = toYMD(today);
  let cost = 0;
  let estimatedCost = 0;
  let tokens = 0;
  let estimatedTokens = 0;
  let calls = 0;
  let recordedCalls = 0;
  let estimatedCalls = 0;
  let missingCalls = 0;
  let billingUnknownCalls = 0;
  let hasPriced = false;
  for (const r of rows) {
    if (r.bucket < startYmd || r.bucket > endYmd) continue;
    cost += r.costCny ?? 0;
    estimatedCost += r.estimatedCostCny ?? 0;
    if (r.costCny != null) hasPriced = true;
    tokens += r.inputTokens + r.outputTokens;
    estimatedTokens += (r.estimatedInputTokens ?? 0) + (r.estimatedOutputTokens ?? 0);
    calls += r.calls;
    recordedCalls += r.recordedCalls;
    estimatedCalls += r.estimatedCalls ?? 0;
    missingCalls += r.missingCalls;
    billingUnknownCalls += r.billingUnknownCalls ?? 0;
  }
  return {
    cost,
    estimatedCost,
    tokens,
    estimatedTokens,
    calls,
    recordedCalls,
    estimatedCalls,
    missingCalls,
    billingUnknownCalls,
    coverageRate: calls > 0 ? recordedCalls / calls : 0,
    hasPriced,
  };
}

// 按模型分布:total 数据按 modelId 聚合,算**费用**占比(降序)。
// 钱是用户真正关心的口径;没有价目表(费用为 0)的模型不进饼,tokens 降级成注脚。
export function buildModelDistribution(
  rows: UsageRow[] | null,
): Array<{ name: string; tokens: number; cost: number; pct: number }> | null {
  if (rows === null) return null;
  const map = new Map<string, { tokens: number; cost: number }>();
  for (const r of rows) {
    const prev = map.get(r.modelId) ?? { tokens: 0, cost: 0 };
    prev.tokens += r.inputTokens + r.outputTokens;
    prev.cost += r.costCny ?? 0;
    map.set(r.modelId, prev);
  }
  const priced = Array.from(map.entries()).filter(([, m]) => m.cost > 0);
  const total = priced.reduce((sum, [, m]) => sum + m.cost, 0);
  return priced
    .map(([modelId, m]) => ({
      name: modelLabel(modelId),
      tokens: m.tokens,
      cost: m.cost,
      pct: total > 0 ? (m.cost / total) * 100 : 0,
    }))
    .sort((a, b) => b.cost - a.cost);
}

// 按天趋势:day 数据按日期聚合(各模型相加),取最近 N 天,补齐日期序列;返回升序便于柱状从左到右。
export function buildDailyTrend(
  rows: UsageRow[] | null,
  days: number,
): { days: Array<{ date: string; label: string; cost: number; tokens: number }>; max: number } | null {
  if (rows === null) return null;
  const map = new Map<string, { cost: number; tokens: number }>();
  for (const r of rows) {
    if (r.bucket === "total" || !r.bucket) continue;
    const prev = map.get(r.bucket) ?? { cost: 0, tokens: 0 };
    prev.cost += r.costCny ?? 0;
    prev.tokens += r.inputTokens + r.outputTokens;
    map.set(r.bucket, prev);
  }
  // 固定生成"今天往前 days 天"的完整序列(升序),无数据的天补 0(空条占位)
  const today = new Date();
  const series: Array<{ date: string; label: string; cost: number; tokens: number }> = [];
  for (let i = days - 1; i >= 0; i -= 1) {
    const d = new Date(today);
    d.setDate(today.getDate() - i);
    const date = toYMD(d);
    const m = map.get(date);
    series.push({ date, label: date.slice(5), cost: m?.cost ?? 0, tokens: m?.tokens ?? 0 });
  }
  const max = series.reduce((mx, d) => Math.max(mx, d.cost), 0);
  return { days: series, max };
}
