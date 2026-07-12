import { describe, expect, it } from "vitest";
import * as cheerio from "cheerio";
import {
  cleanText,
  selectBodyText,
  textWithBlockBreaks,
  trimArticleBoilerplateLines,
} from "../browser/extractor.js";

// 抓取正文"没有排版堆在一起"的回归:cheerio .text() 拼接块级元素时零分隔,
// textWithBlockBreaks 在块级边界补换行、br 转换行,保住段落结构。

// 压缩 HTML(标签间零空白)——线上正文糊成一坨正是这种形态;
// 美化排版的 HTML 标签间自带换行文本节点,暴露不出这个 bug。
const HTML =
  "<html><body><article><h1>标题行</h1><p>第一段内容。</p><p>第二段内容。</p>" +
  "<div>第三段<br>换行后的句子</div><ul><li>要点一</li><li>要点二</li></ul></article></body></html>";

describe("textWithBlockBreaks 块级换行保真", () => {
  it("旧行为复现:裸 .text() 段落间零分隔(文档化 bug 形态)", () => {
    const $ = cheerio.load(HTML);
    const flat = cleanText($("article").text());
    // 标题和第一段被直接粘在一起,中间连分隔都没有
    expect(flat).toBe("标题行第一段内容。第二段内容。第三段换行后的句子要点一要点二");
  });

  it("块级元素之间产生换行,br 转换行,段落结构完整", () => {
    const $ = cheerio.load(HTML);
    const text = cleanText(textWithBlockBreaks($, "article"));
    const lines = text.split("\n").filter((l) => l.trim().length > 0);
    expect(lines).toEqual([
      "标题行",
      "第一段内容。",
      "第二段内容。",
      "第三段",
      "换行后的句子",
      "要点一",
      "要点二",
    ]);
  });

  it("不修改原 DOM(基于克隆操作),重复调用结果一致", () => {
    const $ = cheerio.load(HTML);
    const first = textWithBlockBreaks($, "article");
    const second = textWithBlockBreaks($, "article");
    expect(second).toBe(first);
  });

  it("正文提取先剥离导航/页脚/侧栏,body 兜底不混入站点导航", () => {
    const noisyHtml =
      "<html><body>" +
      "<header>网页 新闻 贴吧 知道 网盘 图片 视频 地图 文库 百度首页 登录 注册</header>" +
      "<nav>首页 财经 科技 汽车 房产 下载App 个人中心</nav>" +
      "<div class='site-links'>账号设置 我的关注 我的收藏 申请的报道 退出登录 登录 搜索 " +
      "新闻 财经 科技 汽车 房产 应用 首页 注册 下载 客户端 频道 导航 专题</div>" +
      "<aside class='sidebar'>相关推荐 热榜 排行 广告 分享 登录 订阅</aside>" +
      "<main><article><h1>最新iPhone发布时间</h1>" +
      "<p>苹果通常会在秋季发布新款 iPhone,发布会后不久开启预订并陆续上市。</p>" +
      "<p>这段正文用于验证抽取逻辑会优先留下文章标题和正文,而不是页面导航。</p>" +
      "</article></main>" +
      "<footer>返回首页 关于我们 版权所有 ICP备案</footer>" +
      "</body></html>";
    const $ = cheerio.load(noisyHtml);
    const text = selectBodyText($);

    expect(text).toContain("最新iPhone发布时间");
    expect(text).toContain("苹果通常会在秋季发布新款 iPhone");
    expect(text).not.toContain("网页 新闻 贴吧");
    expect(text).not.toContain("百度首页 登录 注册");
    expect(text).not.toContain("账号设置 我的关注");
    expect(text).not.toContain("版权所有 ICP备案");
  });

  it("没有正文容器时,body 兜底从真实 h1 裁掉前置导航", () => {
    const fallbackHtml =
      "<html><body>" +
      "<h1>全部导航</h1>" +
      "<div class='site-links'>时政 国内 国际 财经 社会 娱乐 天气 交通 体育 军事 教育 科普</div>" +
      "<h1>iPhone 17系列发布：5999元起，最贵17999元</h1>" +
      "<p>北京时间凌晨,苹果召开秋季新品发布会,多款新机正式亮相。</p>" +
      "<p>全部新机型将于本周开启预购,随后正式开售。</p>" +
      "</body></html>";
    const $ = cheerio.load(fallbackHtml);
    const text = selectBodyText($);

    expect(text).toMatch(/^iPhone 17系列发布/);
    expect(text).toContain("苹果召开秋季新品发布会");
    expect(text).not.toContain("全部导航");
    expect(text).not.toContain("时政 国内 国际");
  });

  it("没有正文容器和有效 h1 时,body 兜底剥掉首行菜单导航", () => {
    const fallbackHtml =
      "<html><body>" +
      "<div>Home 產業新聞 主題快搜 今日新聞聽播 新聞總覽 半導體 資通訊 零組件 物聯網 顯示器</div>" +
      "<p>蘋果公司宣布新款 iPhone 的上市安排,供應鏈也同步進入備貨階段。</p>" +
      "<p>市場預期新機將帶動下半年消費電子需求。</p>" +
      "</body></html>";
    const $ = cheerio.load(fallbackHtml);
    const text = selectBodyText($);

    expect(text).toMatch(/^蘋果公司宣布新款 iPhone/);
    expect(text).toContain("消費電子需求");
    expect(text).not.toContain("Home 產業新聞");
  });

  it("按行剥掉正文首部连续短导航/控件,保留正文主体", () => {
    const article =
      [
        "您好，欢迎来到皮书数据库",
        "登录",
        "资源分类",
        "皮书分类",
        "点赞 评论 收藏 分享 当前位置",
        "新能源汽车产业进入快速调整期，政策、技术路线和消费需求正在共同改变市场结构。",
        "这段正文用于验证裁剪逻辑不会删掉主体内容，后续段落仍然完整保留。",
        "热门文章",
        "App下载",
        "ICP备案",
      ].join("\n");

    const text = trimArticleBoilerplateLines(article);

    expect(text).toMatch(/^新能源汽车产业进入快速调整期/);
    expect(text).toContain("后续段落仍然完整保留。");
    expect(text).not.toContain("您好，欢迎来到皮书数据库");
    expect(text).not.toContain("点赞 评论 收藏 分享 当前位置");
    expect(text).not.toContain("ICP备案");
  });

  it("正常正文没有导航前缀时不误裁", () => {
    const article =
      [
        "评论并不总是页面控件，文章开头也可能直接讨论读者反馈与平台互动。",
        "新能源汽车产业进入快速调整期，政策、技术路线和消费需求正在共同改变市场结构。",
        "这段正文用于验证没有导航前缀的文本会保持原样。",
      ].join("\n");

    expect(trimArticleBoilerplateLines(article)).toBe(article);
  });

  it("控制前缀和第一句正文糊在同一行时,只剥正文前的控件段", () => {
    const article =
      "登录\n资源分类\n原版阅读 / 下载图书 / 生成引文 / 中文摘要 / " +
      "新能源汽车蓝皮书是关于中国新能源汽车产业发展的年度研究报告，正文第一句应当保留。\n" +
      "后续正文也应完整保留。";

    const text = trimArticleBoilerplateLines(article);

    expect(text).toMatch(/^新能源汽车蓝皮书是关于中国新能源汽车产业发展的年度研究报告/);
    expect(text).toContain("后续正文也应完整保留。");
    expect(text).not.toContain("原版阅读");
    expect(text).not.toContain("生成引文");
  });

  it("正文被 <form> 包裹时不被整段删掉(ASP.NET WebForms / VSB CMS 回归)", () => {
    // 线上真实漏网:library.xhcom.edu.cn 把整列正文裹在服务端 <form> 里,
    // 旧 BOILERPLATE 含 "form" → .remove() 把 #vsb_content 正文连根删掉,只剩导航壳(264 字),
    // 还骗过了实质内容门照样落库。修法:不删 <form> 本体,只删表单控件,保住 form 内正文。
    const formWrappedHtml =
      "<html><body>" +
      "<div class='nav'>馆藏搜索 电子资源 读者服务 馆藏分布 联系我们 关于本馆</div>" +
      "<form method='post' action='./'>" +
      "<input type='hidden' name='__VIEWSTATE' value='xxxx' />" +
      "<input type='text' placeholder='站内搜索' /><button>搜索</button>" +
      "<article class='art'><div id='vsb_content'><div class='v_news_content'>" +
      "<p>希腊神话包括神的故事和英雄传说两个部分。神的故事涉及宇宙和人类的起源、神的产生及其谱系。</p>" +
      "<p>相传古希腊有十二大神:众神之主宙斯,其妻赫拉,海神波塞冬,智慧女神雅典娜,太阳神阿波罗。</p>" +
      "<p>英雄传说多源于对祖先的崇拜,赞美集体的智慧与力量,寄托着古希腊人对自身历史的追忆。</p>" +
      "</div></div></article>" +
      "</form>" +
      "<footer>版权所有 ICP备 返回顶部</footer>" +
      "</body></html>";
    const $ = cheerio.load(formWrappedHtml);
    const text = selectBodyText($);

    // 正文(form 内)必须保住
    expect(text).toContain("希腊神话包括神的故事和英雄传说");
    expect(text).toContain("众神之主宙斯");
    expect(text).toContain("寄托着古希腊人对自身历史的追忆");
    // 表单控件与导航/页脚不应混进正文
    expect(text).not.toContain("站内搜索");
    expect(text).not.toContain("馆藏搜索 电子资源");
    expect(text).not.toContain("版权所有 ICP备");
    // 抽到的应是 655+ 字的真正文,而不是几十字的导航壳
    expect(text.replace(/\s+/g, "").length).toBeGreaterThan(120);
  });

  it("正文整列放在 <aside> 里不被整段删(aside footgun 回归)", () => {
    // 部分老式 CMS / 政府子站把正文列放进 <aside>。aside 整段 .remove() 会清零正文。
    const asideMainHtml =
      "<html><body>" +
      "<nav>首页 新闻 公告 联系我们</nav>" +
      "<aside class='main-col'><article><h1>核聚变研究新进展</h1>" +
      "<p>我国全超导托卡马克装置实现上亿摄氏度高约束模式等离子体运行,刷新了世界纪录。</p>" +
      "<p>这一突破为未来聚变堆的工程化与商业化奠定了关键的物理与工程基础。</p>" +
      "</article></aside>" +
      "<footer>版权所有</footer>" +
      "</body></html>";
    const $ = cheerio.load(asideMainHtml);
    const text = selectBodyText($);
    expect(text).toContain("核聚变研究新进展");
    expect(text).toContain("刷新了世界纪录");
    expect(text).not.toContain("首页 新闻 公告");
  });

  it("正文容器恰好挂了栏目 class(article hot / content recommend)不被整段删", () => {
    // class 是精确 token 匹配:正文 wrapper 多挂一个 hot/recommend 修饰 class 很常见,
    // .hot/.recommend 整段删会把正文连根删掉。只在"不含正文容器"时才删高风险区块。
    const taggedHtml =
      "<html><body>" +
      "<div class='article hot'><h1>量产提速</h1>" +
      "<p>人形机器人企业宣布年内万台量产计划,带动上下游核心零部件需求快速增长。</p>" +
      "<p>业内认为规模化将显著摊薄成本,推动行业从样机走向真正的商业落地。</p>" +
      "</div></body></html>";
    const $ = cheerio.load(taggedHtml);
    const text = selectBodyText($);
    expect(text).toContain("人形机器人企业宣布年内万台量产计划");
    expect(text).toContain("商业落地");
  });

  it("真正的侧栏(.related 内无正文容器)仍被剥离,不混入正文", () => {
    const sidebarHtml =
      "<html><body>" +
      "<article><h1>主文章标题</h1>" +
      "<p>这是文章的真实正文,讲述了一个完整的事件经过与背景分析,内容充实。</p></article>" +
      "<div class='related'>相关推荐 热点排行 猜你喜欢 广告位 更多内容</div>" +
      "</body></html>";
    const $ = cheerio.load(sidebarHtml);
    const text = selectBodyText($);
    expect(text).toContain("这是文章的真实正文");
    expect(text).not.toContain("相关推荐 热点排行");
  });

  it("body 兜底可从较深的真实 h1 起裁,处理长站点导航块", () => {
    const noisyNav = Array.from({ length: 70 }, (_, index) => `登录 注册 资源分类 导航 ${index}`).join(
      "\n",
    );
    const bodyParagraph = "新能源汽车蓝皮书系统分析产业发展情况，并对未来趋势进行展望。".repeat(20);
    const fallbackHtml =
      "<html><body>" +
      `<div>${noisyNav}</div>` +
      "<h1>中国新能源汽车产业发展报告（2025）</h1>" +
      `<p>${bodyParagraph}</p>` +
      "<p>这段正文用于验证较长导航块之后的真实标题仍会成为提取起点。</p>" +
      "</body></html>";
    const $ = cheerio.load(fallbackHtml);
    const text = selectBodyText($);

    expect(text).toMatch(/^中国新能源汽车产业发展报告/);
    expect(text).toContain("未来趋势进行展望。");
    expect(text).not.toContain("登录 注册 资源分类");
  });
});
