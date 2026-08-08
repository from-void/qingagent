import { useEffect, useRef, useState } from "react";
import { CaretIcon } from "../../system/icons";
import type {
  ConnectorAuthPresentation,
  ConnectorId,
  ConnectorInfo,
  ConnectorState,
  QrCardBody,
} from "@qingagent/contract-ts";
import { useClientCapabilities, useConfirm } from "../../system";
import { useToast } from "../../system/ToastProvider";
import { AuthCard } from "../../pages/workspace/components/QrCard";
import {
  saveConnectorAuthSession,
  type ConnectorAuthSession,
} from "./connectorAuthSession";
import { useConnectors } from "./useConnectors";

type GithubStartResult = { user_code: string; verification_uri: string; expiresAt: string; pendingId: string };
type FeishuStartResult =
  | { mode: "authorization"; verification_url: string; user_code: string; expiresAt: string; pendingId: string }
  | { mode: "configuration"; configuration_url: string; expiresAt: string; pendingId: string };
type WechatStartResult = { imageDataUri: string; expiresInSec: number; pendingId: string };

// 与 core 的 LARK_AUTH_DOMAINS / feishuAuthDomainSchema 保持一致。设置页没有单次任务
// 上下文可据此裁剪授权范围，因此默认请求连接器实际支持的完整域集。
const DEFAULT_FEISHU_AUTH_DOMAINS = [
  "docs", "base", "sheets", "calendar", "im", "drive", "mail", "task",
  "approval", "contact", "minutes", "wiki",
] as const;

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value) throw new Error(`授权响应缺少 ${field}`);
  return value;
}

function absoluteExpiry(value: unknown): number {
  const expiresAt = Date.parse(requireString(value, "expiresAt"));
  if (!Number.isFinite(expiresAt)) throw new Error("授权响应 expiresAt 非法");
  return expiresAt;
}

export function mapConnectorStart(
  id: ConnectorId,
  presentation: ConnectorAuthPresentation,
  value: unknown,
  now = Date.now(),
): QrCardBody & { connectorId: ConnectorId; pendingId: string } {
  if (id === "github") {
    const result = value as Partial<GithubStartResult>;
    return { presentation, imageDataUri: null, connectorId: id, pendingId: requireString(result.pendingId, "pendingId"), title: "连接 GitHub", content: requireString(result.verification_uri, "verification_uri"),
      code: requireString(result.user_code, "user_code"), note: "在浏览器打开授权页面，输入上方代码并确认授权。", expiresAt: absoluteExpiry(result.expiresAt),
      refreshQuery: "重新连接 GitHub", confirmQuery: null };
  }
  if (id === "feishu") {
    const result = value as Partial<FeishuStartResult>;
    if (result.mode !== "authorization" && result.mode !== "configuration") throw new Error("授权响应 mode 非法");
    if (result.mode === "configuration") {
      const url = requireString(result.configuration_url, "configuration_url");
      return { presentation, imageDataUri: null, connectorId: id, pendingId: requireString(result.pendingId, "pendingId"), title: "配置飞书应用", content: url,
        code: null, note: `这是飞书应用配置步骤，请[点此打开创建向导](${url})并按指引完成配置。`, expiresAt: absoluteExpiry(result.expiresAt),
        refreshQuery: "重新配置飞书应用", confirmQuery: null };
    }
    const authorization = result as Partial<Extract<FeishuStartResult, { mode: "authorization" }>>;
    const url = requireString(authorization.verification_url, "verification_url");
    return { presentation, imageDataUri: null, connectorId: id, pendingId: requireString(result.pendingId, "pendingId"), title: "扫码授权飞书", content: url,
      code: requireString(authorization.user_code, "user_code"), note: `用飞书 App 扫码，或[点此在浏览器授权](${url})并输入配对码。`, expiresAt: absoluteExpiry(result.expiresAt),
      refreshQuery: "重新授权飞书", confirmQuery: null };
  }
  const result = value as Partial<WechatStartResult>;
  if (typeof result.expiresInSec !== "number" || !Number.isFinite(result.expiresInSec) || result.expiresInSec <= 0) throw new Error("授权响应 expiresInSec 非法");
  return { presentation, connectorId: id, pendingId: requireString(result.pendingId, "pendingId"), title: "扫码登录微信公众平台", content: "", imageDataUri: requireString(result.imageDataUri, "imageDataUri"),
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
  checking: "检查中",
  unconfigured: "未配置",
  disconnected: "未连接",
  pending: "等待授权",
  connected: "已连接",
  needs_reauth: "需重新授权",
};

// 详情页开场白:一段话说清这个连接给青简带来什么、怎么用。
// 技能依赖与非官方接口的风险都融在这段里,不再单列「被谁使用」/警示区块。
const DESCRIPTIONS: Record<ConnectorId, string> = {
  github: "GitHub 是全球最大的代码与文档托管平台。连接你的 GitHub 账号后，青简可以搜索并读取你名下和有权访问的仓库——代码、README、技术文档都能作为写作素材直接取用（由技能「GitHub 读取」调用）。公开仓库无需连接也能读取。",
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
    checking: "正在检查 GitHub 连接",
    unconfigured: "尚未配置 GitHub OAuth App",
    disconnected: "连接后可搜索和读取账号可见仓库",
    pending: "授权验证进行中，请在发起处的授权卡完成",
    connected: "已可读取授权范围内的 GitHub 仓库",
    needs_reauth: "GitHub 授权已失效，请重新连接",
  },
  feishu: {
    unavailable: "当前环境无法使用飞书连接",
    checking: "正在检查飞书连接，稍后会自动更新",
    unconfigured: "尚未配置飞书应用",
    disconnected: "应用已配置，授权后可代你操作飞书",
    pending: "扫码验证进行中，请在发起处的授权卡完成",
    connected: "飞书应用已配置并完成授权",
    needs_reauth: "授权已失效，重新扫码即可恢复",
  },
  "wechat-mp": {
    unavailable: "当前环境无法使用公众号连接",
    checking: "正在检查公众号连接",
    unconfigured: "尚未登录微信公众平台",
    disconnected: "贴文章链接无需登录；按公众号名搜索才需扫码",
    pending: "扫码验证进行中，请在发起处的授权卡完成",
    connected: "登录态在本地最多保留约 80 小时，微信可能提前要求重新登录",
    needs_reauth: "微信可能提前要求重新登录，重新扫码即可恢复",
  },
};

