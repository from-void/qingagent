export type SourceKind = "pdf" | "md" | "yuque" | "feishu" | "web" | "png" | "xlsx";

export interface SessionSource {
  kind: SourceKind;
  tip: string;
}

export interface SessionGhostLine {
  width: 95 | 88 | 82 | 75 | 68 | 55 | 40;
}

export interface HomeSession {
  id: string;
  title: string;
  brief: string;
  imageUrl?: string | null;
  ghostLines: SessionGhostLine[];
  sources: SessionSource[];
  date: string;
  category: HomeNavId;
  recentEditedAt: number;
  createdAt: number;
  pushedAt: number;
  isDeleting?: boolean;
  generating?: boolean;
}

export type HomeNavId =
  | "long"
  | "short"
  | "video"
  | "image"
  | "knowledge"
  | "experience"
  | "collect"
  | "ops";


// ---------------------------------------------------------------------------
// API adapter: SessionMeta -> HomeSession
// ---------------------------------------------------------------------------

import type { SessionMeta } from "@qingagent/contract-ts";

/** Convert a server SessionMeta to the UI HomeSession shape. */
export function sessionMetaToHomeSession(s: SessionMeta): HomeSession {
  const createdTs = finiteTimestampSeconds(s.created_at, 0);
  // recentEditedAt 用后端的 updated_at(最近编辑);缺省回退到创建时间
  const editedTs = s.updated_at
    ? finiteTimestampSeconds(s.updated_at, createdTs)
    : createdTs;
  const title = normalizeHomeTitle(s.title);
  const brief = buildHomeBrief(s.summary, s.created_at);
  return {
    id: s.id,
    title,
    brief,
    imageUrl: s.imageUrl ?? null,
    ghostLines: generateGhostLines(brief),
    sources: [],
    date: formatRelativeDate(s.created_at),
    category: "long",
    recentEditedAt: editedTs,
    createdAt: createdTs,
    pushedAt: editedTs,
    isDeleting: s.status.kind === "Deleting",
    generating: s.generating,
  };
}

function finiteTimestampSeconds(iso: string, fallback: number): number {
  const timestamp = new Date(iso).getTime() / 1000;
  return Number.isFinite(timestamp) ? timestamp : fallback;
}

function normalizeHomeTitle(rawTitle: string): string {
  const title = rawTitle.trim();
  if (!title || title === "未命名草稿" || title === "无标题") return "无题";
  return title;
}

function buildHomeBrief(rawSummary: string, createdAtIso: string): string {
  const summary = rawSummary.trim();
  if (!summary || summary === "未开始" || summary === "空白会话") {
    return `${formatCreatedDate(createdAtIso)}创建`;
  }
  return summary;
}

function formatCreatedDate(iso: string): string {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return "未知日期";
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
}

function generateGhostLines(summary: string): SessionGhostLine[] {
  const widths: SessionGhostLine["width"][] = [95, 88, 82, 75, 68];
  const count = Math.max(3, Math.min(5, Math.ceil(summary.length / 5)));
  return widths.slice(0, count).map((width) => ({ width }));
}

function formatRelativeDate(iso: string): string {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return "未知日期";
  const now = new Date();
  const localDayNumber = (value: Date) =>
    Math.floor(
      Date.UTC(value.getFullYear(), value.getMonth(), value.getDate()) /
        (1000 * 60 * 60 * 24),
    );
  const diffDays = localDayNumber(now) - localDayNumber(d);
  if (diffDays <= 0) return "今天";
  if (diffDays === 1) return "昨天";
  if (diffDays < 7) return `${diffDays} 天前`;
  if (diffDays < 30) return `${Math.floor(diffDays / 7)} 周前`;
  return `${Math.floor(diffDays / 30)} 月前`;
}

// ---------------------------------------------------------------------------
// 开发用:批量 mock 会话(URL 带 ?mock=N 时启用),让首页长卷可一直向右滚动浏览装饰草木。
// 仅供本地预览/演示,不进入真实数据路径(无 ?mock 参数时完全不触发)。
// ---------------------------------------------------------------------------

