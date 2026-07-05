// 新建页「汉字矩阵」背景层运行时可调参数。
// 与 revealPresentationConfig 同构:模块级 store + localStorage 持久化 + 订阅。
// 由 Ctrl+Shift+H 唤起的右下角面板(HanziMatrixPanel)读写。

export type HanziMatrixPresetKey = "xuanqing" | "cyber" | "daiqing" | "xuanzhi";
export type HanziMatrixPoolKey =
  | "writing"
  | "qianziwen"
  | "lanting"
  | "jizhiwengao"
  | "hanshitie";

/** 天下三大行书:新建页背景随机从这三篇里选一篇。 */
export const CALLIGRAPHY_POOL_KEYS = ["lanting", "jizhiwengao", "hanshitie"] as const;

export interface HanziMatrixConfig {
  /** 是否启用矩阵背景层。 */
  enabled: boolean;
  /** 颜色风格预设。 */
  preset: HanziMatrixPresetKey;
  /** 高亮比例(0-0.8):任一时刻处于闪烁脉冲中的字符占比,随机挑字、轮换点亮。 */
  hiRatio: number;
  /** 节奏:动画时长倍率,越大越慢。 */
  speed: number;
  /** 底色字透明度(未闪烁字符)。 */
  baseAlpha: number;
  /** 高亮字透明度(闪烁中的字符,统一缩放 30%/50%/峰值三个高亮色)。 */
  hiAlpha: number;
  /** 格子边长(px),同时决定字号。 */
  cell: number;
  /** 字符池。 */
  pool: HanziMatrixPoolKey;
  /** 中央椭圆蒙版强度(0-1):中心区域字符的淡出程度,0 = 无蒙版,1 = 中心全隐。 */
  maskStrength: number;
  /** 蒙版椭圆宽度(占视口宽度百分比,中心居中)。 */
  maskWidth: number;
  /** 蒙版椭圆高度(占视口高度百分比,中心居中)。 */
  maskHeight: number;
  /** 中心区域模糊半径(px),0 = 不模糊(不渲染模糊层)。 */
  maskBlur: number;
}

/** 预设只定义字符配色,不动页面背景(背景始终是玄青夜空)。
    所有颜色一律存 rgb 三元组:底色透明度由 baseAlpha 控制,高亮三色由 hiAlpha 统一缩放。 */
export interface HanziMatrixPreset {
  name: string;
  /** 底色字 rgb 三元组。 */
  baseRgb: string;
  /** 闪烁 30% 处 rgb 三元组。 */
  hi1Rgb: string;
  /** 闪烁 50% 处 rgb 三元组。 */
  hi2Rgb: string;
  /** 闪烁 70% 峰值 rgb 三元组。 */
  peakRgb: string;
  /** 该预设建议的底色字透明度(切预设时带过去)。 */
  baseAlpha: number;
}

export const HANZI_MATRIX_PRESETS: Record<HanziMatrixPresetKey, HanziMatrixPreset> = {
  xuanqing: {
    name: "玄青墨韵",
    baseRgb: "236, 227, 208",
    hi1Rgb: "185, 173, 148",
    hi2Rgb: "224, 138, 128",
    peakRgb: "236, 227, 208",
    baseAlpha: 0.1,
  },
  daiqing: {
    name: "黛青湖光",
    baseRgb: "142, 160, 160",
    hi1Rgb: "150, 200, 200",
    hi2Rgb: "126, 147, 160",
    peakRgb: "232, 242, 238",
    baseAlpha: 0.14,
  },
  xuanzhi: {
    name: "宣纸朱批",
    baseRgb: "185, 173, 148",
    hi1Rgb: "185, 173, 148",
    hi2Rgb: "207, 90, 79",
    peakRgb: "236, 227, 208",
    baseAlpha: 0.12,
  },
  cyber: {
    name: "原版青蓝",
    baseRgb: "0, 150, 255",
    hi1Rgb: "100, 200, 255",
    hi2Rgb: "255, 105, 180",
    peakRgb: "255, 255, 255",
    baseAlpha: 0.25,
  },
};

