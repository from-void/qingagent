import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
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

describe('CardRenderer', () => {
  it('renders dynamic images, lines and vertical text from a template', () => {
    render(<CardRenderer article={article} template={template} colorConfig={{ enabled: false }} />);

    const image = screen.getByAltText('春江花月夜');
    const title = screen.getByTestId('cm-text-title');
    const line = screen.getByTestId('cm-line-line');

    expect(image).toHaveAttribute('src', article.imageUrl);
    expect(image).toHaveStyle({ clipPath: 'polygon(0 0, 100% 0, 100% 80%, 0 100%)' });
    expect(title).toHaveStyle({ writingMode: 'vertical-rl' });
    expect(line).toHaveStyle({ width: '120px', height: '2px' });
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

    const line = screen.getByTestId('cm-line-line');
    expect(line).toHaveClass('cm-line-selected');
    expect(line).toHaveStyle({ width: '120px', height: '2px' });
    expect(line.querySelector('.cm-line-hit-area')).toBeInTheDocument();
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

    expect(screen.getByTestId('cm-card')).not.toHaveStyle({ filter: 'grayscale(0.5) sepia(0.2)' });
    expect(screen.getByTestId('cm-card-color-overlay')).toHaveStyle({
      background: 'rgba(10, 20, 30, 0.3)',
      zIndex: '15',
    });
    expect(screen.getByTestId('cm-text-title')).toHaveStyle({ color: '#123456', zIndex: '20' });
    expect(screen.getByTestId('cm-line-line')).toHaveStyle({ background: '#234567' });
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

    expect(screen.getByText(/…$/)).toBeInTheDocument();
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

    expect(screen.getByTestId('cm-text-vertical-left-title')).toHaveStyle({ writingMode: 'vertical-lr' });
  });
});
