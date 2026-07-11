import { useState } from "react";
import type { ConnectorId, ConnectorInfo, ConnectorState, QrCardBody } from "@qingagent/contract-ts";
import { useClientCapabilities } from "../../system";
import { useToast } from "../../system/ToastProvider";
import { AuthCard } from "../../pages/workspace/components/QrCard";
import { useConnectors } from "./useConnectors";

type GithubStartResult = { user_code: string; verification_uri: string; expiresAt: string; pendingId: string };
type FeishuStartResult =
  | { mode: "authorization"; verification_url: string; user_code: string; expiresAt: string; pendingId: string }
  | { mode: "configuration"; configuration_url: string; expiresAt: string; pendingId: string };
type WechatStartResult = { imageDataUri: string; expiresInSec: number; pendingId: string };

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value) throw new Error(`授权响应缺少 ${field}`);
  return value;
}

function absoluteExpiry(value: unknown): number {
  const expiresAt = Date.parse(requireString(value, "expiresAt"));
  if (!Number.isFinite(expiresAt)) throw new Error("授权响应 expiresAt 非法");
  return expiresAt;
}

export function mapConnectorStart(id: ConnectorId, value: unknown, now = Date.now()): QrCardBody {
  if (id === "github") {
    const result = value as Partial<GithubStartResult>;
    return { connectorId: id, pendingId: requireString(result.pendingId, "pendingId"), title: "连接 GitHub", content: requireString(result.verification_uri, "verification_uri"),
      code: requireString(result.user_code, "user_code"), note: "在浏览器打开授权页面，输入上方代码并确认授权。", expiresAt: absoluteExpiry(result.expiresAt),
      refreshQuery: "重新连接 GitHub", confirmQuery: null };
  }
  if (id === "feishu") {
    const result = value as Partial<FeishuStartResult>;
    if (result.mode !== "authorization" && result.mode !== "configuration") throw new Error("授权响应 mode 非法");
    if (result.mode === "configuration") {
      const url = requireString(result.configuration_url, "configuration_url");
      return { connectorId: id, pendingId: requireString(result.pendingId, "pendingId"), title: "配置飞书应用", content: url,
        code: null, note: `这是飞书应用配置步骤，请[点此打开创建向导](${url})并按指引完成配置。`, expiresAt: absoluteExpiry(result.expiresAt),
        refreshQuery: "重新配置飞书应用", confirmQuery: null };
    }
    const authorization = result as Partial<Extract<FeishuStartResult, { mode: "authorization" }>>;
    const url = requireString(authorization.verification_url, "verification_url");
    return { connectorId: id, pendingId: requireString(result.pendingId, "pendingId"), title: "扫码授权飞书", content: url,
      code: requireString(authorization.user_code, "user_code"), note: `用飞书 App 扫码，或[点此在浏览器授权](${url})并输入配对码。`, expiresAt: absoluteExpiry(result.expiresAt),
      refreshQuery: "重新授权飞书", confirmQuery: null };
  }
  const result = value as Partial<WechatStartResult>;
  if (typeof result.expiresInSec !== "number" || !Number.isFinite(result.expiresInSec) || result.expiresInSec <= 0) throw new Error("授权响应 expiresInSec 非法");
  return { connectorId: id, pendingId: requireString(result.pendingId, "pendingId"), title: "扫码登录微信公众平台", content: "", imageDataUri: requireString(result.imageDataUri, "imageDataUri"),
    code: null, note: "用你自己的微信扫码登录公众平台后台。登录态可能提前失效，届时可重新扫码。",
    expiresAt: now + result.expiresInSec * 1000, refreshQuery: "重新登录微信公众号", confirmQuery: null };
}

function startLabel(connector: ConnectorInfo): string {
  if (connector.id === "github") {
    if (connector.status.state === "connected") return "升级私有仓授权";
    return connector.status.state === "needs_reauth" ? "重新授权" : "连 接";
  }
  if (connector.id === "feishu") return connector.status.state === "unconfigured" ? "创建应用" : connector.status.state === "needs_reauth" ? "重新扫码" : "扫码授权";
  return connector.status.state === "needs_reauth" ? "重新扫码" : "扫码登录";
}

