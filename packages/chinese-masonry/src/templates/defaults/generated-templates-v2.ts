import { CARD_WIDTH } from '../../constants';
import type { ImageElement, LineElement, TemplateDefinition, TemplateElement, TemplateMeta, TextElement } from '../types';
import { generatedCardAssetsV2 } from './generated-assets-v2';

type LayoutName =
  | 'topBanner'
  | 'sideLeft'
  | 'sideRight'
  | 'diagonalHero'
  | 'quotePoster'
  | 'splitNote'
  | 'whiteNote'
  | 'longScroll'
  | 'bottomWash'
  | 'magazineBlock';

interface TemplateSeed {
  name: string;
  slug: string;
  layout: LayoutName;
  titleTone: string;
  bodyTone: string;
  lineTone: string;
  background: string;
  tag: string;
}

const wideAssets = [
  generatedCardAssetsV2.wide01,
  generatedCardAssetsV2.wide02,
  generatedCardAssetsV2.wide03,
  generatedCardAssetsV2.wide04,
  generatedCardAssetsV2.wide05,
  generatedCardAssetsV2.wide06,
  generatedCardAssetsV2.wide07,
  generatedCardAssetsV2.wide08,
  generatedCardAssetsV2.wide09,
  generatedCardAssetsV2.wide10,
  generatedCardAssetsV2.wide11,
  generatedCardAssetsV2.wide12,
  generatedCardAssetsV2.wide13,
  generatedCardAssetsV2.wide14,
  generatedCardAssetsV2.wide15,
  generatedCardAssetsV2.wide16,
  generatedCardAssetsV2.wide17,
  generatedCardAssetsV2.wide18,
  generatedCardAssetsV2.wide19,
  generatedCardAssetsV2.wide20,
];

const tallAssets = [
  generatedCardAssetsV2.tall01,
  generatedCardAssetsV2.tall02,
  generatedCardAssetsV2.tall03,
  generatedCardAssetsV2.tall04,
  generatedCardAssetsV2.tall05,
  generatedCardAssetsV2.tall06,
  generatedCardAssetsV2.tall07,
  generatedCardAssetsV2.tall08,
  generatedCardAssetsV2.tall09,
  generatedCardAssetsV2.tall10,
  generatedCardAssetsV2.tall11,
  generatedCardAssetsV2.tall12,
  generatedCardAssetsV2.tall13,
  generatedCardAssetsV2.tall14,
  generatedCardAssetsV2.tall15,
  generatedCardAssetsV2.tall16,
  generatedCardAssetsV2.tall17,
  generatedCardAssetsV2.tall18,
  generatedCardAssetsV2.tall19,
  generatedCardAssetsV2.tall20,
];

const paperAssets = [
  generatedCardAssetsV2.paper01,
  generatedCardAssetsV2.paper02,
  generatedCardAssetsV2.paper03,
  generatedCardAssetsV2.paper04,
  generatedCardAssetsV2.paper05,
  generatedCardAssetsV2.paper06,
  generatedCardAssetsV2.paper07,
  generatedCardAssetsV2.paper08,
  generatedCardAssetsV2.paper09,
  generatedCardAssetsV2.paper10,
  generatedCardAssetsV2.paper11,
  generatedCardAssetsV2.paper12,
  generatedCardAssetsV2.paper13,
  generatedCardAssetsV2.paper14,
  generatedCardAssetsV2.paper15,
  generatedCardAssetsV2.paper16,
  generatedCardAssetsV2.paper17,
  generatedCardAssetsV2.paper18,
  generatedCardAssetsV2.paper19,
  generatedCardAssetsV2.paper20,
  generatedCardAssetsV2.paper21,
  generatedCardAssetsV2.paper22,
  generatedCardAssetsV2.paper23,
  generatedCardAssetsV2.paper24,
];