// 品牌图标:官方 mark 的单色剪影(GitHub/微信取自 simple-icons 官方 path,
// 飞书取自字节 IconPark 的 lark),fill=currentColor 跟随金调,不引品牌原色。
const ICONS: Record<ConnectorId, { viewBox: string; d: string }> = {
  github: {
    viewBox: "0 0 24 24",
    d: "M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12",
  },
  feishu: {
    viewBox: "0 0 48 48",
    d: "M41.0716 5.99409L3.31071 16.5187L12.3856 25.8126L20.7998 25.9594L30.4827 16.5187C30.2266 15.9943 30.0985 15.5552 30.0985 15.2013C30.0985 14.4074 30.4104 13.7786 30.8947 13.333C31.7241 12.57 32.7222 12.4558 33.8889 12.9905L41.0716 5.99409ZM42.1021 6.72842L31.5775 44.4893L22.2836 35.4144L22.1367 27.0002L31.5115 17.4816C32.0195 17.8454 32.5743 18.0105 33.1759 17.9769C34.0784 17.9264 34.6614 17.3813 34.9349 17.0602C35.2083 16.7392 35.5293 16.2051 35.5025 15.4113C35.4847 14.8821 35.3109 14.3941 34.9812 13.9472L42.1021 6.72842Z",
  },
  "wechat-mp": {
    viewBox: "0 0 24 24",
    d: "M8.691 2.188C3.891 2.188 0 5.476 0 9.53c0 2.212 1.17 4.203 3.002 5.55a.59.59 0 0 1 .213.665l-.39 1.48c-.019.07-.048.141-.048.213 0 .163.13.295.29.295a.326.326 0 0 0 .167-.054l1.903-1.114a.864.864 0 0 1 .717-.098 10.16 10.16 0 0 0 2.837.403c.276 0 .543-.027.811-.05-.857-2.578.157-4.972 1.932-6.446 1.703-1.415 3.882-1.98 5.853-1.838-.576-3.583-4.196-6.348-8.596-6.348zM5.785 5.991c.642 0 1.162.529 1.162 1.18a1.17 1.17 0 0 1-1.162 1.178A1.17 1.17 0 0 1 4.623 7.17c0-.651.52-1.18 1.162-1.18zm5.813 0c.642 0 1.162.529 1.162 1.18a1.17 1.17 0 0 1-1.162 1.178 1.17 1.17 0 0 1-1.162-1.178c0-.651.52-1.18 1.162-1.18zm5.34 2.867c-1.797-.052-3.746.512-5.28 1.786-1.72 1.428-2.687 3.72-1.78 6.22.942 2.453 3.666 4.229 6.884 4.229.826 0 1.622-.12 2.361-.336a.722.722 0 0 1 .598.082l1.584.926a.272.272 0 0 0 .14.047c.134 0 .24-.111.24-.247 0-.06-.023-.12-.038-.177l-.327-1.233a.582.582 0 0 1-.023-.156.49.49 0 0 1 .201-.398C23.024 18.48 24 16.82 24 14.98c0-3.21-2.931-5.837-6.656-6.088V8.89c-.135-.01-.27-.027-.407-.03zm-2.53 3.274c.535 0 .969.44.969.982a.976.976 0 0 1-.969.983.976.976 0 0 1-.969-.983c0-.542.434-.982.97-.982zm4.844 0c.535 0 .969.44.969.982a.976.976 0 0 1-.969.983.976.976 0 0 1-.969-.983c0-.542.434-.982.969-.982z",
  },
};

