import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import { defaultTemplates } from '../../templates/defaults';
import { withTemplateTextCapacity } from '../../templates/capacity';
import type {
  ArticleData,
  GlobalFontConfig,
  ImageElement,
  LineElement,
  TemplateDefinition,
  TemplateElement,
  TextElement,
} from '../../templates/types';
import { cloneTemplate, clamp, snapToGrid } from '../../utils';
import { CARD_WIDTH, DEFAULT_FONT_CONFIG } from '../../constants';
import { ricePaperSvg } from '../../templates/defaults/assets';
import { curatedStampAssets } from '../../templates/defaults/curated-assets';

export interface EditorStore {
  template: TemplateDefinition;
  selectedId: string | null;
  sampleArticle: ArticleData;
  fontConfig: GlobalFontConfig;
  past: TemplateDefinition[];
  future: TemplateDefinition[];
  exportedJson: string;
  loadTemplate: (template: TemplateDefinition, sampleArticle?: ArticleData) => void;
  createTemplate: () => void;
  selectElement: (id: string | null) => void;
  toggleContentElement: (role: 'hero' | 'title' | 'description' | 'stamp', visible: boolean) => void;
  addBackgroundImage: () => void;
  addLine: () => void;
  deleteElement: (id: string) => void;
  recordHistory: () => void;
  moveElement: (id: string, dx: number, dy: number) => void;
  moveElementTo: (id: string, x: number, y: number) => void;
  nudgeElement: (id: string, dx: number, dy: number) => void;
  resizeElement: (id: string, dx: number, dy: number) => void;
  resizeCardHeight: (dy: number) => void;
  updateElement: (id: string, patch: Partial<TemplateElement>) => void;
  updateCard: (patch: Partial<Pick<TemplateDefinition, 'height' | 'backgroundColor' | 'borderRadius'>>) => void;
  updateFontConfig: (patch: Partial<GlobalFontConfig>) => void;
  undo: () => void;
  redo: () => void;
  exportJson: () => void;
  importJson: (json: string) => void;
}

export const defaultSampleArticle: ArticleData = {
  id: 'sample',
  title: '春江花月夜',
  description: '春江潮水连海平，海上明月共潮生。滟滟随波千万里，何处春江无月明。',
  imageUrl:
    "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 580 360'%3E%3Cdefs%3E%3ClinearGradient id='g' x1='0' y1='0' x2='1' y2='1'%3E%3Cstop stop-color='%234a8c6f'/%3E%3Cstop offset='1' stop-color='%238ed4a8'/%3E%3C/linearGradient%3E%3C/defs%3E%3Crect width='580' height='360' fill='url(%23g)'/%3E%3Cpath d='M0 280 C120 180 220 240 300 150 C390 70 500 160 580 112 L580 360 L0 360Z' fill='%232c1810' opacity='.22'/%3E%3C/svg%3E",
  author: '示例作者',
  category: '水墨',
  tags: ['传统', '山水'],
};

function makeTitleElement(): TextElement {
  return {
    id: 'title',
    type: 'text',
    role: 'title',
    x: 20,
    y: 244,
    width: 250,
    height: 64,
    fontSize: 22,
    color: '#2c1810',
    direction: 'horizontal',
    fontWeight: 'bold',
    letterSpacing: 1,
    lineHeight: 1.4,
    maxLines: 2,
  };
}

function makeDescriptionElement(): TextElement {
  return {
    id: 'desc',
    type: 'text',
    role: 'description',
    x: 20,
    y: 316,
    width: 250,
    height: 90,
    fontSize: 14,
    color: '#7a6b5d',
    direction: 'horizontal',
    fontWeight: 'normal',
    letterSpacing: 0,
    lineHeight: 1.8,
    maxLines: 4,
  };
}

function makeHeroImageElement(): ImageElement {
  return {
    id: 'hero-image',
    type: 'image',
    source: 'dynamic',
    x: 18,
    y: 22,
    width: 254,
    height: 160,
    objectFit: 'cover',
    shape: 'trapezoid',
    clipPath: 'polygon(0 0, 100% 0, 92% 100%, 0 86%)',
    zIndex: 1,
  };
}

const sealPrompt =
  '朱文篆刻印章素材，四字为「空生妙有」，传统四字印章读法为右上空、右下生、左上妙、左下有，小篆风格，红印泥质感。';