const objectAssets = [
  generatedCardAssetsV2.object01,
  generatedCardAssetsV2.object02,
  generatedCardAssetsV2.object03,
  generatedCardAssetsV2.object04,
  generatedCardAssetsV2.object05,
  generatedCardAssetsV2.object06,
  generatedCardAssetsV2.object07,
  generatedCardAssetsV2.object08,
  generatedCardAssetsV2.object09,
  generatedCardAssetsV2.object10,
  generatedCardAssetsV2.object11,
  generatedCardAssetsV2.object12,
  generatedCardAssetsV2.object13,
  generatedCardAssetsV2.object14,
  generatedCardAssetsV2.object15,
  generatedCardAssetsV2.object16,
  generatedCardAssetsV2.object17,
  generatedCardAssetsV2.object18,
  generatedCardAssetsV2.object19,
  generatedCardAssetsV2.object20,
];

const allAssets = [...wideAssets, ...tallAssets, ...paperAssets, ...objectAssets];

const titleTones = ['#1f1a16', '#183244', '#27342f', '#302019', '#3c3327'];
const bodyTones = [
  'rgba(31, 26, 22, 0.64)',
  'rgba(24, 50, 68, 0.66)',
  'rgba(39, 52, 47, 0.64)',
  'rgba(48, 32, 25, 0.62)',
  'rgba(60, 51, 39, 0.62)',
];
const lineTones = [
  'rgba(154, 55, 39, 0.42)',
  'rgba(24, 50, 68, 0.34)',
  'rgba(88, 105, 91, 0.42)',
  'rgba(112, 88, 58, 0.36)',
  'rgba(31, 26, 22, 0.25)',
];
const backgrounds = ['#fbf8f1', '#fcfaf6', '#f7f3ec', '#fdfbf8', '#f5f1e9'];
const seeds: TemplateSeed[] = [
  ['云台斜景', 'cloud-terrace', 'topBanner', '山水'],
  ['竹影侧笺', 'bamboo-side-note', 'sideLeft', '竹影'],
  ['茶盏右题', 'tea-right-title', 'sideRight', '器物'],
  ['折扇斜裁', 'fan-diagonal', 'diagonalHero', '折扇'],
  ['引号白章', 'quote-white-chapter', 'quotePoster', '引号'],
  ['旧卷短札', 'scroll-brief', 'splitNote', '书卷'],
  ['月窗便签', 'moon-window-note', 'whiteNote', '留白'],
  ['长卷竖记', 'scroll-vertical', 'longScroll', '竖排'],
  ['荷影下沿', 'lotus-bottom-edge', 'bottomWash', '荷影'],
  ['器物杂志', 'object-magazine', 'magazineBlock', '器物'],
  ['远山横笺', 'far-mountain-strip', 'topBanner', '山形'],
  ['石案左影', 'stone-left-shadow', 'sideLeft', '石影'],
  ['梅枝右章', 'plum-right-note', 'sideRight', '枝影'],
  ['檐角斜入', 'eave-diagonal', 'diagonalHero', '檐角'],
  ['大引留白', 'large-quote-space', 'quotePoster', '引号'],
  ['园门短记', 'garden-gate-note', 'splitNote', '园门'],
  ['素纸一则', 'plain-paper-note', 'whiteNote', '素纸'],
  ['烟线长题', 'incense-long-title', 'longScroll', '香烟'],
  ['水纹下章', 'water-bottom-mark', 'bottomWash', '水纹'],
  ['书桌块面', 'desk-blocks', 'magazineBlock', '书桌'],
  ['扇骨横幅', 'fan-rib-banner', 'topBanner', '扇骨'],
  ['兰枝左栏', 'orchid-left-column', 'sideLeft', '兰枝'],
  ['瓷瓶右记', 'vase-right-note', 'sideRight', '瓷瓶'],
  ['山石破框', 'stone-break-frame', 'diagonalHero', '山石'],
  ['半句引文', 'half-quote', 'quotePoster', '引文'],
  ['纸脊短篇', 'paper-spine-brief', 'splitNote', '纸脊'],
  ['淡墨便笺', 'pale-ink-note', 'whiteNote', '淡墨'],
  ['竹窗竖笺', 'bamboo-window-scroll', 'longScroll', '竹窗'],
  ['芦苇下沿', 'reed-bottom-edge', 'bottomWash', '芦苇'],
  ['月洞块面', 'moon-gate-block', 'magazineBlock', '月洞'],
  ['溪山横记', 'river-mountain-note', 'topBanner', '溪山'],
  ['笔锋左题', 'brush-left-title', 'sideLeft', '笔锋'],
  ['香炉右笺', 'incense-right-note', 'sideRight', '香炉'],
  ['书页斜光', 'book-diagonal-light', 'diagonalHero', '书页'],
  ['开卷引号', 'open-book-quote', 'quotePoster', '开卷'],
  ['茶影短章', 'tea-shadow-brief', 'splitNote', '茶影'],
  ['白瓷便签', 'porcelain-note', 'whiteNote', '白瓷'],
  ['山门竖幅', 'mountain-door-scroll', 'longScroll', '山门'],
  ['纸纹下记', 'paper-bottom-note', 'bottomWash', '纸纹'],
  ['枝影杂志', 'branch-magazine', 'magazineBlock', '枝影'],
  ['水院横幅', 'water-yard-banner', 'topBanner', '水院'],
  ['卷轴左栏', 'scroll-left-column', 'sideLeft', '卷轴'],
  ['松石右题', 'pine-stone-right', 'sideRight', '松石'],
  ['茶案斜面', 'tea-table-diagonal', 'diagonalHero', '茶案'],
  ['静白引题', 'quiet-white-quote', 'quotePoster', '静白'],
  ['山窗短记', 'mountain-window-brief', 'splitNote', '山窗'],
  ['水岸便条', 'shore-note', 'whiteNote', '水岸'],
  ['云崖竖记', 'cliff-scroll', 'longScroll', '云崖'],
  ['窗影下沿', 'window-bottom-edge', 'bottomWash', '窗影'],
  ['素章块面', 'plain-blocks', 'magazineBlock', '素章'],
].map(([name, slug, layout, tag], index) => ({
  name,
  slug,
  layout: layout as LayoutName,
  tag,
  titleTone: titleTones[index % titleTones.length],
  bodyTone: bodyTones[index % bodyTones.length],
  lineTone: lineTones[index % lineTones.length],
  background: backgrounds[index % backgrounds.length],
}));


