import { useEffect, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import type {
  CommandCardBody,
  GenerateSvgCardBody,
  ResearchCardBody,
  ToolCallResult,
  ToolCallSpec,
} from "@qingagent/contract-ts";
import { ASK_USER_RESTORE_INTERRUPTED_MESSAGE } from "@qingagent/contract-ts";
import { MediaZoomFullscreen } from "./MediaZoomFullscreen";
import "./chatUnified.css";

// ════════════════════════════════════════════════════════════════════════
// 对话工具元素 · 统一组件框架(生产)
//   一套 token(.u-scope) + 两个基元(UToolBar 一行 / UCard 头+body),各工具二次定制。
//   规则内建:状态图标(黄点/loading/对勾) · loading 两态(长转圈/短点点) · 状态文案 ·
//   可展开必有箭头 · 运行展开结束折叠 · 图片呼吸灯 · 中文映射 · 字数 K 单位。
// ════════════════════════════════════════════════════════════════════════

// —— 统一自设线性图标 ——
const ICO = {
  check: "M4 8.5l3 3 5-6.5",
  cancel: "M4 4l8 8 M12 4l-8 8",
  stop: "M4 4h8v8H4z",
  search: "M7 7m-4 0a4 4 0 108 0 4 4 0 10-8 0 M11 11l3.5 3.5",
  image: "M2.5 3.5h11v9h-11z M2.5 10l3-3 2.5 2.5 3-3.5 2.5 3",
  cmd: "M3 4l3 3-3 3 M8 11h5",
  qr: "M2.5 2.5h4v4h-4z M9.5 2.5h4v4h-4z M2.5 9.5h4v4h-4z M9.5 9.5v2 M11.5 9.5v4 M13.5 11.5v2",
};
// 完成态按 body.kind 定制图标(默认对勾;二维码用二维码图标等)。
const DONE_ICON_BY_KIND: Record<string, string> = { qrCard: ICO.qr };
function UIcon({ d, size }: { d: string; size?: number }) {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" width={size} height={size} aria-hidden="true">
      {d.split(" M").map((seg, i) => <path key={i} d={i === 0 ? seg : "M" + seg} />)}
    </svg>
  );
}
const Spin = () => <span className="u-spin" aria-hidden="true" />;
const Dots = () => <span className="u-dots"><span /><span /><span /></span>;
const Chevron = ({ open }: { open: boolean }) => (
  <span className={open ? "u-card-chev is-open" : "u-card-chev"}><UIcon d="M4 6.5l4 4 4-4" size={16} /></span>
);
// 倒计时参数:从 timeout 秒往下数,提示「N 秒后发起检查」,到点显示「正在检查…」。
// 给"读取运行输出"这类阻塞等待的工具一个明确预期,不再像卡死。
function Countdown({ seconds }: { seconds: number }) {
  const [left, setLeft] = useState(seconds);
  useEffect(() => {
    setLeft(seconds);
    const id = setInterval(() => setLeft((v) => (v > 1 ? v - 1 : 0)), 1000);
    return () => clearInterval(id);
  }, [seconds]);
  return <>{left > 0 ? `${left} 秒后发起检查` : "正在检查…"}</>;
}

const OUTPUT_ACTIVITY_VISIBLE_MS = 5_000;

function outputActivityAt(result: ToolCallResult | null): number | null {
  const parsed = parseGenericResultObject(result);
  const value = parsed?.outputActivityAt;
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** 等待态只做稳定的秒数更新；stdout 活动提示保留 5 秒，不做闪烁动画。 */
function ProcessWaitMeta({ activityAt }: { activityAt: number | null }) {
  const startedAtRef = useRef(Date.now());
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(id);
  }, []);
  const elapsedSec = Math.max(0, Math.floor((now - startedAtRef.current) / 1_000));
  const hasRecentOutput =
    activityAt !== null && now >= activityAt && now - activityAt < OUTPUT_ACTIVITY_VISIBLE_MS;
  return <>{hasRecentOutput ? "仍在输出" : "等待输出"} · 已等待 {elapsedSec} 秒</>;
}

