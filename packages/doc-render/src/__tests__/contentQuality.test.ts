import { describe, expect, it } from "vitest";
import { isSubstantiveContent, MIN_SUBSTANTIVE_CHARS } from "../browser/contentQuality.js";

describe("isSubstantiveContent", () => {
  it("rejects empty / whitespace / nullish", () => {
    expect(isSubstantiveContent("")).toBe(false);
    expect(isSubstantiveContent("   \n\t ")).toBe(false);
    expect(isSubstantiveContent(null)).toBe(false);
    expect(isSubstantiveContent(undefined)).toBe(false);
  });

  it("rejects抓取失败占位文本", () => {
    expect(isSubstantiveContent("[Error] fetch failed")).toBe(false);
    expect(isSubstantiveContent("[Unsupported] 不支持该格式")).toBe(false);
  });

  it("rejects空洞壳:只有标题+导航/分享控件(线上 CCTV 真实样本)", () => {
    // 线上真实落库脏数据:动态渲染页静态/浏览器都只拿到页面外壳,
    // 标题之外全是导航/分享/控件词,剔除后真内容寥寥无几——必须判为非实质。
    const cctvShell =
      "超300款AI产品全球首发 扫一扫 分享到微信 手机看 A+ 返回顶部 " +
      "返回央视网首页 返回新闻频道 最新推荐 加载更多 精彩图集 首页 全站地图 " +
      "京ICP备 中央广播电视总台 版权所有 责任编辑 编辑：";
    // 壳整体字数过了旧 <40 门槛(误判为"够长"),但剔除控件词后真内容极少。
    expect(cctvShell.replace(/\s+/g, "").length).toBeGreaterThan(40);
    expect(isSubstantiveContent(cctvShell)).toBe(false);
  });

  it("rejects纯导航壳", () => {
    const navShell =
      "首页 返回顶部 版权所有 ICP备 扫一扫 分享到微信 下载App 登录 注册 " +
      "最新推荐 全站地图 联系我们 关于我们 当前位置";
    expect(isSubstantiveContent(navShell)).toBe(false);
  });

  it("accepts真实正文(数百字研究类内容)", () => {
    const realArticle =
      "宋代点茶是中国茶文化的高峰。点茶法以茶筅击拂茶汤，使其表面浮起一层细腻的白色泡沫，" +
      "称为“乳花”。文人雅士以斗茶为乐，比拼茶汤颜色与咬盏持久度。蔡襄《茶录》、宋徽宗《大观茶论》" +
      "都对点茶技艺有详尽记载，反映出当时茶事的精致与审美追求。这一时期的茶器、茶礼与茶诗共同" +
      "构成了独具特色的宋代茶文化体系。";
    expect(realArticle.replace(/\s+/g, "").length).toBeGreaterThan(MIN_SUBSTANTIVE_CHARS);
    expect(isSubstantiveContent(realArticle)).toBe(true);
  });

  it("rejects政务/高校目录·筛选·栏目壳(长度过门槛但通篇无句读·线上真实漏网)", () => {
    // 线上真实 junk-stored:hudong.moe.gov.cn 全国高校名单筛选页,
    // 浏览器渲染出 886 字,但全是"办学层次/省份/院校名"空格分隔,一个句号都没有。
    const moeFilterShell =
      "无障碍浏览 办学层次 全部 本科 专科 所在省份 全部 北京市 天津市 河北省 山西省 " +
      "内蒙古自治区 辽宁省 吉林省 黑龙江省 上海市 江苏省 浙江省 安徽省 福建省 江西省 " +
      "山东省 河南省 湖北省 湖南省 广东省 广西壮族自治区 海南省 重庆市 四川省 贵州省 " +
      "云南省 西藏自治区 陕西省 甘肃省 青海省 宁夏回族自治区 新疆维吾尔自治区 " +
      "清华大学 北京大学 中国人民大学 北京师范大学 共146页 2919条数据 下一页 末页";
    expect(moeFilterShell.replace(/\s+/g, "").length).toBeGreaterThan(MIN_SUBSTANTIVE_CHARS);
    expect(isSubstantiveContent(moeFilterShell)).toBe(false);

    // 线上真实:政务公开"栏目列表/面包屑"壳,1000+ 字也通篇无句号。
    const govColumnShell =
      "您当前的位置 首页 专题专栏 基层政务公开标准化规范化便捷化 政策文件 网站栏目 " +
      "主动公开事项目录 县直部门主动公开事项目录 乡镇主动公开事项目录 村居主动公开事项目录 " +
      "工作推进 政策文件 经典案例 政务公开专区建设 信息公开指南 信息公开制度 法定主动公开内容 " +
      "财政预算决算 重大建设项目 公共资源配置 社会公益事业 上一页 下一页 首页 尾页 共50页";
    expect(govColumnShell.replace(/\s+/g, "").length).toBeGreaterThan(MIN_SUBSTANTIVE_CHARS);
    expect(isSubstantiveContent(govColumnShell)).toBe(false);
  });

  it("不误杀:emoji/清单式真实攻略(句末标点少但 emoji/冒号/逗号密)仍接受", () => {
    // 线上真实被误杀样本(tw.trip.com 西湖攻略):清单+emoji 风格,句末标点仅 2,
    // 但 emoji/冒号/逗号很密——是高频真实内容,绝不能当壳拒掉。
    const emojiTravelGuide =
      "杭州西湖旅遊攻略｜西子湖必打卡十景 西湖的自然魅力✨她被譽為「人間天堂」,是中國首個世界文化遺產湖泊," +
      "環湖一圈15公里,四季美如畫卷~🌸☀️🍁❄️ ▫️春季:蘇堤十里桃花開(3-4月) ▫️夏季:曲院風荷正當時 " +
      "▫️秋季:平湖秋月寄相思 ▫️冬季:斷橋殘雪最是浪漫 【必玩推薦TOP5】1️⃣三潭印月💴55🚤需乘船登島 " +
      "2️⃣雷峰塔💴40🏯登頂俯瞰西湖全景 3️⃣斷橋殘雪🌉許仙白娘子相遇地 4️⃣柳浪聞鶯🐦南宋皇家園林 " +
      "5️⃣龍井問茶🍵採茶體驗+品明前龍井";
    expect(emojiTravelGuide.replace(/\s+/g, "").length).toBeGreaterThan(MIN_SUBSTANTIVE_CHARS);
    expect(isSubstantiveContent(emojiTravelGuide)).toBe(true);
  });

  it("rejects课程目录/章节树壳(目录+章节号、无标点 emoji)", () => {
    // 线上 junk-stored:超星课程页只抓到"目录+章节树",空格分隔、零标点/emoji。
    const courseTocShell =
      "目录 1 戏曲发展史 1.1 诞生与发展 1.2 元杂剧 1.3 明清传奇 1.4 近代戏曲改良 2 京剧行当 2.1 生 " +
      "2.2 旦 2.3 净 2.4 丑 2.5 行当流变 3 戏曲装束和脸谱 3.1 服装 3.2 盔头 3.3 脸谱 3.4 髯口 " +
      "4 京剧流派 4.1 梅派 4.2 程派 4.3 荀派 4.4 尚派 4.5 余派 4.6 马派 5 经典剧目赏析 " +
      "5.1 贵妃醉酒 5.2 霸王别姬 5.3 四郎探母 5.4 锁麟囊 课程简介 报名 章节测验 讨论 评论 收藏 分享";
    expect(courseTocShell.replace(/\s+/g, "").length).toBeGreaterThan(MIN_SUBSTANTIVE_CHARS);
    expect(isSubstantiveContent(courseTocShell)).toBe(false);
  });

  it("不误杀:长度达标、句读较少的真实正文(单长句)仍接受", () => {
    // 边界:阈值按长度缩放(120 字/句),~150 字只需 1 个句末标点,
    // 真实长句正文(哪怕只有一个句号)不该被结构信号误杀成壳。
    const terseRealProse =
      "区块链是一种由多方共同维护、使用密码学保证传输与访问安全、能够实现数据一致存储、" +
      "难以篡改、防止抵赖的分布式账本技术,它把交易按时间顺序打包成区块并以哈希前后相连," +
      "任何一方都无法在不被察觉的情况下单方面修改历史记录,因而在金融清算、供应链溯源、" +
      "版权存证与数字身份等需要多方互信的领域有着广泛的应用前景。";
    expect(terseRealProse.replace(/\s+/g, "").length).toBeGreaterThan(MIN_SUBSTANTIVE_CHARS);
    expect(isSubstantiveContent(terseRealProse)).toBe(true);
  });

  it("accepts英文长正文(句末 ASCII 句号计入 richness,学术 PDF/英文文章不被误杀)", () => {
    // 英文正文主要用 ASCII 句号断句——richness 必须计句末句号,否则 11 万字英文 PDF 也判壳
    //(线上 osti.gov / arxiv PDF 曾因此被误杀)。小数 3.14 / 缩写 U.S. 里的点不该计。
    const englishArticle =
      "This report examines the experimental study of plasma self-generated torque on the EAST tokamak. " +
      "The neutral beam injection method was used to characterize the L-mode torque distribution. " +
      "Results show that the measured profiles agree with theoretical predictions within 3.14 percent. " +
      "The U.S. Department of Energy sponsored this work, and the findings have broad implications. " +
      "Further measurements will refine the engineering basis for future fusion reactor designs.";
    expect(englishArticle.replace(/\s+/g, "").length).toBeGreaterThan(MIN_SUBSTANTIVE_CHARS);
    expect(isSubstantiveContent(englishArticle)).toBe(true);
  });

  it("accepts偶尔出现控件词的真实长文(剔除后仍有充足正文)", () => {
    // 真实长文里偶然出现“分享”“登录”等词,剔除后正文依然充足,不应误判为壳。
    const realWithNoise =
      "登录后可收藏本文。" +
      "敦煌壁画是世界文化遗产的瑰宝，历经十六国至元代千余年的持续营建。" +
      "莫高窟现存洞窟七百余个，壁画四万五千余平方米，题材涵盖佛传、本生、经变、" +
      "供养人画像与装饰图案。其线描遒劲、设色绚丽，飞天形象尤为灵动，是研究古代" +
      "宗教、艺术、社会生活的第一手材料。北朝壁画风格雄浑古拙，受西域晕染法影响；" +
      "隋唐时期则气象恢宏、设色富丽，经变画规模宏大，反映出盛世的社会风貌与审美旨趣。" +
      "壁画中的建筑、服饰、乐舞、农耕等细节，为后世复原古代社会提供了珍贵的图像证据。" +
      "欢迎分享到微信，扫一扫关注。";
    expect(isSubstantiveContent(realWithNoise)).toBe(true);
  });
});
