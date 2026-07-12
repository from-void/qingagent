import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CardRenderer } from './index';
import type { ArticleData, TemplateDefinition } from '../../templates/types';

const article: ArticleData = {
  id: 'a1',
  title: '春江花月夜',
  description: '春江潮水连海平，海上明月共潮生。',
  imageUrl: 'https://example.com/article.jpg',
};

const template: TemplateDefinition = {
  id: 'test',
  name: '测试模板',
  version: 1,
  width: 290,
  height: 320,
  backgroundColor: '#faf6f0',
  borderRadius: '6px',
  elements: [
    {
      id: 'hero',
      type: 'image',
      source: 'dynamic',
      x: 0,
      y: 0,
      width: 290,
      height: 120,
      objectFit: 'cover',
      shape: 'trapezoid',
      clipPath: 'polygon(0 0, 100% 0, 100% 80%, 0 100%)',
      zIndex: 1,
    },
    {
      id: 'line',
      type: 'line',
      x: 24,
      y: 138,
      length: 120,
      direction: 'horizontal',
      thickness: 2,
      color: 'rgba(139, 69, 19, 0.5)',
    },
    {
      id: 'title',
      type: 'text',
      role: 'title',
      x: 24,
      y: 154,
      width: 230,
      height: 120,
      fontSize: 24,
      color: '#2c1810',
      direction: 'vertical',
      fontWeight: 'bold',
      maxLines: 3,
    },
  ],
  meta: {
    category: '测试',
    tags: ['测试'],
    requiresImage: true,
    preferVerticalText: true,
    weight: 1,
  },
};

let container: HTMLDivElement;
let root: Root;

function render(ui: ReactNode) {
  act(() => root.render(ui));
}

function byTestId(id: string) {
  const element = container.querySelector<HTMLElement>(`[data-testid="${id}"]`);
  expect(element).not.toBeNull();
  return element!;
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('CardRenderer', () => {
  it('renders dynamic images, lines and vertical text from a template', () => {
    render(<CardRenderer article={article} template={template} colorConfig={{ enabled: false }} />);

    const image = container.querySelector<HTMLImageElement>('img[alt="春江花月夜"]');
    const title = byTestId('cm-text-title');
    const line = byTestId('cm-line-line');

    expect(image?.getAttribute('src')).toBe(article.imageUrl);
    expect(image?.style.clipPath).toBe('polygon(0 0, 100% 0, 100% 80%, 0 100%)');
    expect(title.style.writingMode).toBe('vertical-rl');
    expect(line.style.width).toBe('120px');
    expect(line.style.height).toBe('2px');
  });

  it('expands the editable line hit area without changing the rendered line size', () => {
    render(
      <CardRenderer
        article={article}
        template={template}
        editorMode
        selectedElementId="line"
        colorConfig={{ enabled: false }}
      />,
    );

    const line = byTestId('cm-line-line');
    expect(line.classList.contains('cm-line-selected')).toBe(true);
    expect(line.style.width).toBe('120px');
    expect(line.style.height).toBe('2px');
    expect(line.querySelector('.cm-line-hit-area')).not.toBeNull();
  });

  it('applies ink color interaction below text and keeps text controlled by color', () => {
    render(
      <CardRenderer
        article={article}
        template={template}
        colorConfig={{
          enabled: true,
          grayscale: 0.5,
          sepia: 0.2,
          overlayColor: 'rgba(10, 20, 30, 0.3)',
          overlayOpacity: 1,
          textColor: '#123456',
          lineColor: '#234567',
        }}
      />,
    );

    expect(byTestId('cm-card').style.filter).not.toBe('grayscale(0.5) sepia(0.2)');
    expect(byTestId('cm-card-color-overlay').style.background).toBe('rgba(10, 20, 30, 0.3)');
    expect(byTestId('cm-card-color-overlay').style.zIndex).toBe('15');
    expect(byTestId('cm-text-title').style.color).toBe('rgb(18, 52, 86)');
    expect(byTestId('cm-text-title').style.zIndex).toBe('20');
    expect(byTestId('cm-line-line').style.background).toBe('rgb(35, 69, 103)');
  });

  it('truncates vertical text by max columns', () => {
    render(
      <CardRenderer
        article={{
          id: 'long-title',
          title: '春江花月夜山居秋暝静夜思兰亭序归园田居',
        }}
        template={{
          ...template,
          elements: [
            {
              id: 'vertical-title',
              type: 'text',
              role: 'title',
              x: 10,
              y: 10,
              width: 120,
              height: 40,
              fontSize: 16,
              color: '#111',
              direction: 'vertical',
              maxLines: 2,
              lineHeight: 1,
            },
          ],
        }}
        colorConfig={{ enabled: false }}
      />,
    );

    expect(container.textContent).toMatch(/…$/);
  });

  it('lays out left-aligned vertical text from left to right', () => {
    render(
      <CardRenderer
        article={{
          id: 'left-vertical',
          title: '春江花月夜山居秋暝',
        }}
        template={{
          ...template,
          elements: [
            {
              id: 'vertical-left-title',
              type: 'text',
              role: 'title',
              x: 20,
              y: 20,
              width: 120,
              height: 80,
              fontSize: 16,
              color: '#111',
              direction: 'vertical',
              maxLines: 2,
              lineHeight: 1.5,
              blockAlign: 'end',
            },
          ],
        }}
        colorConfig={{ enabled: false }}
      />,
    );

    expect(byTestId('cm-text-vertical-left-title').style.writingMode).toBe('vertical-lr');
  });
});