export const HANZI_MATRIX_POOLS: Record<HanziMatrixPoolKey, { name: string; chars: string }> = {
  writing: {
    name: "写作集字",
    chars:
      "文章千古事得失寸心知笔墨纸砚诗词歌赋书写读思创作灵感故事章节段落字句" +
      "风花雪月山川湖海春夏秋冬星辰大海光阴流年岁月静好人间烟火" +
      "横竖撇捺点折钩提楷行草隶篆刻印章句读平仄韵律对仗起承转合",
  },
  qianziwen: {
    name: "千字文",
    chars:
      "天地玄黄宇宙洪荒日月盈昃辰宿列张寒来暑往秋收冬藏闰余成岁律吕调阳" +
      "云腾致雨露结为霜金生丽水玉出昆冈剑号巨阙珠称夜光果珍李柰菜重芥姜" +
      "海咸河淡鳞潜羽翔龙师火帝鸟官人皇始制文字乃服衣裳",
  },
  lanting: {
    name: "兰亭集序",
    chars:
      "永和九年岁在癸丑暮春之初会于会稽山阴之兰亭修禊事也群贤毕至少长咸集" +
      "此地有崇山峻岭茂林修竹又有清流激湍映带左右引以为流觞曲水列坐其次" +
      "虽无丝竹管弦之盛一觞一咏亦足以畅叙幽情",
  },
  jizhiwengao: {
    name: "祭侄文稿",
    chars:
      "维乾元元年岁次戊戌九月庚午朔三日壬申第十三叔银青光禄大夫使持节蒲州诸军事" +
      "蒲州刺史上轻车都尉丹阳县开国侯真卿以清酌庶羞祭于亡侄赠赞善大夫季明之灵" +
      "惟尔挺生夙标幼德宗庙瑚琏阶庭兰玉每慰人心方期戬谷何图逆贼间衅称兵犯顺" +
      "尔父竭诚常山作郡余时受命亦在平原仁兄爱我俾尔传言尔既归止爰开土门土门既开" +
      "凶威大蹙贼臣不救孤城围逼父陷子死巢倾卵覆天不悔祸谁为荼毒念尔遘残百身何赎",
  },
  hanshitie: {
    name: "黄州寒食帖",
    chars:
      "自我来黄州已过三寒食年年欲惜春春去不容惜今年又苦雨两月秋萧瑟卧闻海棠花" +
      "泥污燕支雪暗中偷负去夜半真有力何殊病少年病起头已白春江欲入户雨势来不已" +
      "小屋如渔舟濛濛水云里空庖煮寒菜破灶烧湿苇那知是寒食但见乌衔纸君门深九重" +
      "坟墓在万里也拟哭途穷死灰吹不起",
  },
};

export const HANZI_MATRIX_CONFIG_STORAGE_KEY = "qingagent:hanzi-matrix-config";

export const MIN_HANZI_HI_RATIO = 0;
export const MAX_HANZI_HI_RATIO = 0.8;
/** 单次脉冲基础时长区间(s),实际时长 = 区间随机 × speed。 */
export const HANZI_PULSE_DURATION_MIN_S = 2.8;
export const HANZI_PULSE_DURATION_MAX_S = 5.9;
export const MIN_HANZI_SPEED = 0.4;
export const MAX_HANZI_SPEED = 3;
export const MIN_HANZI_BASE_ALPHA = 0.02;
export const MAX_HANZI_BASE_ALPHA = 0.6;
export const MIN_HANZI_HI_ALPHA = 0.1;
export const MAX_HANZI_HI_ALPHA = 1;
export const MIN_HANZI_CELL = 28;
export const MAX_HANZI_CELL = 72;
export const MIN_HANZI_MASK_STRENGTH = 0;
export const MAX_HANZI_MASK_STRENGTH = 1;
export const MIN_HANZI_MASK_WIDTH = 20;
export const MAX_HANZI_MASK_WIDTH = 100;
export const MIN_HANZI_MASK_HEIGHT = 20;
export const MAX_HANZI_MASK_HEIGHT = 100;
export const MIN_HANZI_MASK_BLUR = 0;
export const MAX_HANZI_MASK_BLUR = 8;

// 默认参数 = 2026-06-12 用户在面板上调定的一组:
// 节奏放最慢(满屏字缓慢呼吸)、42px 格子、低透明度、兰亭集序字符池,
// 中央 82%×80% 椭圆蒙版 + 2.5px 模糊把内容区让出来。
export const DEFAULT_HANZI_MATRIX_CONFIG: HanziMatrixConfig = {
  enabled: true,
  preset: "xuanqing",
  hiRatio: 0.3,
  speed: 3,
  baseAlpha: 0.1,
  hiAlpha: 1,
  cell: 42,
  pool: "lanting",
  maskStrength: 0.8,
  maskWidth: 82,
  maskHeight: 80,
  maskBlur: 2.5,
};

