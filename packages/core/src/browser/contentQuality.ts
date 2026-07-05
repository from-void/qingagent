// 内容实质度判定:抓取/解析出来的"正文"是否是有意义的真内容,
// 而不是只有标题 + 导航/分享控件拼出来的空洞壳(如 CCTV JS 渲染页:
// "超300款AI产品全球首发 扫一扫 分享到微信 手机看 A+")。
// 用于:① storeMaterial 落库前的硬门(不实不落库,当解析失败);
//       ② fetchArticle 决定是否升级浏览器;③ scrapeWithBrowser 渲染后判失败。

// 站点导航/分享/控件等"非正文"词:计算真内容长度时先剔除。
const CONTROL_WORD_RE =
  /扫一扫|分享到微信|分享到|分享：|分享:|手机看|手机继续看|手机阅读|点击收起全文|点击收起|点击展开|展开全文|收起全文|返回首页|返回顶部|返回新闻|返回央视|返回上一页|上一页|下一页|网站地图|全站地图|联系我们|关于我们|版权所有|京ICP备|ICP备|责任编辑|主编|编辑：|编辑:|来源：|来源:|登录|注册|下载App|下载客户端|打开App|开启App|正在加载|加载中|加载更多|最新推荐|相关推荐|精彩图集|热门文章|望海热线|中央广播电视总台|无障碍|关怀版|A\+|字号|繁體|简体|English|会员登录|會員登入|加入会员|加入會員|购物袋|購物袋|订书|訂書|资源分类|書目檢索|书目检索|点赞|评论|收藏|关注|当前位置|首页|首頁/g;

// 真内容(剔除控件词与空白后)的最小字数:低于此视为"空洞壳"。
// CCTV 这类壳剔除控件后通常 <50 字;正常研究类正文动辄数百字。
export const MIN_SUBSTANTIVE_CHARS = 140;

// 正文"信息密度"信号(多信号,而非单一句末标点):真实正文——无论连续散文、
// emoji 清单式攻略、还是"景点:信息"冒号清单——都富含 句末标点/逗号顿号/冒号/emoji 之一;
// 而政务·高校的导航·目录·筛选壳是空格分隔的短碎片(省份名/栏目名/院校名/章节号),
// 这四类标点 emoji 几乎全为 0。实测:trip 西湖攻略 richness=28、单句正文=11、
// gov 目录壳/课程目录壳=0,分得很开。用多信号避免误杀 emoji/清单式真实攻略(曾被单一句读门误杀)。
// 句末标点:中文全角 。！？； 总是计;英文 . ! ? ; 仅当"句末"(后接空白/引号/括号/结尾)才计——
// 避免把小数 3.14、缩写 U.S.、域名 a.com 里的点误计。不加英文句号则英文正文(学术 PDF/英文文章)
// 会因 richness 过低被误判为壳(线上 osti.gov/arxiv PDF 11 万字英文正文曾被误杀)。
const SENTENCE_END_RE = /[。！？；]|[.!?;](?=[\s"'’”)\]]|$)/g;
const COMMA_RE = /[，、,]/g;
const COLON_RE = /[：:]/g;
const EMOJI_RE = /\p{Extended_Pictographic}/gu;
// 每多少字至少要积累 1 点信息密度。真实正文标点/emoji 远密于此(~每 10 字一个),
// 纯导航/目录/表格壳通篇近 0、长度越长越拉不平 → 稳定低于要求。
// 取 50:实测能把 838 字高校名单表格壳(rich≈10)、1285 字政务栏目壳(rich≈7)判掉,
// 同时真实正文(连续散文/emoji 攻略/冒号清单)余量充足。
// 注:极短(~140 字)的"无结果/纯页脚"壳因页脚冒号仍可能擦边过门——属已知小边界,
// 不为它收紧门槛而误杀短真文(短真文与短壳的 richness 在该长度天然重叠)。
const CHARS_PER_RICHNESS = 50;
const MIN_RICHNESS = 3;

/**
 * 判断一段抓取/解析出来的正文是否"有实质内容"。
 * - 空 / 仅错误占位 → false
 * - 剔除导航/分享/控件词后真内容 < MIN_SUBSTANTIVE_CHARS → false(空洞壳)
 * - 长度过关但"信息密度"过低(政务/高校目录·筛选·栏目列表壳:空格分隔短碎片、
 *   几乎无标点 emoji 的结构特征)→ false
 * - 否则 → true
 *
 * 结构信号优于关键词黑名单:站点导航词永远列不全(图书馆/政务/百科各一套),
 * 但"真实正文标点/emoji 密、壳几乎为 0"是跨站稳定的。阈值按长度缩放,避免误杀短正文。
 */
export function isSubstantiveContent(text: string | null | undefined): boolean {
  if (!text) return false;
  const trimmed = text.trim();
  if (!trimmed) return false;
  // 抓取失败的错误占位文本(如 "[Error] ...")不算正文。
  if (/^\[(Error|Unsupported)\]/i.test(trimmed)) return false;
  const realContent = trimmed.replace(CONTROL_WORD_RE, "").replace(/\s+/g, "");
  if (realContent.length < MIN_SUBSTANTIVE_CHARS) return false;
  // 信息密度:句末标点权重更高(最强正文信号),逗号/冒号/emoji 各计 1;按长度缩放比对。
  const richness =
    (trimmed.match(SENTENCE_END_RE) || []).length * 2 +
    (trimmed.match(COMMA_RE) || []).length +
    (trimmed.match(COLON_RE) || []).length +
    (trimmed.match(EMOJI_RE) || []).length;
  const required = Math.max(MIN_RICHNESS, Math.floor(realContent.length / CHARS_PER_RICHNESS));
  if (richness < required) return false;
  return true;
}
