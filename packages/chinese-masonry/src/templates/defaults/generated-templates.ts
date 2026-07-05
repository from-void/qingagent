import { CARD_WIDTH } from '../../constants';
import type { ImageElement, LineElement, TemplateDefinition, TemplateMeta, TextElement } from '../types';
import { generatedCardAssets } from './assets';

function meta(overrides: Partial<TemplateMeta> = {}): TemplateMeta {
  return {
    category: '生成模板',
    tags: ['生成素材', '纸感', '图文排版'],
    requiresImage: false,
    preferVerticalText: false,
    weight: 7,
    ...overrides,
  };
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

function title(
  x: number,
  y: number,
  width: number,
  height: number,
  overrides: Partial<TextElement> = {},
): TextElement {
  return {
    id: 'title',
    type: 'text',
    role: 'title',
    x,
    y,
    width,
    height,
    fontSize: overrides.direction === 'vertical' ? 22 : 21,
    color: '#1f1a16',
    direction: 'horizontal',
    fontWeight: 'bold',
    letterSpacing: 0,
    lineHeight: overrides.direction === 'vertical' ? 1.72 : 1.42,
    maxLines: 2,
    textAlign: 'left',
    ...overrides,
  };
}

function desc(
  x: number,
  y: number,
  width: number,
  height: number,
  overrides: Partial<TextElement> = {},
): TextElement {
  return {
    id: 'desc',
    type: 'text',
    role: 'description',
    x,
    y,
    width,
    height,
    fontSize: 14,
    color: 'rgba(31, 26, 22, 0.68)',
    direction: 'horizontal',
    fontWeight: 'normal',
    letterSpacing: 0,
    lineHeight: overrides.direction === 'vertical' ? 1.92 : 1.78,
    maxLines: overrides.direction === 'vertical' ? 7 : 4,
    textAlign: 'left',
    ...overrides,
  };
}

function line(
  id: string,
  x: number,
  y: number,
  length: number,
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
    color: 'rgba(154, 55, 39, 0.45)',
    zIndex: 5,
    ...overrides,
  };
}