type Listener = (config: HanziMatrixConfig) => void;

let hydrated = false;
let currentConfig = DEFAULT_HANZI_MATRIX_CONFIG;
const listeners = new Set<Listener>();

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** 数值字段统一清洗:非法回落默认,合法夹进区间(0 是合法值,不能用 || 兜底)。 */
function sanitizeNumber(raw: unknown, fallback: number, min: number, max: number): number {
  const value = Number(raw);
  return clamp(Number.isFinite(value) ? value : fallback, min, max);
}

function sanitize(raw: Partial<HanziMatrixConfig>): HanziMatrixConfig {
  const base = { ...DEFAULT_HANZI_MATRIX_CONFIG, ...raw };
  return {
    enabled: Boolean(base.enabled),
    preset: base.preset in HANZI_MATRIX_PRESETS ? base.preset : DEFAULT_HANZI_MATRIX_CONFIG.preset,
    hiRatio: sanitizeNumber(
      base.hiRatio,
      DEFAULT_HANZI_MATRIX_CONFIG.hiRatio,
      MIN_HANZI_HI_RATIO,
      MAX_HANZI_HI_RATIO,
    ),
    speed: clamp(Number(base.speed) || DEFAULT_HANZI_MATRIX_CONFIG.speed, MIN_HANZI_SPEED, MAX_HANZI_SPEED),
    baseAlpha: clamp(
      Number(base.baseAlpha) || DEFAULT_HANZI_MATRIX_CONFIG.baseAlpha,
      MIN_HANZI_BASE_ALPHA,
      MAX_HANZI_BASE_ALPHA,
    ),
    hiAlpha: sanitizeNumber(
      base.hiAlpha,
      DEFAULT_HANZI_MATRIX_CONFIG.hiAlpha,
      MIN_HANZI_HI_ALPHA,
      MAX_HANZI_HI_ALPHA,
    ),
    cell: clamp(Math.round(Number(base.cell) || DEFAULT_HANZI_MATRIX_CONFIG.cell), MIN_HANZI_CELL, MAX_HANZI_CELL),
    pool: base.pool in HANZI_MATRIX_POOLS ? base.pool : DEFAULT_HANZI_MATRIX_CONFIG.pool,
    maskStrength: sanitizeNumber(
      base.maskStrength,
      DEFAULT_HANZI_MATRIX_CONFIG.maskStrength,
      MIN_HANZI_MASK_STRENGTH,
      MAX_HANZI_MASK_STRENGTH,
    ),
    maskWidth: sanitizeNumber(
      base.maskWidth,
      DEFAULT_HANZI_MATRIX_CONFIG.maskWidth,
      MIN_HANZI_MASK_WIDTH,
      MAX_HANZI_MASK_WIDTH,
    ),
    maskHeight: sanitizeNumber(
      base.maskHeight,
      DEFAULT_HANZI_MATRIX_CONFIG.maskHeight,
      MIN_HANZI_MASK_HEIGHT,
      MAX_HANZI_MASK_HEIGHT,
    ),
    maskBlur: sanitizeNumber(
      base.maskBlur,
      DEFAULT_HANZI_MATRIX_CONFIG.maskBlur,
      MIN_HANZI_MASK_BLUR,
      MAX_HANZI_MASK_BLUR,
    ),
  };
}

function hydrate(): void {
  if (hydrated) return;
  hydrated = true;
  try {
    const raw = window.localStorage.getItem(HANZI_MATRIX_CONFIG_STORAGE_KEY);
    if (raw) currentConfig = sanitize(JSON.parse(raw) as Partial<HanziMatrixConfig>);
  } catch {
    // 存储不可用/损坏:保持默认
  }
}

export function getHanziMatrixConfig(): HanziMatrixConfig {
  hydrate();
  return currentConfig;
}

export function setHanziMatrixConfig(patch: Partial<HanziMatrixConfig>): HanziMatrixConfig {
  hydrate();
  currentConfig = sanitize({ ...currentConfig, ...patch });
  try {
    window.localStorage.setItem(HANZI_MATRIX_CONFIG_STORAGE_KEY, JSON.stringify(currentConfig));
  } catch {
    // 写入失败不致命
  }
  for (const listener of listeners) listener(currentConfig);
  return currentConfig;
}

export function subscribeHanziMatrixConfig(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