function meta(seed: TemplateSeed, index: number, overrides: Partial<TemplateMeta> = {}): TemplateMeta {
  return {
    category: '生成模板二期',
    tags: ['生成素材', '真实器物', '现代东方', seed.tag],
    requiresImage: false,
    preferVerticalText: seed.layout === 'sideRight' || seed.layout === 'quotePoster' || seed.layout === 'longScroll',
    maxTitleLength: seed.layout === 'quotePoster' || seed.layout === 'sideRight' ? 9 : 16,
    weight: 8 + (index % 3),
    ...overrides,
  };
}

function pick<T>(items: T[], index: number, offset = 0): T {
  return items[(index * 11 + offset) % items.length];
}

function image(
  id: string,
  staticUrl: string,
  x: number,
  y: number,
  width: number,
  height: number,
  overrides: Partial<ImageElement> = {},
): ImageElement {
  return {
    id,
    type: 'image',
    source: 'static',
    staticUrl,
    x,
    y,
    width,
    height,
    objectFit: 'cover',
    objectPosition: '50% 50%',
    opacity: 1,
    shape: 'rectangle',
    zIndex: 1,
    ...overrides,
  };
}

function text(
  id: string,
  role: TextElement['role'],
  x: number,
  y: number,
  width: number,
  height: number,
  overrides: Partial<TextElement> = {},
): TextElement {
  return {
    id,
    type: 'text',
    role,
    x,
    y,
    width,
    height,
    fontSize: role === 'title' ? 21 : role === 'description' ? 14 : 64,
    color: role === 'decoration' ? 'rgba(160, 92, 62, 0.18)' : '#1f1a16',
    direction: 'horizontal',
    fontWeight: role === 'description' ? 'normal' : 'bold',
    letterSpacing: 0,
    lineHeight: role === 'decoration' ? 1 : 1.6,
    maxLines: 1,
    textAlign: 'left',
    ...overrides,
  };
}