export const generatedTemplates: TemplateDefinition[] = [
  {
    id: 'gen-mountain-draft',
    name: '云山评审稿',
    version: 1,
    width: CARD_WIDTH,
    height: 320,
    backgroundColor: '#f7f3eb',
    borderRadius: '6px',
    elements: [
      image('hero-mountain', generatedCardAssets.mountainWide, 0, 0, CARD_WIDTH, 138),
      title(22, 164, 246, 54),
      desc(22, 224, 236, 56),
      line('seal-line', 242, 288, 18, 'vertical'),
    ],
    meta: meta({ tags: ['山水', '横图', '评审'], weight: 8 }),
  },
  {
    id: 'gen-roof-brief',
    name: '亭檐短记',
    version: 1,
    width: CARD_WIDTH,
    height: 190,
    backgroundColor: '#fbf8f2',
    borderRadius: '6px',
    elements: [
      image('roof-side', generatedCardAssets.roofWide, 152, 0, 138, 190, {
        objectPosition: '22% 42%',
      }),
      image('paper-wash', generatedCardAssets.paperWhite, 0, 0, CARD_WIDTH, 190, {
        opacity: 0.62,
        zIndex: 0,
      }),
      title(22, 28, 126, 40),
      desc(22, 78, 118, 64, { maxLines: 3 }),
      line('seal-line', 24, 154, 16, 'vertical'),
    ],
    meta: meta({ tags: ['亭檐', '短记', '左右分栏'], maxTitleLength: 12, weight: 8 }),
  },
  {
    id: 'gen-book-split',
    name: '旧稿重读',
    version: 1,
    width: CARD_WIDTH,
    height: 240,
    backgroundColor: '#f8f4ed',
    borderRadius: '6px',
    elements: [
      image('scroll-photo', generatedCardAssets.scrollTall, 0, 0, 126, 240, {
        objectPosition: '44% 54%',
      }),
      image('paper-panel', generatedCardAssets.paperWhite, 126, 0, 164, 240, {
        opacity: 0.96,
        zIndex: 0,
      }),
      title(148, 62, 116, 52),
      desc(148, 126, 112, 62, { maxLines: 3 }),
      line('seal-line', 250, 196, 16, 'vertical'),
    ],
    meta: meta({ tags: ['书页', '分栏', '摄影'], weight: 8 }),
  },
  {
    id: 'gen-archive-vertical',
    name: '文档源整理',
    version: 1,
    width: CARD_WIDTH,
    height: 328,
    backgroundColor: '#faf8f3',
    borderRadius: '6px',
    elements: [
      image('paper-bg', generatedCardAssets.paperWhite, 0, 0, CARD_WIDTH, 328, {
        objectFit: 'cover',
        opacity: 0.96,
        zIndex: 0,
      }),
      image('desk-column', generatedCardAssets.deskWide, 156, 0, 134, 328, {
        objectPosition: '63% 44%',
      }),
      title(92, 42, 42, 166, {
        direction: 'vertical',
        letterSpacing: 4,
        maxLines: 5,
        lineHeight: 1.72,
      }),
      desc(24, 44, 52, 174, {
        direction: 'vertical',
        letterSpacing: 2,
        maxLines: 7,
      }),
      line('seal-line', 24, 266, 14, 'vertical'),
    ],
    meta: meta({ tags: ['竖排', '文档', '摄影分栏'], preferVerticalText: true, maxTitleLength: 9, weight: 8 }),
  },
  {
    id: 'gen-lake-checklist',
    name: '提笔前清单',
    version: 1,
    width: CARD_WIDTH,
    height: 230,
    backgroundColor: '#fbf7f0',
    borderRadius: '6px',
    elements: [
      image('paper-bg', generatedCardAssets.paperWhite, 0, 0, CARD_WIDTH, 230, {
        opacity: 0.9,
        zIndex: 0,
      }),
      image('lotus-bottom', generatedCardAssets.lotusWide, 0, 118, CARD_WIDTH, 112, {
        objectPosition: '50% 72%',
        opacity: 0.92,
      }),
      title(22, 30, 226, 42),
      desc(22, 80, 214, 48, { maxLines: 2 }),
      line('seal-line', 236, 168, 16, 'vertical'),
    ],
    meta: meta({ tags: ['荷塘', '清单', '留白'], weight: 8 }),
  },
  {
    id: 'gen-bamboo-thinking',
    name: '系统边界思考',
    version: 1,
    width: CARD_WIDTH,
    height: 280,
    backgroundColor: '#fcfaf6',
    borderRadius: '6px',
    elements: [
      image('paper-bg', generatedCardAssets.paperWhite, 0, 0, CARD_WIDTH, 280, {
        opacity: 1,
        zIndex: 0,
      }),
      image('bamboo-strip', generatedCardAssets.bambooTall, 0, 0, 84, 280, {
        objectPosition: '18% 44%',
        opacity: 0.82,
      }),
      title(112, 34, 144, 58, { maxLines: 2 }),
      desc(112, 102, 136, 84, { maxLines: 4 }),
      line('ink-line', 112, 214, 72),
      line('seal-line', 236, 236, 14, 'vertical'),
    ],
    meta: meta({ tags: ['竹影', '纯白', '思考'], maxTitleLength: 12, weight: 8 }),
  },
  {
    id: 'gen-daily-desk',
    name: '每日一记',
    version: 1,
    width: CARD_WIDTH,
    height: 220,
    backgroundColor: '#f7f2ea',
    borderRadius: '6px',
    elements: [
      image('paper-bg', generatedCardAssets.paperWhite, 0, 0, CARD_WIDTH, 220, {
        opacity: 0.86,
        zIndex: 0,
      }),
      image('desk-strip', generatedCardAssets.deskStrip, 0, 132, CARD_WIDTH, 88, {
        objectPosition: '58% 62%',
      }),
      title(24, 30, 138, 38, { maxLines: 1 }),
      desc(24, 76, 126, 46, { maxLines: 2 }),
      line('seal-line', 244, 98, 14, 'vertical'),
    ],
    meta: meta({ tags: ['书桌', '短记', '摄影'], maxTitleLength: 8, weight: 8 }),
  },
  {
    id: 'gen-diagram-paper',
    name: '数据流草图',
    version: 1,
    width: CARD_WIDTH,
    height: 260,
    backgroundColor: '#fbf8f2',
    borderRadius: '6px',
    elements: [
      image('diagram-paper', generatedCardAssets.diagramWide, 0, 138, CARD_WIDTH, 122, {
        objectPosition: '62% 48%',
        opacity: 0.88,
      }),
      image('paper-bg', generatedCardAssets.paperWhite, 0, 0, CARD_WIDTH, 260, {
        opacity: 0.7,
        zIndex: 0,
      }),
      title(22, 28, 226, 42),
      desc(22, 76, 214, 54, { maxLines: 3 }),
      line('diagram-rule-a', 52, 198, 184, 'horizontal', {
        thickness: 1,
        color: 'rgba(31, 26, 22, 0.28)',
      }),
      line('seal-line', 240, 216, 14, 'vertical'),
    ],
    meta: meta({ tags: ['图纸', '流程', '结构'], weight: 7 }),
  },
  {
    id: 'gen-botany-plan',
    name: '技能沉淀计划',
    version: 1,
    width: CARD_WIDTH,
    height: 180,
    backgroundColor: '#fcfaf6',
    borderRadius: '6px',
    elements: [
      image('paper-bg', generatedCardAssets.paperWhite, 0, 0, CARD_WIDTH, 180, {
        opacity: 1,
        zIndex: 0,
      }),
      image('orchid-right', generatedCardAssets.orchidTall, 194, 0, 96, 180, {
        objectPosition: '34% 60%',
        opacity: 0.86,
      }),
      title(22, 28, 152, 36, { maxLines: 1 }),
      desc(22, 74, 146, 54, { maxLines: 3 }),
      line('seal-line', 24, 142, 14, 'vertical'),
    ],
    meta: meta({ tags: ['植物', '纯白', '短卡'], maxTitleLength: 10, weight: 7 }),
  },
  {
    id: 'gen-seal-column',
    name: '印栏札记',
    version: 1,
    width: CARD_WIDTH,
    height: 360,
    backgroundColor: '#fdfbf8',
    borderRadius: '6px',
    elements: [
      image('paper-bg', generatedCardAssets.paperNarrow, 0, 0, CARD_WIDTH, 360, {
        opacity: 1,
        zIndex: 0,
      }),
      title(176, 44, 44, 178, {
        direction: 'vertical',
        letterSpacing: 4,
        maxLines: 5,
      }),
      desc(88, 48, 64, 196, {
        direction: 'vertical',
        letterSpacing: 2,
        maxLines: 7,
      }),
      line('right-rule', 238, 42, 228, 'vertical', {
        color: 'rgba(31, 26, 22, 0.22)',
        thickness: 1,
      }),
      line('seal-line', 224, 284, 28, 'vertical'),
    ],
    meta: meta({ tags: ['竖排', '纯白', '留白'], preferVerticalText: true, maxTitleLength: 8, weight: 7 }),
  },
  {
    id: 'gen-pavilion-side',
    name: '侧栏亭影',
    version: 1,
    width: CARD_WIDTH,
    height: 250,
    backgroundColor: '#f8f4ed',
    borderRadius: '6px',
    elements: [
      image('roof-top', generatedCardAssets.roofWide, 0, 0, CARD_WIDTH, 108, {
        objectPosition: '26% 36%',
      }),
      title(24, 132, 136, 44),
      desc(24, 184, 138, 46, { maxLines: 2 }),
      image('mountain-side', generatedCardAssets.mountainTall, 194, 118, 96, 132, {
        objectPosition: '50% 54%',
        opacity: 0.74,
      }),
      line('seal-line', 24, 224, 14, 'vertical'),
    ],
    meta: meta({ tags: ['亭阁', '上下分区', '短文'], maxTitleLength: 10, weight: 7 }),
  },
  {
    id: 'gen-lotus-frame',
    name: '月下留白',
    version: 1,
    width: CARD_WIDTH,
    height: 300,
    backgroundColor: '#fbf8f2',
    borderRadius: '6px',
    elements: [
      image('paper-bg', generatedCardAssets.paperWhite, 0, 0, CARD_WIDTH, 300, {
        opacity: 0.94,
        zIndex: 0,
      }),
      image('mountain-side', generatedCardAssets.mountainTall, 0, 0, 92, 300, {
        objectPosition: '48% 54%',
        opacity: 0.7,
      }),
      image('lotus-bottom', generatedCardAssets.lotusWide, 92, 196, 198, 104, {
        objectPosition: '52% 72%',
        opacity: 0.82,
      }),
      line('top-rule', 122, 38, 94),
      title(122, 70, 132, 42, { maxLines: 1 }),
      desc(122, 122, 128, 64, { maxLines: 3 }),
      line('bottom-rule', 122, 244, 64),
    ],
    meta: meta({ tags: ['留白', '横排', '月色'], weight: 7 }),
  },
];