const STATUS_LABELS: Record<ConnectorState, string> = {
  unavailable: "此环境不可用",
  unconfigured: "未配置",
  disconnected: "未连接",
  pending: "等待授权",
  connected: "已连接",
  needs_reauth: "需重新授权",
};

// 技能 id → 面板显示名(与 SKILL.md label 对齐;缺省回退 id)。
const SKILL_LABELS: Record<string, string> = {
  "github-materials": "GitHub 素材",
  feishu: "连飞书",
  "wechat-official-account": "抓公众号",
};

// 飞书 scope 前缀 → 能力域显示名;原始 scope 串是实现细节,面板按域聚合展示。
const FEISHU_DOMAIN_LABELS: Record<string, string> = {
  docs: "文档",
  docx: "文档",
  wiki: "知识库",
  base: "多维表格",
  bitable: "多维表格",
  sheets: "电子表格",
  calendar: "日历",
  im: "消息",
  drive: "云盘",
  mail: "邮件",
  task: "任务",
  approval: "审批",
  contact: "通讯录",
  minutes: "妙记",
  attendance: "考勤",
  vc: "视频会议",
  auth: "基础身份",
  offline_access: "离线访问",
};

function displayScopes(id: ConnectorId, scopes: readonly string[]): string[] {
  if (id !== "feishu") return [...scopes];
  const domains = new Set<string>();
  for (const scope of scopes) {
    const prefix = scope.split(":")[0] ?? scope;
    domains.add(FEISHU_DOMAIN_LABELS[prefix] ?? prefix);
  }
  return [...domains];
}

const STATE_COPY: Record<ConnectorId, Partial<Record<ConnectorState, string>>> = {
  github: {
    unavailable: "当前环境无法使用 GitHub 连接",
    unconfigured: "尚未配置 GitHub OAuth App",
    disconnected: "连接后可搜索和读取账号可见仓库",
    pending: "请在对话里的授权卡完成 GitHub 验证",
    connected: "已可读取授权范围内的 GitHub 仓库",
    needs_reauth: "GitHub 授权已失效，请重新连接",
  },
  feishu: {
    unavailable: "当前环境无法使用飞书连接",
    unconfigured: "尚未配置飞书应用",
    disconnected: "应用已配置，授权后可代你操作飞书",
    pending: "请在对话里的授权卡完成扫码",
    connected: "飞书应用已配置并完成授权",
    needs_reauth: "授权已失效，重新扫码即可恢复",
  },
  "wechat-mp": {
    unavailable: "当前环境无法使用公众号连接",
    unconfigured: "尚未登录微信公众平台",
    disconnected: "贴文章链接无需登录；按公众号名搜索才需扫码",
    pending: "请在对话里的授权卡完成扫码",
    connected: "登录态在本地最多保留约 80 小时，微信可能提前要求重新登录",
    needs_reauth: "微信可能提前要求重新登录，重新扫码即可恢复",
  },
};

function ConnectorIcon({ connector }: { connector: ConnectorInfo }) {
  return (
    <span className={`cn-icon cn-icon--${connector.icon}`} aria-hidden="true">
      {connector.id === "github" ? "GH" : connector.id === "feishu" ? "飞" : "微"}
    </span>
  );
}

function Badge({ state, connectorId }: { state: ConnectorState; connectorId: ConnectorId }) {
  return (
    <span className={`ss-badge cn-badge cn-badge--${state}`}>
      {STATUS_LABELS[state]}
    </span>
  );
}

function detailStatus(connector: ConnectorInfo): string {
  const base = STATE_COPY[connector.id][connector.status.state] ?? STATUS_LABELS[connector.status.state];
  if (connector.id === "wechat-mp" && connector.status.lastCheckedAt) {
    return `${base}。最近检查：${new Date(connector.status.lastCheckedAt).toLocaleString("zh-CN")}`;
  }
  if (connector.id === "github" && connector.status.reasonCode === "ACCOUNT_CHANGE_CONFIRMATION_REQUIRED") {
    return "检测到授权账号发生变化。为避免误切账号，当前连接未被替换；请先断开，再明确连接新账号。";
  }
  if (connector.id === "github" && connector.status.reasonCode === "INSUFFICIENT_SCOPE") {
    return "当前授权范围不足。读取私有仓需要在对话中明确同意增量授权 repo；失败不会破坏已有公开仓连接。";
  }
  return base;
}