function title(x: number, y: number, width: number, seed: TemplateSeed, overrides: Partial<TextElement> = {}) {
  return text('title', 'title', x, y, width, 54, {
    color: seed.titleTone,
    fontSize: overrides.direction === 'vertical' ? 22 : 21,
    fontWeight: 'bold',
    lineHeight: overrides.direction === 'vertical' ? 1.72 : 1.42,
    maxLines: overrides.direction === 'vertical' ? 4 : 2,
    ...overrides,
  });
}

function desc(x: number, y: number, width: number, seed: TemplateSeed, overrides: Partial<TextElement> = {}) {
  return text('desc', 'description', x, y, width, 78, {
    color: seed.bodyTone,
    fontSize: overrides.direction === 'vertical' ? 14 : 14,
    lineHeight: overrides.direction === 'vertical' ? 1.9 : 1.78,
    maxLines: overrides.direction === 'vertical' ? 7 : 3,
    ...overrides,
  });
}

function quote(id: string, content: string, x: number, y: number, seed: TemplateSeed, overrides: Partial<TextElement> = {}) {
  return text(id, 'decoration', x, y, 82, 92, {
    content,
    color: seed.lineTone.replace(/0\.\d+\)$/, '0.18)'),
    fontSize: 86,
    lineHeight: 1,
    maxLines: 1,
    ...overrides,
  });
}

function line(
  id: string,
  x: number,
  y: number,
  length: number,
  seed: TemplateSeed,
  direction: 'horizontal' | 'vertical' = 'horizontal',
  overrides: Partial<LineElement> = {},
): LineElement {
  return {
    id,
    type: 'line',
    x,
    y,
    length,
    direction,
    thickness: 0.5,
    color: seed.lineTone,
    zIndex: 10,
    ...overrides,
  };
}

function paper(seed: TemplateSeed, index: number, height: number, opacity = 0.92) {
  return image('paper-bg', pick(paperAssets, index, 3), 0, 0, CARD_WIDTH, height, {
    opacity,
    zIndex: 0,
  });
}

function buildTopBanner(seed: TemplateSeed, index: number): TemplateDefinition {
  const height = 308 + (index % 2) * 18;
  const clip = index % 2 === 0 ? 'polygon(0 0, 100% 0, 100% 82%, 0 100%)' : 'polygon(0 0, 100% 0, 94% 100%, 0 86%)';
  const elements: TemplateElement[] = [
    paper(seed, index, height, 0.74),
    image('wide-hero', pick(wideAssets, index), -6, -2, 302, 136, {
      shape: 'trapezoid',
      clipPath: clip,
      objectPosition: `${48 + (index % 4) * 6}% 48%`,
    }),
    quote('quote-mark', '“', 18, 126, seed, { fontSize: 72, color: 'rgba(154, 55, 39, 0.14)' }),
    title(28, 164, 220, seed),
    desc(28, 222, 214, seed, { maxLines: 2 }),
    line('short-rule', 228, 282, 34 + (index % 4) * 8, seed, 'horizontal'),
    line('seal-rule', 254, height - 44, 18, seed, 'vertical'),
  ];
  return baseTemplate(seed, index, height, elements, { maxTitleLength: 14 });
}