// —— 工具中文名(= 生产显示名 + renames + 原未映射 3 个) ——
export const TOOL_LABELS: Record<string, string> = {
  parseFile: "解析文件", storeMaterial: "存储素材", summarizeMaterial: "更新素材", readMaterial: "读取素材",
  readDraft: "读取草稿", editDraft: "修改草稿", readDiff: "核对修改",
  webSearch: "联网搜索", fetchArticle: "网页抓取",
  skill: "使用技能", skill_read: "读取技能", skill_search: "搜索技能",
  browser_goto: "打开网页", browser_snapshot: "网页浏览", browser_click: "网页点击",
  browser_type: "网页输入", browser_press: "按键", browser_wait: "等待", browser_scroll: "滚动", browser_back: "返回",
  browser_close: "关闭浏览器", browser_hover: "悬停", browser_select: "选择", browser_dialog: "处理弹窗",
  // Mastra Workspace 沙箱工具(全集,审计自 @mastra/core/workspace 的 WORKSPACE_TOOLS,
  // 经 bridge 加 mastra_workspace_ 前缀):read_file/write_file/edit_file/list_files/
  // grep/search/search_output/execute_command/get_process_output/kill_process。下面逐一映射,别漏。
  mastra_workspace_read_file: "读取文件", mastra_workspace_write_file: "写入文件",
  mastra_workspace_edit_file: "编辑文件", mastra_workspace_list_files: "列出文件",
  mastra_workspace_grep: "搜索文件", mastra_workspace_search: "搜索工作区",
  mastra_workspace_search_output: "搜索文件", mastra_workspace_execute_command: "运行命令",
  mastra_workspace_get_process_output: "读取运行输出", mastra_workspace_kill_process: "结束进程",
  readDocument: "读取文件", searchDocuments: "搜索文件",
  run_js: "运行代码", run_python: "运行代码", readImage: "识别图片",
  // tool-call-input-streaming-start 占位期 generic body 只能靠真实工具名取显示名。
  writeDraft: "生成草稿", generateSvg: "生成配图", prepareImageEditSource: "准备图片源图", editSvgWithCodexFallback: "定点修改 SVG", importGeneratedImage: "导入图片产物", larkConfigInit: "配置飞书",
  show_qr: "生成二维码",
  // askUser 仅为老会话持久化兼容保留，待老会话数据迁移或过期后删除。
  askUser: "确认方向", planDraft: "确认方向", askUserQuestion: "有问题待确认",
  // 微信公众号 skill:auth_start 的 running(生成中)态是 generic body，显式补上映射。
  wechat_auth_status: "检查微信登录状态", wechat_auth_start: "生成二维码",
  wechat_search_mp: "搜索公众号", wechat_list_articles: "列出文章",
  github_list_repos: "列出 GitHub 仓库", github_repo_tree: "读取 GitHub 文件树",
  github_read_file: "读取 GitHub 文件",
  github_search_code: "搜索 GitHub 代码",
  github_auth_start: "连接 GitHub",
  feishu_auth_start: "连接飞书",
  lexicon_list: "查看敏感词词库", sensitive_scan: "敏感词扫描", lexicon_manage: "管理敏感词词库",
  derivative_brief: "读取稿件任务", generate_derivative: "生成稿件",
  create_annotation_groups: "生成批注",
  list_derivatives: "列出稿件", update_derivative_params: "更新稿件设置",
  style_template_list: "列出风格模板", style_template_get: "读取风格模板",
  style_template_save: "保存风格模板", style_template_delete: "删除风格模板",
};

// 已报过的未映射工具名(去重,防止 render 反复刷屏)。
const anonToolReported = new Set<string>();
// 未映射工具会回退为通用操作，仍属 TOOL_LABELS 配置遗漏。首次遇到即 console.error 报警，
// 便于开发在控制台一眼揪出并回补中文名(用户诉求:一旦出现匿名工具就报错,后续去修)。
function reportAnonTool(name: string, spec: ToolCallSpec): void {
  if (anonToolReported.has(name)) return;
  anonToolReported.add(name);
  console.error(
    `[anon-tool] 工具「${name}」未在 TOOL_LABELS 映射，前端已回退为通用操作。请在 chatUnified.tsx 的 TOOL_LABELS 补中文名。`,
    { toolName: name, bodyKind: spec.body.kind },
  );
}

function bodyKindLabel(spec: ToolCallSpec): string {
  // questionnaire 共用 body.kind="askUser"，必须先按真实工具名分派，避免通用提问误显「确认方向」。
  if (spec.name === "askUserQuestion") return "有问题待确认";
  if (spec.name === "planDraft" || spec.name === "askUser") return "确认方向";
  // 旧契约残留 body.kind(0-emit)兜底,避免裸 name
  switch (spec.body.kind) {
    case "spawnSubAgent": return `子任务 · ${spec.body.data.name}`;
    case "extractFile": return "解析文件";
    case "extractImage": return "识别图片";
    case "webFetch": return "获取网页";
    case "browserOpen": return "打开浏览器";
    case "browserAct": return "浏览器操作";
    case "qrCard": return "生成二维码"; // 简单条;真正的二维码后置到最终回复后(产出物后置)
    case "askUser": return "确认方向"; // 未识别工具名的老快照兜底；通道 discriminator 不改名
    default:
      if (TOOL_LABELS[spec.name]) return TOOL_LABELS[spec.name]!;
      // 兜底:任何未显式映射的 Mastra 沙箱工具,也不暴露英文名/"工具调用·<pid>"。
      if (spec.name.startsWith("mastra_workspace_")) return "工作区操作";
      // 兜底:任何未显式映射的 browser_* 工具,统一成"浏览器操作",不裸"工具调用"。
      if (spec.name.startsWith("browser_")) return "浏览器操作";
      reportAnonTool(spec.name, spec);
      return "执行操作";
  }
}