const MOCK_TITLES = [
  "山行", "江雪", "春晓", "登高", "望岳", "观沧海", "饮湖上初晴后雨", "题西林壁",
  "桃花源记", "兰亭集序", "赤壁赋", "醉翁亭记", "陋室铭", "爱莲说", "岳阳楼记", "小石潭记",
  "鹿柴", "竹里馆", "山居秋暝", "渔歌子", "枫桥夜泊", "early-notes", "读书札记", "随笔一则",
];
const MOCK_CATS: HomeNavId[] = ["long", "short", "video", "image", "knowledge", "experience"];
const MOCK_WIDTHS: SessionGhostLine["width"][] = [95, 88, 82, 75, 68, 55, 40];

// 长文压测用语料(纯中文,够长以便环绕切片出不同长度)
const LONG_TITLE_SRC =
  "论江南园林造境中虚实相生移步换景之美学意趣兼及宋元山水长卷空间经营与笔墨语言流变及其在当代视觉设计语境中的转化重构与启示草木四时烟雨青简落墨成章气韵生动而意趣自远";
const LONG_BRIEF_SRC =
  "暮色四合时分独坐窗前展卷读书忽闻檐角风铃细响窗外细雨斜织远山如黛近水含烟一时之间笔意纵横起承转合移步换景虚实相生气韵生动而意趣自远遂提笔记下这一段闲情逸致以青简载之留与后人翻看时或可会心一笑亦未可知也于是落墨成章草木有时四时流转之间皆成文章而文章亦如草木自有荣枯各得其所各安其时";

// 环绕切片:从 start 起取 len 个字符,超出则回绕,保证够长且各卡长度不同
function sliceWrap(src: string, start: number, len: number): string {
  let out = "";
  for (let k = 0; k < len; k++) out += src[(start + k) % src.length] ?? "";
  return out;
}

// opts.long 时:标题/摘要都生成长文,长度按卡片梯度铺开,用来排查长标题/长摘要撑烂模板
export function makeMockSessions(n: number, opts: { long?: boolean } = {}): HomeSession[] {
  const count = Math.max(1, Math.min(800, Math.floor(n)));
  const base = 1_718_900_000; // 固定基准秒,避免依赖 Date.now,保证稳定排序
  const long = opts.long === true;
  const out: HomeSession[] = [];
  for (let i = 0; i < count; i++) {
    const created = base - i * 86_400;

    let title: string;
    let brief: string;
    if (long) {
      // 标题 14~42 字、摘要 40~282 字,按卡片梯度铺开,逼出不同溢出阈值
      const tLen = 14 + (i % 8) * 4;
      const bLen = 40 + (i % 12) * 22;
      title = sliceWrap(LONG_TITLE_SRC, (i * 7) % LONG_TITLE_SRC.length, tLen);
      brief = sliceWrap(LONG_BRIEF_SRC, (i * 5) % LONG_BRIEF_SRC.length, bLen);
    } else {
      const t = MOCK_TITLES[i % MOCK_TITLES.length]!;
      title = i >= MOCK_TITLES.length ? `${t} ${Math.floor(i / MOCK_TITLES.length) + 1}` : t;
      brief = `第 ${i + 1} 篇示例文稿——向右滚动长卷,沿途浏览四季水墨草木与飞鸟。`;
    }

    const lineCount = long ? 4 + (i % 6) : 3 + (i % 5);
    const ghostLines: SessionGhostLine[] = Array.from({ length: lineCount }, (_, k) => ({
      width: MOCK_WIDTHS[(i + k) % MOCK_WIDTHS.length]!,
    }));

    out.push({
      id: `mock-${i}`,
      title,
      brief,
      imageUrl: null,
      ghostLines,
      sources: [],
      date: `${i + 1} 天前`,
      category: MOCK_CATS[i % MOCK_CATS.length]!,
      recentEditedAt: created,
      createdAt: created,
      pushedAt: created,
      isDeleting: false,
    });
  }
  return out;
}
