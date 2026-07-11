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
  if (connector.id === "github") return connector.status.state === "needs_reauth" ? "重新授权" : "连 接";
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

// 详情页开场白:一段话说清这个连接给青简带来什么、怎么用。
// 技能依赖与非官方接口的风险都融在这段里,不再单列「被谁使用」/警示区块。
const DESCRIPTIONS: Record<ConnectorId, string> = {
  github: "GitHub 是全球最大的代码与文档托管平台。连接你的 GitHub 账号后，青简可以搜索并读取你名下和有权访问的仓库——代码、README、技术文档都能作为写作素材直接取用（由技能「GitHub 素材」调用）。公开仓库无需连接也能读取。",
  feishu: "飞书是常用的协同办公平台。完成授权后，青简可以以你的身份读写飞书里的文档、多维表格、电子表格、日历等内容，写好的稿子可以直接发到飞书，也能从飞书取材（由技能「连飞书」调用）。",
  "wechat-mp": "微信公众平台是公众号文章的后台。登录后，青简可以按公众号名称搜索文章、抓取正文全文做写作素材（由技能「抓公众号」调用）；只是贴单篇文章链接则无需登录。登录走微信网页版接口（非官方渠道），登录态最长保留约 80 小时，也可能被微信提前失效，重新扫码即可恢复。",
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
  board: "画板",
  okr: "OKR",
  profile: "个人资料",
  search: "搜索",
  slides: "幻灯片",
  space: "知识空间",
  spark: "妙搭",
  event: "事件订阅",
  aily: "智能伙伴",
  helpdesk: "服务台",
  hire: "招聘",
  report: "汇报",
  translation: "翻译",
};

// 仅飞书展示授权范围(域多才有信息量);GitHub/微信对用户就是「授权/没授权」二元,不摆 scope。
function displayScopes(id: ConnectorId, scopes: readonly string[]): string[] {
  if (id !== "feishu") return [...scopes];
  const domains = new Set<string>();
  for (const scope of scopes) {
    const prefix = scope.split(":")[0] ?? scope;
    domains.add(FEISHU_DOMAIN_LABELS[prefix] ?? prefix);
  }
  return [...domains].sort((a, b) => a.localeCompare(b, "zh-Hans-CN"));
}

const STATE_COPY: Record<ConnectorId, Partial<Record<ConnectorState, string>>> = {
  github: {
    unavailable: "当前环境无法使用 GitHub 连接",
    unconfigured: "尚未配置 GitHub OAuth App",
    disconnected: "连接后可搜索和读取账号可见仓库",
    pending: "授权验证进行中，请在发起处的授权卡完成",
    connected: "已可读取授权范围内的 GitHub 仓库",
    needs_reauth: "GitHub 授权已失效，请重新连接",
  },
  feishu: {
    unavailable: "当前环境无法使用飞书连接",
    unconfigured: "尚未配置飞书应用",
    disconnected: "应用已配置，授权后可代你操作飞书",
    pending: "扫码验证进行中，请在发起处的授权卡完成",
    connected: "飞书应用已配置并完成授权",
    needs_reauth: "授权已失效，重新扫码即可恢复",
  },
  "wechat-mp": {
    unavailable: "当前环境无法使用公众号连接",
    unconfigured: "尚未登录微信公众平台",
    disconnected: "贴文章链接无需登录；按公众号名搜索才需扫码",
    pending: "扫码验证进行中，请在发起处的授权卡完成",
    connected: "登录态在本地最多保留约 80 小时，微信可能提前要求重新登录",
    needs_reauth: "微信可能提前要求重新登录，重新扫码即可恢复",
  },
};

// 品牌图标:与拍板稿一致的单色线稿(同 viewBox/笔画宽度,风格统一);
// currentColor 跟随 .cn-icon 配色,不引入品牌原色。
const ICON_PATHS: Record<ConnectorId, JSX.Element> = {
  github: (
    <path d="M10 2.6a7.4 7.4 0 0 0-2.34 14.42c.37.07.5-.16.5-.36v-1.26c-2.06.45-2.5-.99-2.5-.99-.34-.85-.82-1.08-.82-1.08-.67-.46.05-.45.05-.45.74.05 1.13.76 1.13.76.66 1.13 1.73.8 2.15.61.07-.48.26-.8.47-.99-1.64-.19-3.37-.82-3.37-3.66 0-.8.29-1.47.76-1.98-.08-.19-.33-.94.07-1.96 0 0 .62-.2 2.03.76a7.07 7.07 0 0 1 3.7 0c1.4-.96 2.02-.76 2.02-.76.4 1.02.15 1.77.07 1.96.47.51.76 1.17.76 1.98 0 2.85-1.73 3.47-3.38 3.65.27.23.5.68.5 1.37v2.03c0 .2.13.44.51.36A7.4 7.4 0 0 0 10 2.6Z" />
  ),
  feishu: (
    <>
      <path d="M3 7.5c3.2.4 5.8 1.5 7.8 3.4 2 1.9 3 3.9 3.2 6.1" />
      <path d="M6.5 4c2.7 1 4.9 2.5 6.6 4.6a15 15 0 0 1 2.9 6" />
      <path d="M13.5 3.5c1.6.5 2.9 1.4 3.5 2.6-1.1.5-2.5.7-4 .5" />
    </>
  ),
  "wechat-mp": (
    <>
      <path d="M8.2 12.4c-.7 0-1.4-.1-2-.3l-2.1 1.1.6-1.9A4.5 4.5 0 0 1 2.6 7.8c0-2.6 2.5-4.7 5.6-4.7 2.8 0 5.1 1.7 5.5 3.9" />
      <path d="M11.5 16.2c.6.2 1.2.3 1.8.3l1.9 1-.5-1.7c1.2-.8 2-2 2-3.3 0-2.2-2.1-4-4.7-4s-4.7 1.8-4.7 4 2.1 4 4.7 4Z" />
    </>
  ),
};