function makeStampElement(): ImageElement {
  return {
    id: 'seal',
    type: 'image',
    role: 'stamp',
    source: 'static',
    staticUrl: curatedStampAssets.kongshengMiaoyou,
    prompt: sealPrompt,
    x: 238,
    y: 326,
    width: 30,
    height: 30,
    objectFit: 'contain',
    objectPosition: '50% 50%',
    opacity: 0.9,
    shape: 'rectangle',
    zIndex: 24,
  };
}

function findElement(template: TemplateDefinition, id: string): TemplateElement | undefined {
  return template.elements.find((element) => element.id === id);
}

function applyElementPosition(template: TemplateDefinition, element: TemplateElement, x: number, y: number) {
  if (element.type === 'image' || element.type === 'text') {
    element.x = clamp(x, -CARD_WIDTH, CARD_WIDTH - 8);
    element.y = clamp(y, -template.height, template.height - 8);
    return;
  }
  element.x = clamp(x, 0, CARD_WIDTH - 8);
  element.y = clamp(y, 0, template.height - 8);
}

function pushHistory(state: EditorStore) {
  state.past.push(cloneTemplate(state.template));
  state.future = [];
}

export const useEditorStore = create<EditorStore>()(
  immer((set) => ({
    template: cloneTemplate(defaultTemplates[0]),
    selectedId: 'title',
    sampleArticle: defaultSampleArticle,
    fontConfig: DEFAULT_FONT_CONFIG,
    past: [],
    future: [],
    exportedJson: '',

    loadTemplate: (template, sampleArticle) =>
      set((state) => {
        state.template = cloneTemplate(withTemplateTextCapacity(template));
        state.selectedId = state.template.elements.find((element) => element.type === 'text')?.id ?? null;
        state.sampleArticle = sampleArticle ?? defaultSampleArticle;
        state.past = [];
        state.future = [];
        state.exportedJson = '';
      }),

    createTemplate: () =>
      set((state) => {
        pushHistory(state);
        const next = cloneTemplate(withTemplateTextCapacity(defaultTemplates[0]));
        const suffix = Date.now().toString(36);
        next.id = `custom-${suffix}`;
        next.name = `自定义模板 ${suffix}`;
        state.template = next;
        state.selectedId = next.elements.find((element) => element.type === 'text')?.id ?? null;
        state.past = [];
        state.future = [];
        state.exportedJson = '';
      }),

    selectElement: (id) => set({ selectedId: id }),

    toggleContentElement: (role, visible) =>
      set((state) => {
        pushHistory(state);
        const matcher = (element: TemplateElement) => {
          if (role === 'hero') return element.type === 'image' && element.source === 'dynamic';
          if (role === 'stamp') return element.type === 'image' && element.role === 'stamp';
          return element.type === 'text' && element.role === role;
        };
        const exists = state.template.elements.some(matcher);
        if (!visible && exists) {
          state.template.elements = state.template.elements.filter((element) => !matcher(element));
          if (state.selectedId && !findElement(state.template, state.selectedId)) state.selectedId = null;
        }
        if (visible && !exists) {
          const element =
            role === 'hero'
              ? makeHeroImageElement()
              : role === 'title'
                ? makeTitleElement()
                : role === 'description'
                  ? makeDescriptionElement()
                  : makeStampElement();
          state.template.elements.push(element);
          state.selectedId = element.id;
        }
      }),

    addBackgroundImage: () =>
      set((state) => {
        pushHistory(state);
        const count = state.template.elements.filter(
          (element) => element.type === 'image' && element.source === 'static' && element.role !== 'stamp',
        ).length;
        const element: ImageElement = {
          id: `bg-${count + 1}`,
          type: 'image',
          role: 'background',
          source: 'static',
          staticUrl: ricePaperSvg,
          x: 16 + count * 8,
          y: 16 + count * 8,
          width: 258,
          height: 180,
          objectFit: 'cover',
          objectPosition: '50% 50%',
          shape: 'rectangle',
          zIndex: 0,
        };
        state.template.elements.push(element);
        state.selectedId = element.id;
      }),

    addLine: () =>
      set((state) => {
        pushHistory(state);
        const count = state.template.elements.filter((element) => element.type === 'line').length;
        const element: LineElement = {
          id: `line-${count + 1}`,
          type: 'line',
          x: 64,
          y: Math.floor(state.template.height / 2),
          length: 150,
          direction: 'horizontal',
          thickness: 0.5,
          color: 'rgba(139, 69, 19, 0.5)',
          zIndex: 10,
        };
        state.template.elements.push(element);
        state.selectedId = element.id;
      }),

    deleteElement: (id) =>
      set((state) => {
        pushHistory(state);
        state.template.elements = state.template.elements.filter((element) => element.id !== id);
        if (state.selectedId === id) state.selectedId = null;
      }),

    recordHistory: () =>
      set((state) => {
        pushHistory(state);
      }),

    moveElement: (id, dx, dy) =>
      set((state) => {
        const element = findElement(state.template, id);
        if (!element) return;
        applyElementPosition(state.template, element, snapToGrid(element.x + dx), snapToGrid(element.y + dy));
      }),

    moveElementTo: (id, x, y) =>
      set((state) => {
        const element = findElement(state.template, id);
        if (!element) return;
        applyElementPosition(state.template, element, x, y);
      }),

    nudgeElement: (id, dx, dy) =>
      set((state) => {
        const element = findElement(state.template, id);
        if (!element) return;
        applyElementPosition(state.template, element, element.x + dx, element.y + dy);
      }),

    resizeElement: (id, dx, dy) =>
      set((state) => {
        const element = findElement(state.template, id);
        if (!element) return;
        if (element.type === 'text') {
          if (element.direction === 'horizontal') {
            element.width = clamp(snapToGrid(element.width + dx), 40, CARD_WIDTH * 2);
          } else {
            element.height = clamp(snapToGrid(element.height + dy), 40, state.template.height * 2);
          }
        }
        if (element.type === 'image') {
          element.width = clamp(snapToGrid(element.width + dx), 40, CARD_WIDTH * 2);
          element.height = clamp(snapToGrid(element.height + dy), 40, state.template.height * 2);
        }
        if (element.type === 'line') {
          const delta = element.direction === 'horizontal' ? dx : dy;
          element.length = clamp(snapToGrid(element.length + delta), 24, 280);
        }
      }),

    resizeCardHeight: (dy) =>
      set((state) => {
        state.template.height = clamp(state.template.height + dy, 180, 720);
      }),

    updateElement: (id, patch) =>
      set((state) => {
        pushHistory(state);
        const element = findElement(state.template, id);
        if (element) Object.assign(element, patch);
      }),

    updateCard: (patch) =>
      set((state) => {
        pushHistory(state);
        if (patch.height !== undefined) state.template.height = clamp(patch.height, 180, 720);
        if (patch.backgroundColor !== undefined) state.template.backgroundColor = patch.backgroundColor;
        if (patch.borderRadius !== undefined) state.template.borderRadius = patch.borderRadius;
      }),

    updateFontConfig: (patch) =>
      set((state) => {
        state.fontConfig = { ...state.fontConfig, ...patch };
      }),

    undo: () =>
      set((state) => {
        const previous = state.past.pop();
        if (!previous) return;
        state.future.push(cloneTemplate(state.template));
        state.template = previous;
        if (state.selectedId && !findElement(state.template, state.selectedId)) state.selectedId = null;
      }),

    redo: () =>
      set((state) => {
        const next = state.future.pop();
        if (!next) return;
        state.past.push(cloneTemplate(state.template));
        state.template = next;
        if (state.selectedId && !findElement(state.template, state.selectedId)) state.selectedId = null;
      }),

    exportJson: () =>
      set((state) => {
        state.exportedJson = JSON.stringify(withTemplateTextCapacity(state.template), null, 2);
      }),

    importJson: (json) =>
      set((state) => {
        const parsed = JSON.parse(json) as TemplateDefinition;
        pushHistory(state);
        state.template = withTemplateTextCapacity(parsed);
        state.selectedId = parsed.elements[0]?.id ?? null;
        state.exportedJson = '';
      }),
  })),
);

export function getSelectedElement(): TemplateElement | undefined {
  const state = useEditorStore.getState();
  return state.selectedId ? findElement(state.template, state.selectedId) : undefined;
}