function buildSideLeft(seed: TemplateSeed, index: number): TemplateDefinition {
  const height = 332 + (index % 3) * 14;
  const elements: TemplateElement[] = [
    paper(seed, index, height, 0.98),
    image('left-strip', pick(tallAssets, index), -10, -8, 104, height + 16, {
      objectPosition: '50% 50%',
      opacity: 0.92,
      shape: index % 2 === 0 ? 'trapezoid' : 'rectangle',
      clipPath: index % 2 === 0 ? 'polygon(0 0, 100% 0, 84% 100%, 0 100%)' : undefined,
    }),
    line('top-rule', 126, 38, 70 + (index % 5) * 10, seed),
    title(126, 70, 126, seed, { maxLines: 2 }),
    desc(126, 128, 120, seed, { maxLines: 4 }),
    line('bottom-rule', 126, height - 58, 58 + (index % 4) * 12, seed),
    line('side-rule', 252, 54, height - 116, seed, 'vertical', { thickness: 1, color: 'rgba(31, 26, 22, 0.20)' }),
  ];
  return baseTemplate(seed, index, height, elements, { maxTitleLength: 13 });
}

function buildSideRight(seed: TemplateSeed, index: number): TemplateDefinition {
  const height = 342 + (index % 2) * 24;
  const elements: TemplateElement[] = [
    paper(seed, index, height, 0.98),
    image('right-strip', pick(tallAssets, index, 7), 190, -6, 110, height + 12, {
      shape: 'trapezoid',
      clipPath: 'polygon(12% 0, 100% 0, 100% 100%, 0 88%)',
      objectPosition: '50% 50%',
      opacity: 0.94,
    }),
    title(120, 42, 58, seed, { direction: 'vertical', height: 158, letterSpacing: 3, maxLines: 4 }),
    desc(50, 48, 62, seed, { direction: 'vertical', height: 198, letterSpacing: 1, maxLines: 7 }),
    line('right-rule', 174, 38, height - 94, seed, 'vertical', { thickness: 1, color: 'rgba(24, 50, 68, 0.24)' }),
    line('bottom-rule', 60, height - 52, 42 + (index % 4) * 8, seed),
    quote('small-quote', '”', 18, height - 128, seed, { fontSize: 62, color: 'rgba(154, 55, 39, 0.12)' }),
  ];
  return baseTemplate(seed, index, height, elements, { preferVerticalText: true, maxTitleLength: 8 });
}

function buildDiagonalHero(seed: TemplateSeed, index: number): TemplateDefinition {
  const height = 248 + (index % 3) * 18;
  const elements: TemplateElement[] = [
    paper(seed, index, height, 0.9),
    image('diagonal-image', pick(objectAssets, index), 120, -16, 188, height + 32, {
      shape: 'trapezoid',
      clipPath: 'polygon(24% 0, 100% 0, 100% 100%, 0 100%)',
      objectPosition: '50% 50%',
      opacity: 0.96,
    }),
    quote('quote-mark', '“', 18, 24, seed, { fontSize: 70, color: 'rgba(112, 88, 58, 0.14)' }),
    title(24, 54, 138, seed, { maxLines: 2 }),
    desc(24, 116, 128, seed, { maxLines: 3 }),
    line('diagonal-rule-a', 24, height - 42, 72 + (index % 5) * 10, seed),
    line('diagonal-rule-b', 102, 28, 44, seed, 'vertical', { thickness: 1, color: 'rgba(31, 26, 22, 0.18)' }),
  ];
  return baseTemplate(seed, index, height, elements, { maxTitleLength: 12 });
}

function buildQuotePoster(seed: TemplateSeed, index: number): TemplateDefinition {
  const height = 380 + (index % 2) * 24;
  const elements: TemplateElement[] = [
    paper(seed, index, height, 1),
    image('object-corner', pick(objectAssets, index, 5), 0, height - 112, 170, 112, {
      opacity: 0.78,
      objectPosition: '50% 50%',
      shape: 'trapezoid',
      clipPath: 'polygon(0 18%, 100% 0, 82% 100%, 0 100%)',
    }),
    quote('quote-mark', '“', 24, 34, seed, { fontSize: 96, color: 'rgba(154, 55, 39, 0.20)' }),
    title(174, 58, 52, seed, { direction: 'vertical', height: 178, letterSpacing: 4, maxLines: 5 }),
    desc(98, 72, 58, seed, { direction: 'vertical', height: 196, letterSpacing: 1, maxLines: 7 }),
    line('thin-rule', 238, 54, 184, seed, 'vertical', { thickness: 1, color: 'rgba(31, 26, 22, 0.22)' }),
    line('bottom-rule', 210, height - 68, 36, seed, 'vertical'),
  ];
  return baseTemplate(seed, index, height, elements, { preferVerticalText: true, maxTitleLength: 8 });
}