function ConnectorIcon({ connector }: { connector: ConnectorInfo }) {
  return (
    <span className={`cn-icon cn-icon--${connector.icon}`} aria-hidden="true">
      <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
        {ICON_PATHS[connector.id]}
      </svg>
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

// 已连接态首要信息是「以谁的身份」:优先展示账号名,没有账号时回退通用句。
function connectedLine(connector: ConnectorInfo): string | null {
  const name = connector.status.account?.displayName;
  if (connector.status.state !== "connected" || !name) return null;
  if (connector.id === "github") return `已连接为 ${name}`;
  if (connector.id === "feishu") return `已授权给 ${name}`;
  return `已登录「${name}」公众号`;
}

function listSubtitle(connector: ConnectorInfo): string {
  const line = connectedLine(connector);
  if (line) return line;
  return STATE_COPY[connector.id][connector.status.state] ?? STATUS_LABELS[connector.status.state];
}

// 详情页状态行:开场白已介绍用途,这里只讲「当前是什么状态」。
// 未连接/未配置时返回 null(徽标已表达,不再重复一句废话)。
function detailStatus(connector: ConnectorInfo): string | null {
  if (connector.id === "github" && connector.status.reasonCode === "ACCOUNT_CHANGE_CONFIRMATION_REQUIRED") {
    return "检测到授权账号发生变化。为避免误切账号，当前连接未被替换；请先断开，再明确连接新账号。";
  }
  if (connector.id === "github" && connector.status.reasonCode === "INSUFFICIENT_SCOPE") {
    return "当前授权范围不足，重新授权即可扩展；失败不会影响现有连接。";
  }
  // 已连接的账号句放在页面底部断开区,这里不重复;未连接/未配置由徽标表达,同样不占一行。
  if (["connected", "disconnected", "unconfigured"].includes(connector.status.state)) return null;
  return STATE_COPY[connector.id][connector.status.state] ?? STATUS_LABELS[connector.status.state];
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
      ? "也可以在对话里说「连飞书」发起。"
      : selected.id === "github"
        ? "也可以在对话里说「连接 GitHub」发起。"
        : "也可以在对话里说「登录公众号」发起。";
    const showGuide = ["unconfigured", "disconnected", "needs_reauth"].includes(selected.status.state);
    const canStart = (selected.id === "feishu"
      ? ["unconfigured", "disconnected", "needs_reauth"]
      : ["disconnected", "needs_reauth"]).includes(selected.status.state);
    const canDisconnect = ["connected", "needs_reauth"].includes(selected.status.state);
    const selectedAuthCard = authCard?.connectorId === selected.id ? authCard.data : null;
    const visibleState: ConnectorState = selectedAuthCard ? "pending" : selected.status.state;
    const initiate = async () => {
      setBusy(true);
      try {
        // GitHub 一律请求 repo(含私有仓):对用户就是「授权/没授权」,不区分公私仓档位。
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
        </div>
        <p className="cnd-desc">{DESCRIPTIONS[selected.id]}</p>
        {(selectedAuthCard || detailStatus(selected)) && (
          <p className="cnd-status">{selectedAuthCard ? "请在下方授权卡完成操作，页面会自动更新连接状态。" : detailStatus(selected)}</p>
        )}
        {selectedAuthCard ? (
          <div className="cnd-authcard"><AuthCard data={selectedAuthCard} onRefresh={initiate} onStatusChange={() => {
            void refresh().then(() => setAuthCard(null)).catch(() => undefined);
          }} /></div>
        ) : (canStart || selected.status.canProbe) ? (
          <div className="cnd-action">
            {canStart && (
              <button type="button" className="sm-btn big primary" disabled={busy} onClick={() => { void initiate().catch(() => undefined); }}>
                {busy ? "发起中…" : startLabel(selected)}
              </button>
            )}
            {selected.status.canProbe && (
              <button type="button" className="sm-btn" disabled={busy} onClick={async () => {
                setBusy(true);
                try {
                  await probe(selected.id);
                  toast.show({ message: "连接状态已更新", tone: "success" });
                } catch (cause) {
                  toast.show({ message: cause instanceof Error ? cause.message : "检查失败", tone: "error" });
                } finally { setBusy(false); }
              }}>立即检查</button>
            )}
          </div>
        ) : null}
        {!selectedAuthCard && showGuide && (
          <p className="cnd-note">{guide}</p>
        )}
        {selected.id === "feishu" && selected.status.scopes.length > 0 && (
          <section className="cnd-sec">
            <div className="cnd-sec-title">已授权范围</div>
            <div className="cnd-sec-body cn-scopes" title={selected.status.scopes.join(" ")}>{displayScopes(selected.id, selected.status.scopes).map((scope) => <span key={scope} className="ss-badge">{scope}</span>)}</div>
          </section>
        )}
        {canDisconnect && (
          <div className="cnd-foot">
            <span>{connectedLine(selected) ? `${connectedLine(selected)}。` : ""}断开只清除本机凭据；如需彻底撤销，请到服务方后台操作。</span>
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
              </span>
              <span className="cn-sub">{listSubtitle(connector)}</span>
            </span>
            <span className="cn-caret" aria-hidden="true">›</span>
          </button>
        ))}
      </div>
    </div>
  );
}