function ConnectorIcon({ connector }: { connector: ConnectorInfo }) {
  const icon = ICONS[connector.id];
  return (
    <span className={`cn-icon cn-icon--${connector.icon}`} aria-hidden="true">
      <svg viewBox={icon.viewBox} fill="currentColor">
        <path d={icon.d} fillRule="evenodd" clipRule="evenodd" />
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

const FEISHU_TRANSIENT_REASON_CODES = new Set([
  "LARK_CLI_VERSION_TIMEOUT",
  "LARK_CLI_TIMEOUT",
  "LARK_CLI_OUTPUT_LIMIT",
  "LARK_CLI_DIRTY_OUTPUT",
  "LARK_CLI_FAILED",
]);

/** 兼容仍把瞬时 CLI 故障返回 unavailable 的旧服务端，列表和详情统一呈现为检查中。 */
function presentationState(connector: ConnectorInfo): ConnectorState {
  if (
    connector.id === "feishu" &&
    connector.status.state === "unavailable" &&
    connector.status.reasonCode &&
    FEISHU_TRANSIENT_REASON_CODES.has(connector.status.reasonCode)
  ) {
    return "checking";
  }
  return connector.status.state;
}

function listSubtitle(connector: ConnectorInfo, state = connector.status.state): string {
  if (state !== connector.status.state) return STATE_COPY[connector.id][state] ?? STATUS_LABELS[state];
  const line = connectedLine(connector);
  if (line) return line;
  return STATE_COPY[connector.id][state] ?? STATUS_LABELS[state];
}

// 详情页状态行:开场白已介绍用途,这里只讲「当前是什么状态」。
// 未连接/未配置时返回 null(徽标已表达,不再重复一句废话)。
function detailStatus(
  connector: ConnectorInfo,
  state: ConnectorState = presentationState(connector),
): string | null {
  if (connector.id === "github" && connector.status.reasonCode === "ACCOUNT_CHANGE_CONFIRMATION_REQUIRED") {
    return "检测到授权账号发生变化。为避免误切账号，当前连接未被替换；请先断开，再明确连接新账号。";
  }
  if (connector.id === "github" && connector.status.reasonCode === "INSUFFICIENT_SCOPE") {
    return "当前授权范围不足，重新授权即可扩展；失败不会影响现有连接。";
  }
  if (connector.id === "feishu" && state === "checking") {
    return STATE_COPY.feishu.checking!;
  }
  if (connector.id === "feishu" && state === "unavailable") {
    const copy: Record<string, string> = {
      LARK_CLI_MISSING: "未找到飞书连接组件。当前安装包可能未包含该组件，请重新安装完整桌面客户端。",
      LARK_CLI_SPAWN_FAILED: "飞书连接组件未能启动。请重启客户端；若仍未恢复，请重新安装完整桌面客户端。",
      LARK_CLI_VERSION_UNSUPPORTED: "飞书连接组件版本暂不兼容。请更新桌面客户端。",
    };
    return connector.status.reasonCode
      ? copy[connector.status.reasonCode] ?? STATE_COPY.feishu.unavailable!
      : STATE_COPY.feishu.unavailable!;
  }
  // 已连接的账号句放在页面底部断开区,这里不重复;未连接/未配置由徽标表达,同样不占一行。
  if (["connected", "disconnected", "unconfigured"].includes(connector.status.state)) return null;
  return STATE_COPY[connector.id][state] ?? STATUS_LABELS[state];
}

export interface ConnectionsPanelProps {
  selectedId?: ConnectorId | null;
  onSelectedIdChange?: (id: ConnectorId | null) => void;
}

export function ConnectionsPanel({ selectedId: controlledId, onSelectedIdChange }: ConnectionsPanelProps) {
  const capabilities = useClientCapabilities();
  const {
    connectors,
    pendingSessions,
    loading,
    error,
    refresh,
    start,
    cancel,
    probe,
    disconnect,
  } = useConnectors();
  const toast = useToast();
  const confirm = useConfirm();
  // 未提供回调时把 selectedId 当作初始值，避免半受控调用导致返回按钮失效。
  const [localId, setLocalId] = useState<ConnectorId | null>(controlledId ?? null);
  const [busy, setBusy] = useState(false);
  const authCancelRef = useRef<HTMLDivElement>(null);
  const selectedId = onSelectedIdChange ? controlledId ?? null : localId;
  const selected = selectedId ? connectors.find((item) => item.id === selectedId) ?? null : null;
  const selectedAuthSession = selected ? pendingSessions[selected.id] ?? null : null;
  const selectedAuthCard = selectedAuthSession?.card ?? null;
  const select = (id: ConnectorId | null) => {
    setLocalId(id);
    onSelectedIdChange?.(id);
  };

  useEffect(() => {
    if (!selectedAuthSession?.pendingId) return;
    authCancelRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [selectedAuthSession?.pendingId]);

  if (capabilities?.connectors?.mutationEnabled === false) {
    return (
      <div className="cn-unavailable" data-wf="ConnectionsUnavailable">
        <div className="cn-unavailable-title">此环境不可用</div>
        <p>连接器仅在桌面客户端或显式启用的单用户服务中开放。</p>
      </div>
    );
  }

  const cancelAuthorization = async (session: ConnectorAuthSession) => {
    setBusy(true);
    try {
      await cancel(session.connectorId, session.pendingId);
      toast.show({ message: "已取消本次授权", tone: "success" });
    } catch (cause) {
      toast.show({
        message: cause instanceof Error ? cause.message : "取消授权失败",
        tone: "error",
      });
    } finally {
      setBusy(false);
    }
  };

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
    const canProbe = selected.status.canProbe && !canStart;
    const canDisconnect = ["connected", "needs_reauth"].includes(selected.status.state);
    const visibleState: ConnectorState = selectedAuthCard ? "pending" : presentationState(selected);
    const initiate = async () => {
      setBusy(true);
      try {
        // GitHub 一律请求 repo(含私有仓):对用户就是「授权/没授权」,不区分公私仓档位。
        // 飞书设置页没有具体任务意图，默认请求连接器当前支持的完整域集，保证 start 非空。
        const body = selected.id === "github"
          ? { scope: "repo" }
          : selected.id === "feishu"
            ? { domains: [...DEFAULT_FEISHU_AUTH_DOMAINS] }
            : {};
        const result = await start(selected.id, body);
        const startedAt = Date.now();
        const card = mapConnectorStart(
          selected.id,
          selected.authPresentation,
          result,
          startedAt,
        );
        saveConnectorAuthSession({
          connectorId: selected.id,
          pendingId: card.pendingId,
          startedAt,
          card,
        });
      } catch (cause) {
        toast.show({ message: cause instanceof Error ? cause.message : "发起授权失败", tone: "error" });
        throw cause;
      } finally { setBusy(false); }
    };
    const disconnectConnector = async () => {
      setBusy(true);
      try {
        const proceed = await confirm({
          title: `断开「${selected.name}」连接？`,
          message: `断开后需重新授权连接，青简才能再次访问${selected.name}。`,
          confirmLabel: selected.id === "wechat-mp" ? "退出登录" : "断开连接",
        });
        if (!proceed) return;
        await disconnect(selected.id);
        toast.show({ message: "已断开连接", tone: "success" });
      } catch (cause) {
        toast.show({ message: cause instanceof Error ? cause.message : "断开失败", tone: "error" });
      } finally {
        setBusy(false);
      }
    };
    return (
      <div className="cn-detail" data-wf="ConnectionDetail" data-connector-id={selected.id}>
        <div className="sk-subhead">
          <button type="button" className="sk-back" onClick={() => select(null)}>
            <span className="sk-back-arrow" aria-hidden="true"><CaretIcon size={14} direction="left" /></span>返回连接
          </button>
          <span className="sk-subtitle">连接详情</span>
        </div>
        <div className="cnd-hero">
          <ConnectorIcon connector={selected} />
          <span className="cnd-name">{selected.name}</span>
          <Badge state={visibleState} connectorId={selected.id} />
        </div>
        <p className="cnd-desc">{DESCRIPTIONS[selected.id]}</p>
        {(selectedAuthCard || detailStatus(selected, visibleState)) && (
          <p className="cnd-status">{selectedAuthCard ? "请在下方授权卡完成操作，页面会自动更新连接状态。" : detailStatus(selected, visibleState)}</p>
        )}
        {selectedAuthCard ? (
          <>
            <div className="cnd-authcard"><AuthCard
              data={selectedAuthCard}
              onRefresh={initiate}
              onStatusChange={() => {
                void refresh().catch(() => undefined);
              }}
            /></div>
            <div ref={authCancelRef} className="cnd-cancel">
              <button
                type="button"
                className="sm-btn"
                disabled={busy}
                onClick={() => {
                  if (selectedAuthSession) void cancelAuthorization(selectedAuthSession);
                }}
              >
                {busy ? "取消中…" : "取消本次授权"}
              </button>
            </div>
          </>
        ) : (canStart || canProbe) ? (
          <div className="cnd-action">
            {canStart && (
              <button type="button" className="sm-btn big primary" disabled={busy} onClick={() => { void initiate().catch(() => undefined); }}>
                {busy ? "发起中…" : startLabel(selected)}
              </button>
            )}
            {busy && selected.id === "wechat-mp" && (
              <span className="cnd-wait">正在打开公众平台生成登录二维码，通常需要 5~15 秒…</span>
            )}
            {canProbe && (
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
            <span>{connectedLine(selected) ? `${connectedLine(selected)}。` : ""}{
              selected.id === "github"
                ? "断开后青简不再能访问你的仓库；GitHub 那边的授权记录可在 github.com 的 Settings → Applications 里移除。"
                : selected.id === "feishu"
                  ? "断开后青简不再能操作你的飞书；也可以在飞书客户端「设置 → 安全 → 登录设备与授权」里撤销。"
                  : "退出后青简不再能搜索和抓取公众号文章；这只是退出本机登录，对你的公众号没有任何影响。"
            }</span>
            <button type="button" className="sk-btn-danger" disabled={busy} onClick={() => {
              void disconnectConnector();
            }}>{selected.id === "wechat-mp" ? "退出登录" : "断开连接"}</button>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="settings-connections" data-wf="ConnectionsPanel">
      <p className="sm-note" style={{ marginTop: 0 }}>管理青简以你的身份访问的外部服务。可在详情页主动连接，也可在对话里按需发起。</p>
      {loading && connectors.length === 0 && (
        <div className="cn-skeleton" role="status" aria-label="正在加载连接">
          {[0, 1, 2].map((index) => (
            <div className="cn-skeleton-row" key={index} aria-hidden="true">
              <span className="cn-skeleton-icon" />
              <span className="cn-skeleton-copy">
                <span className="cn-skeleton-line cn-skeleton-line--title" />
                <span className="cn-skeleton-line" />
              </span>
            </div>
          ))}
        </div>
      )}
      {error && <p className="sm-message">{error}</p>}
      <div className="cn-list">
        {connectors.map((connector) => {
          const pendingSession = pendingSessions[connector.id];
          const visibleState: ConnectorState = pendingSession ? "pending" : presentationState(connector);
          return (
            <div className="cn-row-wrap" key={connector.id}>
              <button type="button" className="cn-row" onClick={() => select(connector.id)}>
                <ConnectorIcon connector={connector} />
                <span className="cn-titleblock">
                  <span className="cn-titleline">
                    <span className="cn-name">{connector.name}</span>
                    <Badge state={visibleState} connectorId={connector.id} />
                  </span>
                  <span className="cn-sub">{listSubtitle(connector, visibleState)}</span>
                </span>
                <span className="cn-caret" aria-hidden="true"><CaretIcon size={15} direction="right" /></span>
              </button>
              {pendingSession && (
                <button
                  type="button"
                  className="cn-row-cancel"
                  disabled={busy}
                  onClick={() => void cancelAuthorization(pendingSession)}
                >
                  取消授权
                </button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