export interface ConnectionsPanelProps {
  selectedId?: ConnectorId | null;
  onSelectedIdChange?: (id: ConnectorId | null) => void;
}

export function ConnectionsPanel({ selectedId: controlledId, onSelectedIdChange }: ConnectionsPanelProps) {
  const capabilities = useClientCapabilities();
  const { connectors, loading, error, refresh, start, probe, disconnect } = useConnectors();
  const toast = useToast();
  // 未提供回调时把 selectedId 当作初始值，避免半受控调用导致返回按钮失效。
  const [localId, setLocalId] = useState<ConnectorId | null>(controlledId ?? null);
  const [busy, setBusy] = useState(false);
  const [authCard, setAuthCard] = useState<{ connectorId: ConnectorId; data: QrCardBody } | null>(null);
  const selectedId = onSelectedIdChange ? controlledId ?? null : localId;
  const select = (id: ConnectorId | null) => {
    setLocalId(id);
    onSelectedIdChange?.(id);
  };

  if (capabilities?.connectors?.mutationEnabled === false) {
    return (
      <div className="cn-unavailable" data-wf="ConnectionsUnavailable">
        <div className="cn-unavailable-title">此环境不可用</div>
        <p>连接器仅在桌面客户端或显式启用的单用户服务中开放。</p>
      </div>
    );
  }

  const selected = selectedId ? connectors.find((item) => item.id === selectedId) ?? null : null;
  if (selectedId && selected) {
    const guide = selected.id === "feishu"
      ? "到对话里说「连飞书」发起授权。"
      : selected.id === "github"
        ? "到对话里说「连接 GitHub」发起授权。"
        : "到对话里说「登录公众号」发起授权。";
    const showGuide = ["unconfigured", "disconnected", "needs_reauth"].includes(selected.status.state);
    // GitHub 已连接但只有公开仓授权:提供一键升级到 repo(含私有仓)。
    const needsRepoUpgrade = selected.id === "github"
      && selected.status.state === "connected"
      && !selected.status.scopes.includes("repo");
    const canStart = (selected.id === "feishu"
      ? ["unconfigured", "disconnected", "needs_reauth"]
      : ["disconnected", "needs_reauth"]).includes(selected.status.state) || needsRepoUpgrade;
    const canDisconnect = ["connected", "needs_reauth"].includes(selected.status.state);
    const selectedAuthCard = authCard?.connectorId === selected.id ? authCard.data : null;
    const visibleState: ConnectorState = selectedAuthCard ? "pending" : selected.status.state;
    const initiate = async () => {
      setBusy(true);
      try {
        // GitHub 默认请求 repo(含私有仓):用户点「连接」的预期就是能读自己的全部仓库。
        const body = selected.id === "github" ? { scope: "repo" } : {};
        setAuthCard({ connectorId: selected.id, data: mapConnectorStart(selected.id, await start(selected.id, body)) });
      } catch (cause) {
        toast.show({ message: cause instanceof Error ? cause.message : "发起授权失败", tone: "error" });
        throw cause;
      } finally { setBusy(false); }
    };
    return (
      <div className="cn-detail" data-wf="ConnectionDetail" data-connector-id={selected.id}>
        <div className="sk-subhead">
          <button type="button" className="sk-back" onClick={() => select(null)}>
            <span className="sk-back-arrow" aria-hidden="true">‹</span>返回连接
          </button>
          <span className="sk-subtitle">连接详情</span>
        </div>
        <div className="cnd-hero">
          <ConnectorIcon connector={selected} />
          <span className="cnd-name">{selected.name}</span>
          <Badge state={visibleState} connectorId={selected.id} />
          {!selected.official && <span className="cn-unofficial">非官方接口 ⚠</span>}
        </div>
        <p className="cnd-status">{selectedAuthCard ? "请在下方授权卡完成操作，页面会自动更新连接状态" : detailStatus(selected)}</p>
        {selectedAuthCard ? (
          <div className="cnd-authcard"><AuthCard data={selectedAuthCard} onRefresh={initiate} onStatusChange={() => {
            void refresh().then(() => setAuthCard(null)).catch(() => undefined);
          }} /></div>
        ) : canStart ? (
          <div className="cnd-action"><button type="button" className="sm-btn primary" disabled={busy} onClick={() => { void initiate().catch(() => undefined); }}>
            {busy ? "发起中…" : startLabel(selected)}
          </button></div>
        ) : null}
        {showGuide ? (
          <div className="cnd-guide">{guide}<br />你也可以继续在对话中按需发起授权。</div>
        ) : null}
        {needsRepoUpgrade && !selectedAuthCard && (
          <div className="cnd-guide">当前仅授权公开仓。点击上方按钮可升级到含私有仓的完整授权；升级失败不会影响现有连接。</div>
        )}
        {selected.status.canProbe && (
          <div className="cnd-action">
            <button type="button" className="sm-btn" disabled={busy} onClick={async () => {
              setBusy(true);
              try {
                await probe(selected.id);
                toast.show({ message: "连接状态已更新", tone: "success" });
              } catch (cause) {
                toast.show({ message: cause instanceof Error ? cause.message : "检查失败", tone: "error" });
              } finally { setBusy(false); }
            }}>立即检查</button>
          </div>
        )}
        <section className="cnd-sec">
          <div className="cnd-sec-title">被谁使用</div>
          <div className="cnd-sec-body">{selected.usedBySkills.length > 0 ? selected.usedBySkills.map((skill) => `技能「${SKILL_LABELS[skill] ?? skill}」`).join("、") : "暂无技能依赖"}</div>
        </section>
        {selected.status.scopes.length > 0 && (
          <section className="cnd-sec">
            <div className="cnd-sec-title">已授权能力域</div>
            <div className="cnd-sec-body cn-scopes" title={selected.status.scopes.join(" ")}>{displayScopes(selected.id, selected.status.scopes).map((scope) => <span key={scope} className="ss-badge">{scope}</span>)}</div>
          </section>
        )}
        {!selected.official && selected.riskNote && <div className="cnd-warnbox">{selected.riskNote}</div>}
        {canDisconnect && (
          <div className="cnd-foot">
            <span>只清除本机凭据；如需彻底撤销，请到服务方后台操作。</span>
            <button type="button" className="sk-btn-danger" disabled={busy} onClick={async () => {
              setBusy(true);
              try {
                await disconnect(selected.id);
                toast.show({ message: "已断开连接", tone: "success" });
              } catch (cause) {
                toast.show({ message: cause instanceof Error ? cause.message : "断开失败", tone: "error" });
              } finally { setBusy(false); }
            }}>{selected.id === "wechat-mp" ? "退出登录" : "断开连接"}</button>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="settings-connections" data-wf="ConnectionsPanel">
      <p className="sm-note" style={{ marginTop: 0 }}>管理青简以你的身份访问的外部服务。可在详情页主动连接，也可在对话里按需发起。</p>
      {loading && connectors.length === 0 && <p className="sm-empty">加载中…</p>}
      {error && <p className="sm-message">{error}</p>}
      <div className="cn-list">
        {connectors.map((connector) => (
          <button key={connector.id} type="button" className="cn-row" onClick={() => select(connector.id)}>
            <ConnectorIcon connector={connector} />
            <span className="cn-titleblock">
              <span className="cn-titleline">
                <span className="cn-name">{connector.name}</span>
                <Badge state={connector.status.state} connectorId={connector.id} />
                {!connector.official && <span className="cn-unofficial">非官方接口 ⚠</span>}
              </span>
              <span className="cn-sub">{STATE_COPY[connector.id][connector.status.state] ?? STATUS_LABELS[connector.status.state]}</span>
            </span>
            <span className="cn-caret" aria-hidden="true">›</span>
          </button>
        ))}
      </div>
    </div>
  );
}
