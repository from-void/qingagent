import { useState } from "react";
import type { ConnectorId, ConnectorInfo, ConnectorState } from "@qingagent/contract-ts";
import { useClientCapabilities } from "../../system";
import { useToast } from "../../system/ToastProvider";
import { useConnectors } from "./useConnectors";

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
  const { connectors, loading, error, probe, disconnect } = useConnectors();
  const toast = useToast();
  // 未提供回调时把 selectedId 当作初始值，避免半受控调用导致返回按钮失效。
  const [localId, setLocalId] = useState<ConnectorId | null>(controlledId ?? null);
  const [busy, setBusy] = useState(false);
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
    const canDisconnect = ["connected", "needs_reauth"].includes(selected.status.state);
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
          <Badge state={selected.status.state} connectorId={selected.id} />
          {!selected.official && <span className="cn-unofficial">非官方接口 ⚠</span>}
        </div>
        <p className="cnd-status">{detailStatus(selected)}</p>
        {showGuide ? (
          <div className="cnd-guide">{guide}<br />设置页不直接发起授权；你可以在这里检查或断开现有连接。</div>
        ) : null}
        {selected.id === "github" && selected.status.state === "connected" && !selected.status.scopes.includes("repo") && (
          <div className="cnd-guide">当前仅授权公开仓。需要读取私有仓时，系统会在对话中说明并请求增量 repo 授权；授权失败不会影响现有连接。</div>
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
      <p className="sm-note" style={{ marginTop: 0 }}>管理青简以你的身份访问的外部服务。授权在对话里按需发生。</p>
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