function buildSplitNote(seed: TemplateSeed, index: number): TemplateDefinition {
  const height = 206 + (index % 2) * 16;
  const elements: TemplateElement[] = [
    paper(seed, index, height, 0.9),
    image('right-photo', pick(wideAssets, index, 5), 150, 0, 140, height, {
      objectPosition: '56% 50%',
      shape: index % 2 === 0 ? 'trapezoid' : 'rectangle',
      clipPath: index % 2 === 0 ? 'polygon(14% 0, 100% 0, 100% 100%, 0 100%)' : undefined,
    }),
    title(22, 30, 122, seed, { maxLines: 2 }),
    desc(22, 86, 116, seed, { maxLines: 3 }),
    line('note-rule', 22, height - 40, 30 + (index % 5) * 12, seed),
  ];
  return baseTemplate(seed, index, height, elements, { maxTitleLength: 10 });
}

function buildWhiteNote(seed: TemplateSeed, index: number): TemplateDefinition {
  const height = 190 + (index % 3) * 18;
  const elements: TemplateElement[] = [
    paper(seed, index, height, 1),
    image('corner-object', pick(objectAssets, index, 11), 182, height - 108, 122, 116, {
      opacity: 0.58,
      objectPosition: '50% 50%',
      shape: 'trapezoid',
      clipPath: 'polygon(0 0, 100% 12%, 100% 100%, 16% 100%)',
    }),
    line('top-rule', 24, 28, 92 + (index % 4) * 14, seed, 'horizontal', { thickness: 1 }),
    title(24, 60, 184, seed, { maxLines: 1, fontSize: 20 }),
    desc(24, 104, 164, seed, { maxLines: 2 }),
    quote('small-quote', '“', 218, 28, seed, { fontSize: 54, color: 'rgba(154, 55, 39, 0.10)' }),
  ];
  return baseTemplate(seed, index, height, elements, { maxTitleLength: 12 });
}

function buildLongScroll(seed: TemplateSeed, index: number): TemplateDefinition {
  const height = 412 + (index % 2) * 32;
  const elements: TemplateElement[] = [
    paper(seed, index, height, 1),
    image('scroll-wash', pick(tallAssets, index, 13), -8, -10, 128, height + 20, {
      opacity: 0.72,
      objectPosition: '50% 50%',
      shape: 'trapezoid',
      clipPath: 'polygon(0 0, 100% 8%, 88% 100%, 0 100%)',
    }),
    image('object-mark', pick(objectAssets, index, 2), 208, 0, 82, height, {
      opacity: 0.2,
      objectPosition: '50% 50%',
    }),
    title(172, 48, 58, seed, { direction: 'vertical', height: 190, letterSpacing: 4, maxLines: 5 }),
    desc(96, 56, 58, seed, { direction: 'vertical', height: 232, letterSpacing: 1, maxLines: 8 }),
    line('right-rule', 244, 46, height - 120, seed, 'vertical', { thickness: 1, color: 'rgba(24, 50, 68, 0.22)' }),
    line('seal-rule', 224, height - 76, 32, seed, 'vertical'),
  ];
  return baseTemplate(seed, index, height, elements, { preferVerticalText: true, maxTitleLength: 8 });
}