// loading 两态:较久任务转圈,较快任务点点。
const LONG_RUNNING = new Set([
  "generateSvg", "editSvgWithCodexFallback", "readImage", "webSearch", "run_js", "run_python",
  "fetchArticle", "parseFile",
  "mastra_workspace_get_process_output", "mastra_workspace_execute_command",
]);

// 技能 id → 展示名(skill/skill_read 的参数是技能 id)。真实聊天渲染从 /api/v1/skills 的 label 透传。
const SKILL_TOOL_NAMES = new Set(["skill", "skill_read"]);
export type SkillLabelMap = Readonly<Record<string, string>>;
const EMPTY_SKILL_LABELS: SkillLabelMap = {};

// 已存素材的 materialId → 展示名。storeMaterial 的参数不是已存素材 id，不参与替换。
const MATERIAL_TOOL_NAMES = new Set(["readMaterial", "summarizeMaterial"]);
export type MaterialLabelMap = Readonly<Record<string, string>>;
const EMPTY_MATERIAL_LABELS: MaterialLabelMap = {};

// 注意:不含 "pid" —— 进程号对用户无意义,不该当作主参数显示成"读取运行输出 · 1166276"。
const PARAM_PRIORITY = ["filePath", "path", "file", "filename", "url", "query", "pattern", "selector", "key", "direction", "dir", "name", "skill", "materialId", "mode", "text"];
const host = (u: string) => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return u; } };
const base = (p: string) => p.split(/[/\\]/).pop() || p;
const clip = (s: string, m = 22) => (s.length <= m ? s : `${s.slice(0, Math.floor(m / 2))}…${s.slice(-Math.floor(m / 2))}`);

function pickMainParam(args: Record<string, unknown>): string | null {
  for (const k of PARAM_PRIORITY) {
    const raw = args[k];
    if (raw == null || String(raw) === "") continue;
    let v = String(raw);
    if (k === "url") v = host(v);
    else if (["filePath", "path", "file", "filename"].includes(k)) v = base(v);
    else if (k === "mode") v = ({ summary: "摘要", full: "全文", range: "局部", outline: "大纲" } as Record<string, string>)[v] ?? v;
    else if (k === "direction") v = ({ down: "向下", up: "向上", left: "向左", right: "向右" } as Record<string, string>)[v] ?? v;
    return clip(v);
  }
  return null;
}
function pickSkillParam(args: Record<string, unknown>): string | null {
  for (const k of ["skill", "name", "id"]) {
    const raw = args[k];
    if (typeof raw === "string" && raw.trim()) return raw.trim();
  }
  const firstString = Object.values(args).find((v): v is string => typeof v === "string" && v.trim().length > 0);
  return firstString ? firstString.trim() : null;
}