function buildBottomWash(seed: TemplateSeed, index: number): TemplateDefinition {
  const height = 286 + (index % 3) * 14;
  const elements: TemplateElement[] = [
    paper(seed, index, height, 0.96),
    image('bottom-image', pick(wideAssets, index, 9), -6, height - 120, 302, 128, {
      objectPosition: '50% 60%',
      opacity: 0.86,
      shape: 'trapezoid',
      clipPath: 'polygon(0 16%, 100% 0, 100% 100%, 0 100%)',
    }),
    quote('quote-mark', '“', 190, 26, seed, { fontSize: 72, color: 'rgba(154, 55, 39, 0.12)' }),
    title(24, 42, 176, seed, { maxLines: 2 }),
    desc(24, 104, 164, seed, { maxLines: 3 }),
    line('center-rule', 24, 176, 88 + (index % 5) * 8, seed),
    line('side-rule', 246, 38, 86, seed, 'vertical', { thickness: 1, color: 'rgba(31, 26, 22, 0.18)' }),
  ];
  return baseTemplate(seed, index, height, elements, { maxTitleLength: 13 });
}

function buildMagazineBlock(seed: TemplateSeed, index: number): TemplateDefinition {
  const height = 300 + (index % 2) * 20;
  const elements: TemplateElement[] = [
    paper(seed, index, height, 1),
    image('main-block', pick(objectAssets, index, 3), 152, 0, 138, 174, {
      objectPosition: '50% 50%',
      opacity: 0.94,
      shape: 'trapezoid',
      clipPath: 'polygon(10% 0, 100% 0, 100% 100%, 0 88%)',
    }),
    image('wash-block', pick(wideAssets, index, 14), 0, 192, 188, height - 192, {
      objectPosition: '50% 50%',
      opacity: 0.66,
      shape: 'trapezoid',
      clipPath: 'polygon(0 0, 100% 16%, 84% 100%, 0 100%)',
    }),
    title(24, 36, 122, seed, { maxLines: 2 }),
    desc(24, 96, 112, seed, { maxLines: 3 }),
    line('block-rule', 210, 200, 54 + (index % 3) * 16, seed, 'horizontal'),
    quote('small-quote', '”', 214, 126, seed, { fontSize: 56, color: 'rgba(112, 88, 58, 0.12)' }),
  ];
  return baseTemplate(seed, index, height, elements, { maxTitleLength: 11 });
}

function baseTemplate(
  seed: TemplateSeed,
  index: number,
  height: number,
  elements: TemplateElement[],
  metaOverrides: Partial<TemplateMeta> = {},
): TemplateDefinition {
  const accent = image(
    'faint-accent',
    pick(allAssets, index, 19),
    index % 2 === 0 ? -26 : 174,
    index % 3 === 0 ? 10 : height - 126,
    138,
    118,
    {
      opacity: 0.08,
      zIndex: 0.5,
      shape: 'trapezoid',
      clipPath: index % 2 === 0 ? 'polygon(0 0, 100% 12%, 84% 100%, 0 100%)' : 'polygon(16% 0, 100% 0, 100% 100%, 0 88%)',
    },
  );
  const texture = image('paper-texture-mark', pick(allAssets, index, 47), index % 2 === 0 ? 202 : -24, 22, 96, 92, {
    opacity: 0.05,
    zIndex: 0.25,
    objectPosition: '50% 50%',
  });

  return {
    id: `gen2-${seed.slug}`,
    name: seed.name,
    version: 1,
    width: CARD_WIDTH,
    height,
    backgroundColor: seed.background,
    borderRadius: index % 5 === 0 ? '4px' : index % 4 === 0 ? '8px' : '6px',
    elements: [texture, accent, ...elements],
    meta: meta(seed, index, metaOverrides),
  };
}

const builders: Record<LayoutName, (seed: TemplateSeed, index: number) => TemplateDefinition> = {
  topBanner: buildTopBanner,
  sideLeft: buildSideLeft,
  sideRight: buildSideRight,
  diagonalHero: buildDiagonalHero,
  quotePoster: buildQuotePoster,
  splitNote: buildSplitNote,
  whiteNote: buildWhiteNote,
  longScroll: buildLongScroll,
  bottomWash: buildBottomWash,
  magazineBlock: buildMagazineBlock,
};

export const generatedTemplatesV2: TemplateDefinition[] = seeds.map((seed, index) => builders[seed.layout](seed, index));