function parseGenericResultObject(result: ToolCallResult | null): Record<string, unknown> | null {
  if (!result || result.kind !== "genericText") return null;
  try {
    const parsed = JSON.parse(result.data);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function boolField(o: Record<string, unknown>, key: string): boolean | null {
  return typeof o[key] === "boolean" ? (o[key] as boolean) : null;
}

function isToolResultFailure(result: ToolCallResult | null, toolName?: string): boolean {
  const o = parseGenericResultObject(result);
  if (!o) return false;
  switch (toolName) {
    case "readImage":
    case "run_js":
    case "run_python":
      return boolField(o, "ok") === false;
    default:
      return false;
  }
}

// 工具完成态右侧状态文案:把后端 toolResultCardSummary 产出的紧凑 JSON
// (顶层标量 + 数组长度 `<key>Count` + 下钻一层的 `<父>.<子>` 标量)按工具语义提炼成
// 有信息量的中文。取不到才回退 null(由调用方显示"已完成")。
// 注意:解析的是紧凑对象 —— 数组类字段名是 `xxxCount`,嵌套字段名是 `父.子`。
function pickOutputSummary(result: ToolCallResult | null, toolName?: string): string | null {
  const o = parseGenericResultObject(result);
  if (!o) return null;
  const num = (k: string) => (typeof o[k] === "number" ? (o[k] as number) : null);
  const bool = (k: string) => boolField(o, k);
  const arr = (k: string) => (Array.isArray(o[k]) ? (o[k] as unknown[]).length : null);
  // 数组类紧凑后是 `<key>Count`,这里两种都认。
  const cnt = (k: string) => num(`${k}Count`) ?? arr(k);
  const fmtN = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1).replace(/\.0$/, "")}K` : String(n));
  const words = () => {
    const w = num("wordCount") ?? num("metadata.wordCount") ?? num("chars");
    return w != null ? `${fmtN(w)} 字` : null;
  };

  // —— 逐工具语义提炼 ——
  switch (toolName) {
    case "editDraft": {
      // 输出含 applied[](→appliedCount) / changed / hunkCount。改了几处优先报 hunk 数。
      const hunks = num("hunkCount");
      if (hunks != null && hunks > 0) return `改 ${hunks} 处`;
      const applied = cnt("applied");
      if (applied != null && applied > 0) return `改 ${applied} 处`;
      if (bool("changed") === false) return "未改动";
      if (bool("ok") === false) return "修改失败";
      return null;
    }
    case "readDiff": {
      // stats 嵌套被提成 stats.blocksChanged / stats.marksChanged / stats.totalWords 等。
      const blocks = num("stats.blocksChanged");
      const marks = num("stats.marksChanged");
      const total = (blocks ?? 0) + (marks ?? 0);
      const fallback = cnt("changes");
      const diffs = blocks != null || marks != null ? total : fallback;
      if (diffs != null) return diffs > 0 ? `${diffs} 处差异` : "无差异";
      return null;
    }
    case "readDraft":
      return words() ?? (num("blockCount") != null ? `${num("blockCount")} 块` : null);
    case "webSearch": {
      const n = cnt("items");
      return n != null ? `${n} 条` : null;
    }
    case "github_search_code": {
      if (bool("selected") === true) return "已选片段";
      const n = num("count") ?? cnt("hits");
      return n != null ? `命中 ${n} 条` : null;
    }
    case "searchDocuments": {
      const n = cnt("results");
      return n != null ? `${n} 条` : null;
    }
    case "parseFile":
    case "readMaterial":
    case "readDocument":
    case "fetchArticle":
      return words();
    case "storeMaterial":
      return bool("stored") === false ? "未存储" : "已存素材";
    case "summarizeMaterial":
      return bool("updated") === false ? "未更新" : "已更新";
    case "readImage":
      return bool("ok") === false ? "需配置视觉模型" : "已识别";
    case "run_js":
    case "run_python":
      return bool("ok") === false ? "运行失败" : "运行成功";
    default:
      break;
  }

  // —— 通用回退:按字段名猜(覆盖未单列的工具) ——
  const w = words();
  if (w != null) return w;
  const results = cnt("results");
  if (results != null) return `${results} 条`;
  const changed = num("hunkCount") ?? num("changed");
  if (changed != null && changed > 0) return `改 ${changed} 处`;
  if (num("matches") != null) return `${num("matches")} 处`;
  const items = cnt("items");
  if (items != null) return `${items} 项`;
  if (num("count") != null) return `${num("count")} 处`;
  return null;
}
function parseArgs(spec: ToolCallSpec): Record<string, unknown> {
  if (spec.body.kind !== "generic") return {};
  try {
    const p = JSON.parse(spec.body.data.argsJson);
    return p && typeof p === "object" && !Array.isArray(p) ? (p as Record<string, unknown>) : {};
  } catch { return {}; }
}

// ═══════════ 基元 1:统一工具条(一行,不可展开) ═══════════
export function UToolBar({
  spec,
  skillLabels = EMPTY_SKILL_LABELS,
  materialLabels = EMPTY_MATERIAL_LABELS,
}: {
  spec: ToolCallSpec;
  skillLabels?: SkillLabelMap;
  materialLabels?: MaterialLabelMap;
}) {
  const k = spec.status.kind;
  const pending = k === "pending";
  const running = k === "running";
  const failed = k === "failed";
  const abortedStatus = k === "aborted";
  const label = bodyKindLabel(spec);
  // 只针对「流式还没输出完」的占位态:刚建占位卡(generic body 且参数 JSON 还没到,argsJson 为空)。
  // 参数到位/工具执行中/完成/失败 一律不改,仍走下面原有的条/卡。
  // 例外:确认命令批准后的执行期,后端把工具卡换成 running commandCard;若时序上仍是空 generic,
  // 也不能误显「正在准备」(慢命令会看似卡死),排除 execute_command 走下面的运行中卡/条。
  const isStreamingPlaceholder =
    running && spec.body.kind === "generic" && (spec.body.data.argsJson ?? "") === "" &&
    spec.name !== "mastra_workspace_execute_command";
  if (isStreamingPlaceholder) {
    return (
      <div className="u-prep" data-wf="ToolPrep">
        <span className="chat-loading-dots" aria-hidden="true">
          <span />
          <span />
          <span />
        </span>
        <span className="u-prep-text">
          {spec.name === "writeDraft" ? "酝酿中…" : <>正在准备<b>{label}</b></>}
        </span>
      </div>
    );
  }
  const args = parseArgs(spec);
  let main = SKILL_TOOL_NAMES.has(spec.name) ? pickSkillParam(args) : pickMainParam(args);
  if (main && SKILL_TOOL_NAMES.has(spec.name)) main = clip(skillLabels[main] ?? main);
  const rawMaterialId = args.materialId == null ? null : String(args.materialId);
  if (main && rawMaterialId && MATERIAL_TOOL_NAMES.has(spec.name)) {
    main = clip(materialLabels[rawMaterialId] ?? main);
  }
  const customOut = !pending && !running && !failed ? pickOutputSummary(spec.result, spec.name) : null;
  const semanticFailed =
    !pending && !running && !failed && !abortedStatus &&
    isToolResultFailure(spec.result, spec.name);
  // 读取后台进程输出 = 有界等待:左侧保留本次检查倒计时，右侧持续显示已等待时长；
  // stdout/stderr 流动时短暂切成「仍在输出」，不使用闪烁动画。
  const isProcOutTool = spec.name === "mastra_workspace_get_process_output";
  const isProcOut = running && isProcOutTool;
  const aborted =
    abortedStatus ||
    (spec.body.kind === "generic" && spec.body.data.terminalKind === "aborted");
  const userCancelledAskUser =
    spec.body.kind === "askUser" &&
    spec.status.kind === "aborted" &&
    spec.status.data?.reason === "user_cancelled";
  const procOutSecs = (() => {
    if (!isProcOut) return null;
    const t = parseArgs(spec).timeout;
    return typeof t === "number" && t > 0 ? Math.round(t / 1000) : null;
  })();
  // AGENTS.md UI Iron Rule:工具失败/中止一律中性灰短文案；协议 reason 只供日志与
  // agent 诊断，绝不进入正文、title 或 aria 文本，避免英文原始错误和内部路径泄露。
  const waitReturnedWhileRunning =
    isProcOutTool &&
    spec.result?.kind === "genericText" &&
    (
      boolField(parseGenericResultObject(spec.result) ?? {}, "processStillRunning") === true ||
      (spec.result.data.includes("进程仍在运行") && spec.result.data.includes("未退出"))
    );
  const runningText = isProcOut
    ? <ProcessWaitMeta activityAt={outputActivityAt(spec.result)} />
    : "处理中";
  // 原则:工具只要返回了结果,通用对话行就按完成收口;工具内部失败由 agent 感知并在正文里沟通。
  // 这里的 failed 只渲染后端明确给出的未执行/异常状态,不把 "[Error]" 文本再高亮成失败。
  const restoreInterrupted =
    spec.result?.kind === "genericText" &&
    spec.result.data === ASK_USER_RESTORE_INTERRUPTED_MESSAGE;
  const statusText = restoreInterrupted
    ? ASK_USER_RESTORE_INTERRUPTED_MESSAGE
    : aborted
      ? "已中止"
      : pending
        ? "等待中"
        : running
          ? runningText
          : failed || semanticFailed
            ? "未完成"
            : isProcOutTool
              ? waitReturnedWhileRunning
                ? "本次等待结束，仍在运行"
                : "已读取输出"
              : (customOut ?? "已完成");
  // 失败不能投影成“完成”对勾；失败与中止都只使用中性停止图标。
  const ico = pending ? <span className="u-dot" />
    : running ? (LONG_RUNNING.has(spec.name) ? <Spin /> : <Dots />)
    : aborted || failed || semanticFailed ? <UIcon d={ICO.stop} />
    : <UIcon d={DONE_ICON_BY_KIND[spec.body.kind] ?? ICO.check} />;
  const seg = isProcOut && procOutSecs
    ? <span className="u-seg"><Countdown seconds={procOutSecs} /></span>
    : main ? <span className="u-seg">{main}</span> : null;
  return (
    <div className="u-bar">
      {userCancelledAskUser ? null : <span className="u-ico">{ico}</span>}
      <span className="u-lbl">{label}</span>
      {seg}
      <span className="u-spacer" />
      {userCancelledAskUser ? null : <span className="u-meta">{statusText}</span>}
    </div>
  );
}

// ═══════════ 基元 2:卡(头 + body),各工具二次定制 ═══════════
function UCard({ icon, title, sub, meta, running, collapsible, defaultOpen = true, children }: {
  icon: string; title: string; sub?: ReactNode; meta?: ReactNode; running?: boolean;
  collapsible?: boolean; defaultOpen?: boolean; children?: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const prevRunningRef = useRef(Boolean(running));
  // 只在 running→done 边沿自动折叠;用户手动展开后的完成卡不会被后续 rerender 重新折回。
  useEffect(() => {
    const wasRunning = prevRunningRef.current;
    const isRunning = Boolean(running);
    if (wasRunning && !isRunning) setOpen(false);
    prevRunningRef.current = isRunning;
  }, [running]);
  const hd = (
    <>
      <span className="u-card-ico">{running ? <Spin /> : <UIcon d={icon} />}</span>
      <span className="u-card-title">{title}</span>
      {sub != null && <span className="u-card-sub">{sub}</span>}
      <span className="u-card-meta">{meta}{collapsible && <Chevron open={open} />}</span>
    </>
  );
  return (
    <div className="u-card">
      {collapsible
        ? <button type="button" className="u-card-hd" onClick={() => setOpen((v) => !v)} aria-expanded={open}>{hd}</button>
        : <div className="u-card-hd">{hd}</div>}
      {open && children}
    </div>
  );
}

// ═══════════ 各工具卡(二次定制) ═══════════
export function UResearch({
  body,
  status = body.phase === "done" ? "done" : "running",
}: {
  body: ResearchCardBody;
  status?: ToolCallSpec["status"]["kind"];
}) {
  const aborted = status === "aborted";
  const failed = status === "failed";
  const terminal = aborted || failed;
  const done = status === "done" || (!terminal && body.phase === "done");
  const items = body.items.filter((it) => it.status !== "skipped");
  // 进度分子用 okCount(真正抓到实质正文的篇数),不用 fetchedCount(含略过的)——
  // 否则会出现"抓取 5/6"最后却只有"4 篇"的尴尬;改后 "抓取 4/6" 直接收敛到 "4 篇"。
  const meta = aborted ? "已中止"
    : failed ? "未完成"
    : body.phase === "searching" ? "检索中…"
    : body.phase === "fetching" ? `抓取 ${body.okCount}/${body.total ?? "…"}`
    : `${body.okCount} 篇`;
  return (
    <UCard icon={terminal ? ICO.stop : ICO.search} title="检索" sub={body.query} meta={meta} running={!done && !terminal} collapsible={body.phase !== "searching"} defaultOpen={!done && !terminal}>
      {items.length > 0 && (
        <div className="u-card-bd">
          <div className="u-list">
            {items.map((it, i) => {
              // 契约四态:pending=待抓取(灰点,不转) / fetching=抓取中(转) / browser=经浏览器(转) / done=对勾+字数
              const itemInFlight =
                it.status === "pending" || it.status === "fetching" || it.status === "browser";
              const ico = it.status === "done" ? <UIcon d={ICO.check} size={13} />
                : terminal && itemInFlight ? <UIcon d={ICO.stop} size={13} />
                : it.status === "pending" ? <span className="u-list-wait" />
                : <Spin />;
              const tag = it.status === "done" ? (it.wordCount ? `${it.wordCount.toLocaleString("zh-CN")} 字` : "已抓取")
                : terminal && itemInFlight ? (aborted ? "已中止" : "未完成")
                : it.status === "browser" ? "经浏览器"
                : it.status === "pending" ? "待抓取"
                : "抓取中";
              return (
                <div className="u-list-row" key={`${it.url}-${i}`}>
                  <span className="u-list-ico">{ico}</span>
                  <div className="u-list-main">
                    <div className="u-list-title" title={it.title}>{it.title}</div>
                    <a
                      className="u-list-url"
                      href={it.url}
                      title={it.url}
                      target="_blank"
                      rel="noopener noreferrer"
                    >{it.url}</a>
                  </div>
                  <span className="u-list-tag">{tag}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </UCard>
  );
}

export function USvg({ body, status }: { body: GenerateSvgCardBody; status: string }) {
  const [fullscreen, setFullscreen] = useState(false);
  const stage = body.progress?.stage;
  const done = status === "done" || stage === "done";
  const aborted = status === "aborted";
  const failed = status === "failed" || stage === "failed";
  const running = !done && !failed && !aborted;
  const meta = done ? "已完成" : aborted ? "已中止" : failed ? "未完成" : "生成中";
  const src = body.progress?.src ?? null;
  const partial = running ? body.progress?.partialSvg ?? null : null;
  return (
    <>
      <UCard icon={failed || aborted ? ICO.stop : ICO.image} title="生成配图" sub={body.prompt} meta={meta} running={running} collapsible defaultOpen={running}>
        <div className="u-card-bd">
          {done && src ? (
            <button type="button" className="u-thumb u-thumb-btn" onClick={() => setFullscreen(true)} title="全屏预览">
              <img src={src} alt={body.prompt} loading="lazy" />
            </button>
          ) : partial ? (
            <span className="u-thumb">
              <span className="u-thumb-svg" dangerouslySetInnerHTML={{ __html: partial }} />
              <span className="u-thumb-pulse" aria-hidden="true" />
            </span>
          ) : failed || aborted ? <div className="u-foot">{meta}</div>
            : <div className="u-thumb-empty">草稿生成中…</div>}
        </div>
      </UCard>
      {done && src && (
        <MediaZoomFullscreen open={fullscreen} onClose={() => setFullscreen(false)} ariaLabel="SVG 全屏查看" contentClassName="media-zoom-content--svg">
          <img src={src} alt={body.prompt} />
        </MediaZoomFullscreen>
      )}
    </>
  );
}

type ReadImageBody = { prompt: string; thumbnailSrc: string | null; excerpt: string | null };
export function UReadImage({ body, status }: { body: ReadImageBody; status: string }) {
  const aborted = status === "aborted";
  const failed = status === "failed";
  const done = status === "done";
  const running = !done && !failed && !aborted;
  const meta = aborted ? "已中止" : failed ? "未完成" : done ? "已完成" : "处理中";
  return (
    <UCard icon={failed || aborted ? ICO.stop : ICO.image} title="识别图片" sub={body.prompt} meta={meta} running={running} collapsible defaultOpen={running}>
      <div className="u-card-bd">
        {body.thumbnailSrc && (
          <span className="u-thumb">
            <img src={body.thumbnailSrc} alt={body.prompt} loading="lazy" />
            {running && <span className="u-thumb-pulse" aria-hidden="true" />}
          </span>
        )}
        {done && body.excerpt && <div className="u-foot">{body.excerpt}</div>}
      </div>
    </UCard>
  );
}

// 限高可滚的代码/输出框:限高 N 行,超出滚动。
//  - 滚动阴影按"该侧是否还有内容"动态加(到顶不加上阴影、到底不加下阴影);
//  - scrollbar-gutter:stable → 出现滚动条不挤压内容宽度;
//  - variant: code=深色终端 / output=较浅结果面板+赭色左条,一眼区分"执行 vs 输出"。
function ScrollBox({ lines, variant, children }: {
  lines: number; variant: "code" | "output"; children: ReactNode;
}) {
  const ref = useRef<HTMLPreElement>(null);
  const [edge, setEdge] = useState({ top: false, bottom: false });
  const update = () => {
    const el = ref.current;
    if (!el) return;
    setEdge({
      top: el.scrollTop > 1,
      bottom: el.scrollTop + el.clientHeight < el.scrollHeight - 1,
    });
  };
  useEffect(update, [children, lines]);
  const cls =
    `u-scrollbox u-scrollbox--${variant}` +
    (edge.top ? " has-top" : "") +
    (edge.bottom ? " has-bottom" : "");
  return (
    <div className={cls}>
      <pre ref={ref} className="u-scrollbox-pre" onScroll={update} style={{ "--u-sb-lines": lines } as CSSProperties}>
        {children}
      </pre>
    </div>
  );
}

export function UCommand({
  body,
  status,
}: {
  body: CommandCardBody;
  status?: ToolCallSpec["status"];
}) {
  const statusKind = status?.kind;
  // status 是单一权威；body.phase 只兼容尚未带终态 status 的旧帧。
  const phase = statusKind === "failed"
    ? "failed"
    : statusKind === "aborted"
      ? "failed"
    : statusKind === "done"
      ? "done"
      : statusKind === "pending" || statusKind === "running"
        ? "running"
        : body.phase;
  const done = phase === "done";
  const failed = phase === "failed";
  const running = phase === "running";
  const queued = statusKind === "pending";
  const terminalKind = running
    ? undefined
    : statusKind === "aborted"
      ? "aborted"
      : body.terminalKind;
  const meta = terminalKind === "rejected"
    ? "已取消，命令未执行"
    : terminalKind === "killed"
      ? body.signal ? `已终止（${body.signal}）` : "已终止"
      : terminalKind === "aborted"
        ? "已中止"
        : terminalKind === "authRequired"
          ? "需要重新授权"
        : terminalKind === "timedOut"
          ? "已超时"
          : terminalKind === "resourceExceeded"
            ? "资源超限"
            : terminalKind === "codeError"
              ? "代码出错"
          : terminalKind === "failed"
            ? "未完成"
            : terminalKind === "succeeded" || done
              ? body.background === true && body.pid
                ? `已在后台启动（PID: ${body.pid}）`
                : "已完成"
              : failed
                ? "未完成"
                : queued
                  ? "已确认，排队执行"
                  : "处理中";
  const icon = terminalKind === "succeeded" || done
    ? ICO.check
    : terminalKind === "rejected"
      ? ICO.cancel
      : terminalKind === "killed" || terminalKind === "aborted"
        ? ICO.stop
        : terminalKind === "failed" || terminalKind === "codeError" ||
            terminalKind === "resourceExceeded" || terminalKind === "timedOut" ||
            terminalKind === "authRequired"
          ? ICO.stop
          : ICO.cmd;
  // 授权收口的输出里只有半截交互提示与英文链接,展开给用户没有意义,与超时/中止同款隐藏。
  const showOutput = !failed && terminalKind !== "timedOut" && terminalKind !== "aborted" &&
    terminalKind !== "authRequired";
  const expandable = Boolean(body.command || (showOutput && body.outputTail));
  return (
    <UCard icon={icon} title={body.title} meta={meta} running={running} collapsible={expandable} defaultOpen={running}>
      {expandable && (
        <div className="u-card-bd u-card-bd--cmd">
          {body.command && (
            <ScrollBox lines={4} variant="code">{body.command.includes("\n") ? body.command : `$ ${body.command}`}</ScrollBox>
          )}
          {showOutput && body.outputTail && (
            <ScrollBox lines={3} variant="output">{body.outputTail}</ScrollBox>
          )}
        </div>
      )}
    </UCard>
  );
}

// ═══════════ 图片产出汇总条:「已生成 N 张图片」+ 文字高的圆角缩略图,点开放大 ═══════════
// 配图卡(USvg)本身不动、仍内联随过程折叠;这条后置到最终回复后,保证折叠后仍能看到/放大产出图。
export function UImageSummary({ images }: { images: { src: string; prompt: string }[] }) {
  const [zoom, setZoom] = useState<string | null>(null);
  if (images.length === 0) return null;
  return (
    <div className="u-imgsum">
      <span className="u-ico"><UIcon d={ICO.image} /></span>
      <span className="u-imgsum-lbl">已生成 {images.length} 张图片</span>
      <span className="u-imgsum-thumbs">
        {images.map((img, i) => (
          <button key={i} type="button" className="u-imgsum-thumb" title={img.prompt} onClick={() => setZoom(img.src)}>
            <img src={img.src} alt={img.prompt} loading="lazy" />
          </button>
        ))}
      </span>
      {zoom && (
        <MediaZoomFullscreen open onClose={() => setZoom(null)} ariaLabel="图片放大" contentClassName="media-zoom-content--svg">
          <img src={zoom} alt="" />
        </MediaZoomFullscreen>
      )}
    </div>
  );
}

// ═══════════ 轮级过程折叠:「— 过程 · N 步 —」横线条 ═══════════
// 一轮跑完(出最终回复)后,把工具调用等"过程"收成一条横线分隔的「过程·N步」,
// 点开内联展开(不缩进,与正文混排)。默认折叠;问卷/审批轮与进行中的轮不折(调用方判定)。
export function UProcessFold({ steps, defaultOpen = false, children }: {
  steps: number; defaultOpen?: boolean; children?: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <>
      <button type="button" className="u-procdiv" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <span className="u-procdiv-line" />
        <span className="u-procdiv-lbl">过程 · {steps} 步</span>
        <Chevron open={open} />
        <span className="u-procdiv-line" />
      </button>
      {open && children}
    </>
  );
}

// ═══════════ dispatch:in-scope 工具调用 → 统一组件 ═══════════
// (草稿/二维码/问卷 fullpage 由调用方 ChatMessageList 在上游处理,不进这里)
export function UnifiedToolCall({
  spec,
  skillLabels = EMPTY_SKILL_LABELS,
  materialLabels = EMPTY_MATERIAL_LABELS,
}: {
  spec: ToolCallSpec;
  skillLabels?: SkillLabelMap;
  materialLabels?: MaterialLabelMap;
}) {
  const b = spec.body;
  if (b.kind === "researchCard") return <UResearch body={b.data} status={spec.status.kind} />;
  if (b.kind === "readImageCard") return <UReadImage body={b.data} status={spec.status.kind} />;
  if (b.kind === "generateSvg") return <USvg body={b.data} status={spec.status.kind} />;
  if (b.kind === "commandCard") {
    return <UCommand body={b.data} status={spec.status} />;
  }
  // generic / 旧死 body.kind / askUser overlay → 统一一行
  return <UToolBar spec={spec} skillLabels={skillLabels} materialLabels={materialLabels} />;
}
